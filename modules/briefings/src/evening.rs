//! The evening composition. It reads the day's tasks, tomorrow's calendar, today's mail and the
//! saved day plan, sorts the tasks into three lenses, and asks the router for the text. Outside
//! text enters the prompt only as sanitized lines in delimited blocks. When the router cannot
//! answer, the run keeps a plain digest with the same six headers and says why.
use crate::action_rows::{self, empty_payload};
use crate::compose::{Composed, Subject};
use crate::email_evidence;
use crate::evening_prompt::{build_prompt, FALLBACK_QUESTIONS, HEADERS};
use crate::external::NoContributors;
use crate::gather::{self, email_lines, gather, instant, Gathered};
use crate::gather_types::{cap_lines, cap_lines_to, Gap, Reason, Section};
use crate::lenses::{filter_calendar, local_day, partition, EveningTask};
use crate::morning::{calendar_loaded, failure_reason, rank_evidence, read_action_rows};
use crate::runs;
use crate::signals::{self, EmailSettings};
use crate::trust::sanitize_external;
use crate::{plan_context, plan_prose};
use chrono::{DateTime, Utc};
use moss_module_sdk::query::{Filter, Order, Query};
use moss_module_sdk::{Client, Host, Result};
use serde_json::{json, Value};

/// Most output tokens the evening text may use.
pub const EVENING_MAX_OUTPUT_TOKENS: u32 = 2000;
const LENS_ITEM_CAP: usize = 5;
const TOMORROW_CAP: usize = 8;
const PLAN_SIGNAL_CAP: usize = 6;
const NO_TASK_LINES: &str = "(none today)";

pub struct EveningComposer;

fn find<'a>(sections: &'a [Section], key: &str) -> Option<&'a Section> {
    sections.iter().find(|s| s.key == key)
}

fn tagged(tag: &str, tasks: &[EveningTask]) -> Vec<String> {
    tasks.iter().map(|t| format!("[{tag}] {}", sanitize_external(&Value::from(t.title.clone())))).collect()
}

/// Tasks sorted into the three lenses, as lines tagged with their lens.
fn reconciliation(tasks: &Section, now: DateTime<Utc>, zone: chrono_tz::Tz, gaps: &mut Vec<Gap>, counts: &mut [usize; 3]) -> Section {
    let open: Vec<Value> = tasks.raw.iter().filter(|t| t["status"] == "todo").cloned().collect();
    let done: Vec<Value> = tasks.raw.iter().filter(|t| t["status"] == "done").cloned().collect();
    let lenses = partition(&done, &open, now, zone);
    *counts = [lenses.completed_today.len(), lenses.slipped.len(), lenses.carrying_forward.len()];
    let mut lines = vec![];
    let mut cut = false;
    for (tag, group) in [("completed today", &lenses.completed_today), ("slipped", &lenses.slipped), ("carrying forward", &lenses.carrying_forward)] {
        cut |= group.len() > LENS_ITEM_CAP;
        lines.extend(tagged(tag, &group[..group.len().min(LENS_ITEM_CAP)]));
    }
    let (lines, over) = cap_lines_to(lines, usize::MAX);
    // The tasks read already reported its own gaps. The lenses report what they kept.
    gaps.retain(|g| g.source != "tasks");
    if lines.is_empty() {
        gaps.push(Gap { source: "tasks_reconciliation", reason: Reason::Empty });
    } else if cut || over {
        gaps.push(Gap { source: "tasks_reconciliation", reason: Reason::Truncated });
    }
    let count = counts.iter().sum();
    Section { key: "tasks_reconciliation", label: "TASKS - DAY RECONCILIATION", lines, count, raw: vec![] }
}

fn calendar_lines(events: &[Value], zone: chrono_tz::Tz) -> Vec<String> {
    let mut sorted: Vec<&Value> = events.iter().collect();
    sorted.sort_by_key(|e| instant(e["startsAt"].as_str().unwrap_or_default()));
    sorted
        .into_iter()
        .map(|e| gather::join(vec![sanitize_external(&json!(gather::stamp(&e["startsAt"], zone))), sanitize_external(&e["title"])]))
        .filter(|l| !l.is_empty())
        .collect()
}

/// The earlier morning briefing of the same local day, if one succeeded. Only ids and counts of
/// its stored signals are read back, and each summary is cleaned again before it is shown.
fn morning_plan<H: Host + ?Sized>(host: &H, now: DateTime<Utc>, zone: chrono_tz::Tz) -> Option<Vec<String>> {
    let mut query = Query::select(Filter::And {
        filters: vec![Filter::eq("briefing_type", "morning"), Filter::eq("status", "succeeded")],
    });
    query.order = vec![Order { column: "created_at".into(), descending: true }];
    query.limit = Some(1);
    let rows = Client(host).query(runs::TABLE, &query).ok()?;
    let row = rows.first()?;
    let today = now.with_timezone(&zone).date_naive();
    if local_day(&row["created_at"], zone) != Some(today) {
        return None;
    }
    let metadata = &row["source_metadata"];
    let lines: Vec<String> = ["calendarSignals", "emailSignals"]
        .iter()
        .flat_map(|k| metadata[*k].as_array().into_iter().flatten())
        .map(|s| sanitize_external(&s["summary"]))
        .filter(|l| !l.is_empty())
        .take(PLAN_SIGNAL_CAP)
        .collect();
    Some(lines)
}

