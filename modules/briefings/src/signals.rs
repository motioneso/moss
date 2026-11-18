//! Calendar and email signals for the morning briefing. A signal is a short, rule-derived hint
//! the writer may use. Rules are plain keyword and timing checks over the gathered items.
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;

/// How many signals of each kind reach the writer.
pub const SIGNAL_LIMIT: usize = 5;

#[derive(Debug, Clone, Copy)]
pub struct CalendarSettings {
    pub lookahead_days: i64,
    pub prep_task_mode: &'static str,
    pub time_block_mode: &'static str,
}

impl Default for CalendarSettings {
    fn default() -> Self {
        Self { lookahead_days: 2, prep_task_mode: "suggest", time_block_mode: "suggest" }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EmailSettings {
    pub create_tasks: bool,
    pub suggest_replies: bool,
    pub draft_replies: bool,
    pub auto_send: bool,
}

impl Default for EmailSettings {
    fn default() -> Self {
        Self { create_tasks: true, suggest_replies: true, draft_replies: true, auto_send: false }
    }
}

fn re(p: &str) -> Regex {
    Regex::new(p).expect("fixed pattern")
}

fn text(value: &Value) -> String {
    value.as_str().map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

fn blob(values: &[&Value]) -> String {
    values.iter().map(|v| text(v).to_lowercase()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

fn instant(value: &Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok()).map(|t| t.with_timezone(&Utc))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn minutes_between(start: Option<DateTime<Utc>>, end: Option<DateTime<Utc>>) -> i64 {
    match (start, end) {
        (Some(s), Some(e)) => ((e - s).num_milliseconds() / 60000).max(0),
        _ => 0,
    }
}

fn local_day(at: DateTime<Utc>, zone: Tz) -> NaiveDate {
    at.with_timezone(&zone).date_naive()
}

/// Words of five or more letters from the lines already gathered. They mark what the day is about.
pub fn context_tokens(groups: &[&[String]]) -> HashSet<String> {
    groups
        .iter()
        .flat_map(|g| g.iter())
        .flat_map(|line| line.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).map(str::to_owned).collect::<Vec<_>>())
        .filter(|t| t.chars().count() >= 5)
        .collect()
}

fn overlaps(text: &str, tokens: &HashSet<String>) -> bool {
    tokens.iter().any(|t| text.contains(t.as_str()))
}

fn unique(values: Vec<&str>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for v in values.into_iter().filter(|v| !v.is_empty()) {
        if !out.iter().any(|o| o == v) {
            out.push(v.to_owned());
        }
    }
    out
}

struct Scored {
    score: i64,
    kind: &'static str,
    summary: String,
    signal: Value,
}

fn by_rank(a: &Scored, b: &Scored) -> std::cmp::Ordering {
    b.score.cmp(&a.score).then_with(|| a.summary.cmp(&b.summary))
}

fn top(mut scored: Vec<Scored>, limit: usize) -> Vec<Value> {
    scored.sort_by(by_rank);
    scored.into_iter().take(limit).map(|s| s.signal).collect()
}

/// The best signal of each kind first, then the rest by rank, so one kind cannot crowd out the others.
fn top_with_type_reserve(scored: Vec<Scored>, limit: usize) -> Vec<Value> {
    let mut best: Vec<usize> = vec![];
    for (i, s) in scored.iter().enumerate() {
        match best.iter().position(|&b| scored[b].kind == s.kind) {
            Some(slot) => {
                if by_rank(s, &scored[best[slot]]).is_lt() {
                    best[slot] = i;
                }
            }
            None => best.push(i),
        }
    }
    best.sort_by(|&a, &b| by_rank(&scored[a], &scored[b]));
    best.truncate(limit);
    let mut rest: Vec<usize> = (0..scored.len()).filter(|i| !best.contains(i)).collect();
    rest.sort_by(|&a, &b| by_rank(&scored[a], &scored[b]));
    best.into_iter().chain(rest).take(limit).map(|i| scored[i].signal.clone()).collect()
}

fn calendar_actions(kind: &str, s: &CalendarSettings) -> Vec<&'static str> {
    let mut out = vec![];
    if matches!(kind, "prep_needed" | "high_stakes_meeting") && s.prep_task_mode == "suggest" {
        out.push("suggest_task");
    }
    if kind == "prep_needed" && s.prep_task_mode == "auto" {
        out.push("create_task");
    }
    if matches!(kind, "travel_transition_pressure" | "usable_open_gap" | "schedule_density_overload")
        && s.time_block_mode == "suggest"
    {
        out.push("suggest_time_block");
    }
    if matches!(kind, "prep_needed" | "travel_transition_pressure") && s.time_block_mode == "auto" {
        out.push("block_time");
    }
    out
}

struct Event<'a> {
    item: &'a Value,
    starts: Option<DateTime<Utc>>,
    ends: Option<DateTime<Utc>>,
    diff: Option<i64>,
    text: String,
}

fn event_id(item: &Value) -> String {
    [&item["id"], &item["externalId"], &item["title"]].iter().map(|v| text(v)).find(|s| !s.is_empty()).unwrap_or_default()
}

pub fn derive_calendar_signals(
    items: &[Value],
    now: DateTime<Utc>,
    zone: Tz,
    context: &HashSet<String>,
    settings: &CalendarSettings,
) -> Vec<Value> {
    let (high, prep) = (
        re(r"(client|demo|review|interview|presentation|board|handoff|decision|launch|doctor|onsite|travel|1:1)"),
        re(r"(prep|review|presentation|interview|deck|decision|handoff|travel|doctor|deadline|demo)"),
    );
    let today_day = local_day(now, zone);
    let events: Vec<Event> = items
        .iter()
        .map(|item| {
            let (starts, ends) = (instant(&item["startsAt"]), instant(&item["endsAt"]));
            Event {
                item,
                starts,
                ends,
                diff: starts.map(|s| (local_day(s, zone) - today_day).num_days()),
                text: blob(&[&item["title"], &item["summary"], &item["bodyExcerpt"], &item["location"]]),
            }
        })
        .filter(|e| e.diff.is_some_and(|d| d >= 0 && d <= settings.lookahead_days))
        .collect();
    let mut scored: Vec<Scored> = vec![];
    let day_of = |at: Option<DateTime<Utc>>| local_day(at.unwrap_or(now), zone).to_string();
    for e in &events {
        let diff = e.diff.unwrap_or(0);
        let id = event_id(e.item);
        let title = Some(text(&e.item["title"])).filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled event".into());
        let overlap = overlaps(&e.text, context);
        let attendees = e.item["attendeeCount"].as_f64().unwrap_or(0.0);
        let duration = minutes_between(e.starts, e.ends);
        let high_stakes = high.is_match(&e.text) || attendees >= 5.0 || overlap;
        let prep_needed = prep.is_match(&e.text) || (diff != 0 && high_stakes) || (diff == 0 && high_stakes && duration >= 45);
        let mut push = |score: i64, kind: &'static str, summary: String, reasons: Vec<String>, ids: Vec<String>, starts, ends, day: String| {
            let mut signal = json!({
                "type": kind, "summary": summary, "eventIds": ids, "day": day,
                "relevanceReasons": reasons, "suggestedActions": calendar_actions(kind, settings),
            });
            if let Some(s) = starts {
                signal["startsAt"] = json!(iso(s));
            }
            if let Some(s) = ends {
                signal["endsAt"] = json!(iso(s));
            }
            scored.push(Scored { score, kind, summary, signal });
        };
        if prep_needed {
            let lands = format!("changes what today needs before {title}");
            let reasons = unique(vec![
                if high_stakes { "important meeting" } else { "" },
                if overlap { "matches active work context" } else { "" },
                if diff == 0 { "lands today" } else { &lands },
            ]);
            let summary = if diff == 0 {
                format!("{title} likely needs prep before it starts.")
            } else {
                format!("{title} is coming up soon and likely needs prep today.")
            };
            push(90 - diff * 10, "prep_needed", summary, reasons, vec![id.clone()], e.starts, e.ends, day_of(e.starts));
        }
        if diff == 0 && high_stakes {
            let reasons = unique(vec![
                if attendees >= 5.0 { "large meeting" } else { "" },
                if overlap { "reinforced by tasks, notes, or chats" } else { "" },
                "high-stakes topic",
            ]);
            push(80, "high_stakes_meeting", format!("{title} is the meeting most likely to shape the day."), reasons, vec![id.clone()], e.starts, e.ends, day_of(e.starts));
        }
    }
    let mut today: Vec<&Event> = events.iter().filter(|e| e.diff == Some(0) && e.starts.is_some()).collect();
    today.sort_by_key(|e| e.starts);
    let (mut total, mut tight) = (0, 0);
    for (i, cur) in today.iter().enumerate() {
        total += minutes_between(cur.starts, cur.ends);
        let Some(next) = today.get(i + 1) else { continue };
        let (Some(cur_end), Some(next_start)) = (cur.ends, next.starts) else { continue };
        let gap = minutes_between(Some(cur_end), Some(next_start));
        let (a, b) = (text(&cur.item["location"]), text(&next.item["location"]));
        let shift = !a.is_empty() && !b.is_empty() && a.to_lowercase() != b.to_lowercase();
        if gap <= 15 || shift {
            tight += 1;
            let summary = format!("The gap between {} and {} looks tight.", text(&cur.item["title"]), text(&next.item["title"]));
            let reasons = unique(vec![if gap <= 15 { "back-to-back timing" } else { "" }, if shift { "location change" } else { "" }]);
            let ids = unique(vec![&text(&cur.item["id"]), &text(&next.item["id"])]);
            let mut signal = json!({
                "type": "travel_transition_pressure", "summary": summary, "eventIds": ids,
                "day": day_of(cur.starts), "relevanceReasons": reasons,
                "suggestedActions": calendar_actions("travel_transition_pressure", settings),
            });
            signal["startsAt"] = json!(cur.starts.map(iso));
            signal["endsAt"] = json!(next.ends.map(iso));
            scored.push(Scored { score: 70 - i as i64, kind: "travel_transition_pressure", summary, signal });
        }
    }
    if today.len() >= 4 || total >= 300 || tight >= 2 {
        let ids = unique(today.iter().map(|e| text(&e.item["id"])).collect::<Vec<_>>().iter().map(String::as_str).collect());
        let reasons = unique(vec![
            if today.len() >= 4 { "many meetings today" } else { "" },
            if total >= 300 { "most of the day is already spoken for" } else { "" },
            if tight >= 2 { "multiple tight transitions" } else { "" },
        ]);
        let summary = "Today looks meeting-dense enough to squeeze prep or recovery time.".to_owned();
        let signal = json!({
            "type": "schedule_density_overload", "summary": summary, "eventIds": ids,
            "day": local_day(now, zone).to_string(), "relevanceReasons": reasons,
            "suggestedActions": calendar_actions("schedule_density_overload", settings),
        });
        scored.push(Scored { score: 75, kind: "schedule_density_overload", summary, signal });
    }
    for i in 0..today.len().saturating_sub(1) {
        let (cur, next) = (today[i], today[i + 1]);
        let (Some(end), Some(start)) = (cur.ends, next.starts) else { continue };
        let gap = minutes_between(Some(end), Some(start));
        if gap < 60 {
            continue;
        }
        let summary = format!("There is a usable {gap}-minute gap after {}.", text(&cur.item["title"]));
        let signal = json!({
            "type": "usable_open_gap", "summary": summary, "eventIds": [text(&cur.item["id"])],
            "day": day_of(cur.starts), "startsAt": iso(end), "endsAt": iso(start),
            "relevanceReasons": ["enough open time for real work"],
            "suggestedActions": calendar_actions("usable_open_gap", settings),
        });
        scored.push(Scored { score: gap.min(120), kind: "usable_open_gap", summary, signal });
        break;
    }
    top(scored, SIGNAL_LIMIT)
}

fn email_actions(s: &EmailSettings) -> Vec<&'static str> {
    [(s.create_tasks, "create_task"), (s.suggest_replies, "suggest_reply"), (s.draft_replies, "draft_reply"), (s.auto_send, "auto_send")]
        .into_iter()
        .filter(|(on, _)| *on)
        .map(|(_, name)| name)
        .collect()
}

