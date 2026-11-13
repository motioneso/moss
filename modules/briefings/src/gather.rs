//! Gathering for a briefing run. Each source is read through the owning module's public API,
//! never its tables. A source that cannot be read, or whose module is not built yet, becomes a
//! visible gap and never fails the run. Only the run owner's data is read, because the host
//! carries the owner's identity into every call.
use crate::compose::Subject;
use crate::external::{self, Contribution, Contributors};
use crate::gather_types::*;
use crate::priority::{self, Candidate};
use crate::runs;
use crate::trust::sanitize_external;
use crate::util::{call, owner_zone};
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};

/// Tasks read.
pub const TASKS: &str = "tasks.list";
pub const CALENDAR: &str = "calendar.listVisibleEvents";
pub const EMAIL: &str = "email.listVisibleMessages";
pub const COMMITMENTS: &str = "commitments.listVisible";
pub const CHATS: &str = "chat.listTodaysTurns";
const DAY: i64 = 24 * 60;
const CALENDAR_LIMIT: i64 = 50;
const EMAIL_LIMIT: i64 = 30;
const AUTH_REASONS: [&str; 3] = ["auth_error", "connector_revoked", "feature_grant_disabled"];

pub struct Gathered {
    pub sections: Vec<Section>,
    pub gaps: Vec<Gap>,
    /// Accounts and gaps the live reads reported, with ids and reasons only.
    pub source_context: Value,
    /// True when any account's answer came from saved data instead of a live read.
    pub degraded: bool,
    pub contributions: Vec<Contribution>,
    pub candidates: Vec<Candidate>,
}

impl Gathered {
    /// What may be stored with the run. It holds keys, counts and reasons, never any text a
    /// source returned.
    pub fn metadata(&self) -> Value {
        json!({
            "gaps": self.gaps.iter().map(Gap::to_json).collect::<Vec<_>>(),
            "sections": self.sections.iter().map(|s| json!({"key": s.key, "count": s.count})).collect::<Vec<_>>(),
            "sourceContext": self.source_context,
            "degraded": self.degraded,
            "contributions": self.contributions.iter().map(|c| json!({"moduleId": c.module_id, "items": c.items.len()})).collect::<Vec<_>>(),
        })
    }
}

fn api<H: Host + ?Sized>(host: &H, module: &str, name: &str, parameters: Value) -> Result<Value> {
    host.call("api", "call", module, json!({"name": name, "parameters": parameters}))
}

fn selected(subject: &Subject<'_>, name: &str) -> bool {
    subject.selected_tools.iter().any(|n| n == name)
}

fn instant(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

/// A time as the owner's wall clock, or the date text itself when it is not a full time.
fn stamp(value: &Value, zone: chrono_tz::Tz) -> String {
    match value.as_str() {
        Some(text) => match instant(text) {
            Some(at) => at.with_timezone(&zone).format("%Y-%m-%d %H:%M").to_string(),
            None => text.to_owned(),
        },
        None => String::new(),
    }
}

fn join(parts: Vec<String>) -> String {
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ")
}

fn items(reply: &Value) -> Vec<Value> {
    reply["items"].as_array().into_iter().flatten().filter(|v| v.is_object()).cloned().collect()
}

/// When the last succeeded briefing of this kind ran. A first run looks back one day.
fn previous_run<H: Host + ?Sized>(host: &H, subject: &Subject<'_>, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let mut query = Query::select(Filter::And {
        filters: vec![
            Filter::eq("definition_id", subject.definition_id),
            Filter::eq("status", "succeeded"),
            Filter::eq("briefing_type", subject.briefing_type),
        ],
    });
    query.order = vec![Order { column: "created_at".into(), descending: true }];
    query.limit = Some(1);
    let rows = Client(host).query(runs::TABLE, &query)?;
    Ok(rows
        .first()
        .and_then(|r| r["created_at"].as_str())
        .and_then(instant)
        .unwrap_or(now - Duration::minutes(DAY)))
}