fn plain_digest(sections: &[Section]) -> String {
    let body = |key: &str, empty: &str| match find(sections, key) {
        Some(s) if !s.lines.is_empty() => s.lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n"),
        _ => empty.to_owned(),
    };
    let mut done = vec![];
    let mut slipped = vec![];
    let mut carry = vec![];
    for line in find(sections, "tasks_reconciliation").map(|s| s.lines.as_slice()).unwrap_or_default() {
        if let Some(rest) = line.strip_prefix("[completed today] ") {
            done.push(format!("- {rest}"));
        } else if let Some(rest) = line.strip_prefix("[slipped] ") {
            slipped.push(format!("- {rest}"));
        } else if let Some(rest) = line.strip_prefix("[carrying forward] ") {
            carry.push(format!("- {rest}"));
        }
    }
    let or = |v: Vec<String>, empty: &str| if v.is_empty() { empty.to_owned() } else { v.join("\n") };
    let blocks = [
        or(done, NO_TASK_LINES),
        or(slipped, "(none)"),
        or(carry, NO_TASK_LINES),
        body("email_today", "(none today)"),
        body("calendar_tomorrow", "(tomorrow looks clear)"),
        "(quiet day)".to_owned(),
    ];
    let mut parts = vec!["Evening wrap-up (sources listed without narrative - AI synthesis unavailable).".to_owned()];
    parts.extend(HEADERS.iter().zip(blocks).map(|(h, b)| format!("{h}\n{b}")));
    parts.extend(FALLBACK_QUESTIONS.iter().map(|q| (*q).to_owned()));
    parts.join("\n\n")
}