pub fn derive_email_signals(
    items: &[Value],
    now: DateTime<Utc>,
    zone: Tz,
    context: &HashSet<String>,
    settings: &EmailSettings,
) -> Vec<Value> {
    let (time_words, reply_words, plan_words) = (
        re(r"(urgent|today|deadline|asap|eod|before|expires|due)"),
        re(r"\?|reply|respond|let me know|can you|please review|follow up"),
        re(r"(meeting|review|deck|draft|document|contract|prep|schedule|agenda)"),
    );
    let mut scored: Vec<Scored> = vec![];
    for item in items {
        let sender = Some(text(&item["sender"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "Unknown sender".into());
        let subject = Some(text(&item["subject"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "Untitled thread".into());
        let signals = if item["signals"].is_null() { "{}".to_owned() } else { item["signals"].to_string() };
        let body = blob(&[&item["sender"], &item["subject"], &item["snippet"], &item["summary"], &json!(signals)]);
        let overlap = overlaps(&body, context);
        let received = instant(&item["receivedAt"]);
        let age = received.map_or(0, |r| (now - r).num_days().max(0));
        let account = Some(text(&item["connectorAccountId"])).filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
        let message_id = [&item["id"], &item["externalId"]].iter().map(|v| text(v)).find(|s| !s.is_empty()).unwrap_or_else(|| subject.clone());
        let dated = |line: String| match received {
            Some(r) => format!("Email received {}: {line}", r.with_timezone(&zone).format("%Y-%m-%d %H:%M")),
            None => line,
        };
        let mut push = |kind: &'static str, score: i64, summary: String, reasons: Vec<&str>| {
            let mut signal = json!({
                "type": kind, "summary": summary, "messageIds": [message_id],
                "connectorAccountId": account,
                "relevanceReasons": unique(reasons), "suggestedActions": email_actions(settings),
            });
            if let Some(t) = item["threadId"].as_str().filter(|t| !t.trim().is_empty()) {
                signal["threadId"] = json!(t.trim());
            }
            if let Some(l) = item["connectorLabel"].as_str().filter(|t| !t.trim().is_empty()) {
                signal["connectorLabel"] = json!(l.trim());
            }
            if let Some(r) = received {
                signal["receivedAt"] = json!(iso(r));
            }
            scored.push(Scored { score, kind, summary, signal });
        };
        if time_words.is_match(&body) {
            push("time_sensitive", 90, dated(format!("{subject} contains deadline language.")), vec!["deadline language", if overlap { "connected to the current day" } else { "" }]);
        }
        if item["actionability"] == "needs_reply" || reply_words.is_match(&body) {
            push("needs_reply", 85 - age.min(5), dated(format!("{sender} asks for a reply on {subject}.")), vec!["reply-shaped language", if overlap { "matches current work context" } else { "" }]);
        }
        if plan_words.is_match(&body) || overlap {
            push("planning_impact", 70, dated(format!("{subject} mentions planning information.")), vec!["day-planning impact", if overlap { "reinforced by tasks, notes, chats, or calendar" } else { "" }]);
        }
    }
    top_with_type_reserve(scored, SIGNAL_LIMIT)
}