fn tasks<H: Host + ?Sized>(host: &H, since: DateTime<Utc>, gaps: &mut Vec<Gap>) -> Section {
    let read = |status: &str, extra: Value| {
        let mut parameters = Map::from_iter([("status".to_owned(), json!(status))]);
        if let Some(extra) = extra.as_object() {
            parameters.extend(extra.clone());
        }
        api(host, "tasks", "listBriefingTasks", Value::Object(parameters)).map(|r| items(&r))
    };
    let since = since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (Ok(open), Ok(done)) = (read("todo", json!({})), read("done", json!({"completedAfter": since}))) else {
        gaps.push(Gap { source: "tasks", reason: Reason::ToolFailed });
        return Section::empty("tasks", "TASKS");
    };
    let open: Vec<Value> = open.into_iter().filter(|t| t["status"] == "todo").collect();
    let done: Vec<Value> = done.into_iter().filter(|t| t["status"] == "done").collect();
    let open_lines: Vec<String> =
        open.iter().map(|t| join(vec![sanitize_external(&t["title"]), sanitize_external(&t["status"])])).collect();
    let done_lines: Vec<String> = done
        .iter()
        .map(|t| format!("{COMPLETED_MARK} {}", sanitize_external(&t["title"])))
        .collect();
    let overflow = done_lines.len() > COMPLETED_TASK_CAP;
    let lines: Vec<String> =
        open_lines.into_iter().chain(done_lines.into_iter().take(COMPLETED_TASK_CAP)).collect();
    let (lines, cut) = cap_lines_to(lines, usize::MAX);
    if lines.is_empty() {
        gaps.push(Gap { source: "tasks", reason: Reason::Empty });
    } else if cut || overflow {
        gaps.push(Gap { source: "tasks", reason: Reason::Truncated });
    }
    let count = open.len() + done.len();
    Section { key: "tasks", label: "TASKS", lines, count, raw: open.into_iter().chain(done).collect() }
}

/// The accounts and gaps of one live read, reduced to ids and reasons.
fn context_of(reply: &Value) -> Value {
    let id = |account: &Value| account["connectorAccountId"].as_str().map(str::to_owned);
    let accounts: Vec<Value> = reply["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            json!({
                "connectorAccountId": id(&a["account"]).unwrap_or_else(|| "unknown".into()),
                "source": if a["source"] == "live" { "live" } else { "cache" },
                "degradedReason": a["degradedReason"].as_str(),
            })
        })
        .collect();
    let gaps: Vec<Value> = reply["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| json!({"connectorAccountId": id(&g["account"]), "reason": g["reason"].as_str().unwrap_or("unknown")}))
        .collect();
    json!({"accounts": accounts, "gaps": gaps})
}

/// Reads one live source-context API and records its account gaps. `None` means the read failed.
fn live<H: Host + ?Sized>(
    host: &H,
    name: &str,
    input: Value,
    source: &'static str,
    gaps: &mut Vec<Gap>,
) -> Option<(Vec<Value>, Value, bool, bool)> {
    let Ok(reply) = api(host, "connectors", name, input) else {
        gaps.push(Gap { source, reason: Reason::ToolFailed });
        return None;
    };
    let context = context_of(&reply);
    if context["gaps"].as_array().into_iter().flatten().any(|g| g["reason"].as_str().is_some_and(|r| AUTH_REASONS.contains(&r))) {
        gaps.push(Gap { source, reason: Reason::SourceAuth });
    }
    let degraded = context["accounts"].as_array().into_iter().flatten().any(|a| a["source"] == "cache");
    let more = reply["truncated"] == true;
    Some((items(&reply), context, degraded, more))
}

fn calendar<H: Host + ?Sized>(host: &H, now: DateTime<Utc>, zone: chrono_tz::Tz, out: &mut Gathered) -> Section {
    let input = json!({"windowStart": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "limit": CALENDAR_LIMIT});
    let Some((events, context, degraded, more)) = live(host, "listCalendarContext", input, "calendar", &mut out.gaps) else {
        return Section::empty("calendar", "CALENDAR");
    };
    out.source_context["calendar"] = context;
    out.degraded |= degraded;
    if events.is_empty() {
        out.gaps.push(Gap { source: "calendar", reason: Reason::Empty });
        return Section::empty("calendar", "CALENDAR");
    }
    let lines: Vec<String> =
        events.iter().map(|e| join(vec![sanitize_external(&json!(stamp(&e["startsAt"], zone))), sanitize_external(&e["title"])])).collect();
    let (lines, cut) = cap_lines(lines.into_iter().filter(|l| !l.is_empty()).collect());
    if cut || more {
        out.gaps.push(Gap { source: "calendar", reason: Reason::Truncated });
    }
    Section { key: "calendar", label: "CALENDAR", lines, count: events.len(), raw: events }
}

const ACTION: [&str; 3] = ["needs_reply", "needs_action", "time_sensitive_info"];
const REQUESTS: [&str; 12] = [
    "please reply", "please confirm", "please review", "please pay", "action required", "action needed",
    "amount due", "balance due", "payment due", "you must", "you need to", "unpaid",
];
const CONFIRMATIONS: [&str; 14] = [
    "order confirmed", "order confirmation", "has been shipped", "has shipped", "was delivered",
    "shipping confirmation", "delivery confirmation", "booking confirmed", "reservation confirmed",
    "payment received", "payment confirmed", "purchase receipt", "payment receipt", "subscription renewed",
];