impl EveningComposer {
    pub fn compose<H: Host + ?Sized>(&self, host: &H, subject: &Subject<'_>) -> Result<Composed> {
        let mut gathered: Gathered = gather(host, subject, &NoContributors)?;
        let mut gaps: Vec<Gap> = std::mem::take(&mut gathered.gaps);
        let (now, zone) = (gathered.now, gathered.zone);
        let rows = read_action_rows(host, subject, &mut gaps);
        subject.deadline.check(host)?;

        let tasks = find(&gathered.sections, "tasks").cloned().unwrap_or_else(|| Section::empty("tasks", "TASKS"));
        let mut counts = [0usize; 3];
        let recon = reconciliation(&tasks, now, zone, &mut gaps, &mut counts);

        let calendar = find(&gathered.sections, "calendar").cloned();
        let tomorrow_events = filter_calendar(&calendar.as_ref().map(|c| c.raw.clone()).unwrap_or_default(), now, zone);
        let tomorrow_lines = calendar_lines(&tomorrow_events, zone);
        let tomorrow_total = tomorrow_lines.len();
        let (tomorrow_lines, tomorrow_cut) = cap_lines_to(tomorrow_lines, TOMORROW_CAP);
        if calendar.is_some() {
            gaps.retain(|g| !(g.source == "calendar" && matches!(g.reason, Reason::Truncated | Reason::Empty)));
            if tomorrow_cut {
                gaps.push(Gap { source: "calendar", reason: Reason::Truncated });
            } else if tomorrow_total == 0 {
                gaps.push(Gap { source: "calendar", reason: Reason::Empty });
            }
        }
        let tomorrow = Section { key: "calendar_tomorrow", label: "TOMORROW'S CALENDAR", lines: tomorrow_lines, count: tomorrow_total, raw: vec![] };

        let email_raw = find(&gathered.sections, "email").map(|s| s.raw.clone()).unwrap_or_default();
        let assessment = email_evidence::assess(&email_raw, now, zone);
        let today = now.with_timezone(&zone).date_naive();
        let mail: Vec<Value> = assessment
            .eligible
            .iter()
            .filter(|m| local_day(&m["receivedAt"], zone) == Some(today))
            .filter(|m| gather::is_briefing_email(m))
            .filter(|m| !action_rows::email_source_ref(m).is_some_and(|r| rows.source_refs.contains(&r)))
            .cloned()
            .collect();
        let (mail_lines, _) = cap_lines(email_lines(&mail));
        if find(&gathered.sections, "email").is_some() {
            gaps.retain(|g| !(g.source == "email" && g.reason == Reason::Empty));
            if mail_lines.is_empty() && !email_raw.is_empty() {
                gaps.push(Gap { source: "email_today", reason: Reason::FilteredOut });
            } else if mail_lines.is_empty() {
                gaps.push(Gap { source: "email_today", reason: Reason::Empty });
            }
        }
        let email_today = Section { key: "email_today", label: "EMAIL ARRIVED TODAY", lines: mail_lines, count: mail.len(), raw: vec![] };

        let plan = plan_context::resolve(host, now, zone, &mut gaps);
        let raw_calendar = calendar.as_ref().map(|c| c.raw.clone()).unwrap_or_default();
        let day_plan = plan_prose::section(&plan, &tasks.raw, calendar_loaded(&gathered, subject, &gaps).then_some(&raw_calendar[..]), zone, gathered.now);
        let morning = morning_plan(host, now, zone);
        let morning_section = Section {
            key: "morning_plan",
            label: "THIS MORNING'S PLAN",
            lines: morning.clone().unwrap_or_default(),
            count: morning.as_ref().map_or(0, Vec::len),
            raw: vec![],
        };
        subject.deadline.check(host)?;

        let selected = |tool: &str| subject.selected_tools.iter().any(|t| t == tool);
        let mut sections = vec![recon, Section::empty("commitments", "COMMITMENTS"), tomorrow, email_today];
        if selected("goals.list") {
            sections.push(Section::empty("goals", "GOALS"));
        }
        if selected("sports.followedFactsToday") {
            sections.push(Section::empty("sports", "SPORTS"));
        }
        sections.extend([Section::empty("chats", "CHATS"), morning_section, day_plan]);
        if selected("news.topHeadlinesToday") {
            gaps.push(Gap { source: "news", reason: Reason::Unwired });
        }

        let lines_of = |key: &str| find(&sections, key).map(|s| s.lines.len()).unwrap_or(0);
        let context = signals::context_tokens(&[&find(&sections, "tasks_reconciliation").map(|s| s.lines.clone()).unwrap_or_default()]);
        let email_signals = signals::derive_email_signals(&mail, now, zone, &context, &EmailSettings::default());
        let since = crate::lenses::local_day_start(now, zone).unwrap_or(gathered.since);
        let catch_up = action_rows::build_email_catch_up(&email_raw, &rows.source_refs, since, email_evidence::is_no_action_confirmation);
        let payload = json!({"version": 1, "actionRows": rows.rows, "catchUp": catch_up, "planContext": plan});
        let section_lines: serde_json::Map<String, Value> = sections.iter().map(|s| (s.key.to_owned(), json!(s.lines.len()))).collect();

        let mut metadata = gathered.metadata();
        let into = metadata.as_object_mut().expect("object");
        into.insert("gaps".into(), json!(gaps.iter().map(Gap::to_json).collect::<Vec<_>>()));
        into.insert("sectionLines".into(), Value::Object(section_lines));
        into.insert("emailMessageCount".into(), json!(email_raw.len()));
        into.insert("taskCompletedCount".into(), json!(counts[0]));
        into.insert("taskSlippedCount".into(), json!(counts[1]));
        into.insert("taskCarryCount".into(), json!(counts[2]));
        into.insert("commitmentCount".into(), json!(0));
        into.insert("tomorrowEventCount".into(), json!(tomorrow_total));
        into.insert("emailSignalCount".into(), json!(email_signals.len()));
        into.insert("emailSignals".into(), json!(email_signals));
        into.insert("emailEvidence".into(), rank_evidence(assessment.evidence.clone(), &email_signals));
        into.insert("goalCount".into(), json!(lines_of("goals")));
        into.insert("sportsCount".into(), json!(lines_of("sports")));
        into.insert("chatTurnCount".into(), json!(0));
        into.insert("morningRunReferenced".into(), json!(morning.is_some()));
        into.insert("structuredPayload".into(), payload.clone());
        into.insert("degraded".into(), json!(gathered.degraded));
        if !plan.is_null() {
            into.insert("planSnapshot".into(), plan.clone());
        }

        let prompt = build_prompt(&sections);
        let answer = host.call("ai", "generate", "summarization", json!({"prompt": prompt, "maxOutputTokens": EVENING_MAX_OUTPUT_TOKENS}));
        subject.deadline.check(host)?;
        let text = answer.as_ref().ok().and_then(|a| a["text"].as_str()).map(str::trim).filter(|t| !t.is_empty());
        let Some(text) = text else {
            let reason = failure_reason(&answer.err().map(|e| e.to_string()).unwrap_or_default());
            into.insert("aiModel".into(), Value::Null);
            into.insert("degraded".into(), json!(true));
            into.insert("degradedReason".into(), json!(reason));
            let keep = payload["actionRows"].as_array().is_some_and(|r| !r.is_empty()) || !payload["catchUp"].is_null() || !plan.is_null();
            into.insert("structuredPayload".into(), if keep { payload } else { empty_payload() });
            return Ok(Composed { status: "succeeded", summary_text: plain_digest(&sections), source_metadata: metadata });
        };
        // The router returns text only, so the model is named as the configured one.
        into.insert("aiModel".into(), json!({"id": "router", "displayName": "Configured model", "tier": "standard"}));
        Ok(Composed { status: "succeeded", summary_text: text.to_owned(), source_metadata: metadata })
    }
}