/// Mail that only confirms something already done. A request for action always wins.
pub fn is_no_action_confirmation(item: &Value) -> bool {
    if item["actionability"].as_str().is_some_and(|a| ACTION.contains(&a)) {
        return false;
    }
    let text = ["subject", "snippet", "summary"]
        .iter()
        .filter_map(|k| item[*k].as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if REQUESTS.iter().any(|r| text.contains(r)) {
        return false;
    }
    CONFIRMATIONS.iter().any(|c| text.contains(c))
}

fn actionable(item: &Value) -> bool {
    match item["actionability"].as_str() {
        Some(a) if ACTION.contains(&a) => true,
        Some("waiting_on_someone") => {
            item["importance"] == "high" || item["confidence"].as_f64().is_some_and(|c| c >= 0.7)
        }
        _ => false,
    }
}

/// Mail the briefing keeps. It drops answered mail and plain confirmations.
pub fn is_briefing_email(item: &Value) -> bool {
    item["answered"] != true && !is_no_action_confirmation(item) && (actionable(item) || item["awaitingJudgement"] == true)
}

fn email<H: Host + ?Sized>(host: &H, out: &mut Gathered) -> Section {
    let Some((messages, context, degraded, more)) =
        live(host, "listEmailContext", json!({"limit": EMAIL_LIMIT}), "email", &mut out.gaps)
    else {
        return Section::empty("email", "EMAIL SUMMARIES + SIGNALS");
    };
    out.source_context["email"] = context;
    out.degraded |= degraded;
    if messages.is_empty() {
        out.gaps.push(Gap { source: "email", reason: Reason::Empty });
        return Section::empty("email", "EMAIL SUMMARIES + SIGNALS");
    }
    // Only these fields cross into the prompt. A body or any other field never does.
    let lines: Vec<String> = messages
        .iter()
        .filter(|m| is_briefing_email(m))
        .map(|m| {
            let summary = sanitize_external(&m["summary"]);
            join(vec![
                sanitize_external(&m["sender"]),
                sanitize_external(&m["subject"]),
                sanitize_external(&m["actionability"]),
                if summary.is_empty() { sanitize_external(&m["snippet"]) } else { summary },
            ])
        })
        .filter(|l| !l.is_empty())
        .collect();
    let (lines, cut) = cap_lines(lines);
    if cut || more {
        out.gaps.push(Gap { source: "email", reason: Reason::Truncated });
    }
    Section { key: "email", label: "EMAIL SUMMARIES + SIGNALS", lines, count: messages.len(), raw: messages }
}

pub fn gather<H: Host + ?Sized, C: Contributors + ?Sized>(
    host: &H,
    subject: &Subject<'_>,
    contributors: &C,
) -> Result<Gathered> {
    let clock = call(host)?;
    let now = instant(&clock.now).ok_or_else(|| Error::new("Invalid host clock"))?;
    let zone: chrono_tz::Tz = owner_zone(host, &clock.now).and_then(|z| z.parse().ok()).unwrap_or(chrono_tz::UTC);
    let mut out = Gathered {
        sections: vec![],
        gaps: vec![],
        source_context: json!({}),
        degraded: false,
        contributions: vec![],
        candidates: vec![],
    };
    if selected(subject, TASKS) {
        let since = previous_run(host, subject, now)?;
        let section = tasks(host, since, &mut out.gaps);
        out.sections.push(section);
        subject.deadline.check(host)?;
    }
    if selected(subject, CALENDAR) {
        let section = calendar(host, now, zone, &mut out);
        out.sections.push(section);
        subject.deadline.check(host)?;
    }
    if selected(subject, EMAIL) {
        let section = email(host, &mut out);
        out.sections.push(section);
        // Commitment suggestions ride on the mail selection. Commitments is not built yet.
        out.gaps.push(Gap { source: "commitment_suggestions", reason: Reason::Unwired });
        subject.deadline.check(host)?;
    }
    if selected(subject, COMMITMENTS) {
        out.gaps.push(Gap { source: "commitments", reason: Reason::Unwired });
    }
    // The day's chats come from the Chat service, which has no public API for modules yet.
    if selected(subject, CHATS) {
        out.gaps.push(Gap { source: "chats", reason: Reason::Unwired });
    }
    out.candidates = priority::candidates(&out.sections);
    if !out.sections.is_empty() {
        // The saved priority model lives in Priority, which is not built yet.
        out.gaps.push(Gap { source: "priority", reason: Reason::Unwired });
    }
    let part = if subject.briefing_type == "evening" { "evening" } else { "morning" };
    out.contributions = external::collect(contributors, subject.selected_tools, part);
    subject.deadline.check(host)?;
    Ok(out)
}
