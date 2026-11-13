//! The morning composition. It gathers the sources, derives signals, action rows and the email
//! catch-up, asks the router for the text, and tidies the answer. Outside text only ever enters
//! the prompt through sanitized lines in delimited blocks. When the router cannot answer, the run
//! keeps a plain digest and says why, so the person still gets their sources.
use crate::action_rows::{self, empty_payload};
use crate::compose::{Composed, Composer, Subject, EMPTY_FALLBACK};
use crate::evening::EveningComposer;
use crate::email_evidence;
use crate::external::NoContributors;
use crate::gather::{self, api, email_lines, gather, items, join, Gathered};
use crate::gather_types::{cap_lines, Gap, Reason, Section};
use crate::morning_order::tidy_morning_sections;
use crate::{plan_context, plan_prose};
use crate::morning_prompt::build_prompt;
use crate::signals::{self, CalendarSettings, EmailSettings};
use crate::trust::sanitize_external;
use chrono::{DateTime, Utc};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

/// Most output tokens the morning text may use.
pub const MORNING_MAX_OUTPUT_TOKENS: u32 = 2000;

pub struct MorningComposer;

fn line_count(sections: &[Section]) -> Value {
    sections.iter().map(|s| (s.key.to_owned(), json!(s.lines.len()))).collect::<serde_json::Map<_, _>>().into()
}

/// Action rows come from suggested tasks. A failed read leaves no rows and shows a gap.
pub(crate) fn read_action_rows<H: Host + ?Sized>(host: &H, subject: &Subject<'_>, gaps: &mut Vec<Gap>) -> action_rows::ActionRows {
    let none = || action_rows::ActionRows { rows: vec![], source_refs: Default::default(), invalid_metadata: 0 };
    if !subject.selected_tools.iter().any(|t| t == gather::TASKS) {
        return none();
    }
    match api(host, "tasks", "listBriefingTasks", json!({"status": "suggested"})) {
        Ok(reply) => {
            let suggested: Vec<Value> = items(&reply).into_iter().filter(|t| t["status"] == "suggested").collect();
            action_rows::project_action_rows(&suggested)
        }
        Err(_) => {
            gaps.push(Gap { source: "action_rows", reason: Reason::ToolFailed });
            none()
        }
    }
}

fn local_clock(value: &Value, g: &Gathered) -> String {
    gather::instant(value.as_str().unwrap_or_default())
        .map(|t| t.with_timezone(&g.zone).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// Today's events in time order, each with its time range, name and place.
fn calendar_today(raw: &[Value], g: &Gathered) -> Section {
    let today = g.now.with_timezone(&g.zone).date_naive();
    let mut events: Vec<(DateTime<Utc>, &Value)> = raw
        .iter()
        .filter_map(|e| gather::instant(e["startsAt"].as_str().unwrap_or_default()).map(|t| (t, e)))
        .filter(|(t, _)| t.with_timezone(&g.zone).date_naive() == today)
        .collect();
    events.sort_by_key(|(t, _)| *t);
    let lines: Vec<String> = events
        .iter()
        .map(|(_, e)| {
            let range = join(vec![local_clock(&e["startsAt"], g), local_clock(&e["endsAt"], g)]).replace(" · ", "-");
            let place = sanitize_external(&e["location"]);
            join(vec![range, sanitize_external(&e["title"]), if place.is_empty() { place } else { format!("at {place}") }])
        })
        .filter(|l| !l.is_empty())
        .collect();
    let count = lines.len();
    let (lines, _) = cap_lines(lines);
    Section { key: "calendar_today", label: "CALENDAR TODAY", lines, count, raw: vec![] }
}

fn find<'a>(sections: &'a [Section], key: &str) -> Option<&'a Section> {
    sections.iter().find(|s| s.key == key)
}

fn digest(sections: &[Section]) -> String {
    let text = sections
        .iter()
        .map(|s| {
            let plural = if s.count == 1 { "" } else { "s" };
            let lines = s.lines.iter().map(|l| format!("\n- {l}")).collect::<String>();
            format!("{}: {} item{plural}{lines}", s.label, s.count)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() { EMPTY_FALLBACK.to_owned() } else { text }
}

/// Maps a router failure to the stored reason. The router gives no credential detail.
pub(crate) fn failure_reason(message: &str) -> &'static str {
    if message.contains("not set up") || message.contains("not configured") { "no_model" } else { "synthesis_failed" }
}

impl Composer for MorningComposer {
    fn compose<H: Host + ?Sized>(&self, host: &H, subject: &Subject<'_>) -> Result<Composed> {
        // The evening review has its own composition. The weekly review is written like the
        // morning briefing, as it always was.
        if subject.briefing_type == "evening" {
            return EveningComposer.compose(host, subject);
        }
        let mut gathered = gather(host, subject, &NoContributors)?;
        let mut gaps: Vec<Gap> = std::mem::take(&mut gathered.gaps);

        let rows = read_action_rows(host, subject, &mut gaps);
        subject.deadline.check(host)?;

        let raw = |key: &str| find(&gathered.sections, key).map(|s| s.raw.clone()).unwrap_or_default();
        let (calendar_raw, email_raw) = (raw("calendar"), raw("email"));
        let assessment = email_evidence::assess(&email_raw, gathered.now, gathered.zone);
        let plan = plan_context::resolve(host, gathered.now, gathered.zone, &mut gaps);
        let task_items = raw("tasks");
        let day_plan = plan_prose::section(&plan, &task_items, calendar_loaded(&gathered, subject, &gaps).then_some(&calendar_raw[..]), gathered.zone);

        // The prompt's mail lines skip rows already shown and mail the evidence rules out.
        let mail: Vec<Value> = assessment
            .eligible
            .iter()
            .filter(|m| gather::is_briefing_email(m))
            .filter(|m| !action_rows::email_source_ref(m).is_some_and(|r| rows.source_refs.contains(&r)))
            .cloned()
            .collect();
        let (mail_lines, _) = cap_lines(email_lines(&mail));
        let mut prompt_sections: Vec<Section> = vec![
            Section::empty("commitments", "COMMITMENTS"),
            find(&gathered.sections, "tasks").cloned().unwrap_or_else(|| Section::empty("tasks", "TASKS")),
            find(&gathered.sections, "calendar").cloned().unwrap_or_else(|| Section::empty("calendar", "CALENDAR")),
            calendar_today(&calendar_raw, &gathered),
            Section::empty("weather", "WEATHER"),
            Section { key: "email", label: "EMAIL SUMMARIES + SIGNALS", count: email_raw.len(), lines: mail_lines, raw: vec![] },
            Section::empty("vault", "VAULT"),
            Section::empty("chats", "CHATS"),
            Section { label: "DAY PLAN", ..day_plan },
        ];
        prompt_sections.iter_mut().for_each(|s| s.raw.clear());

        let task_lines = find(&prompt_sections, "tasks").map(|s| s.lines.clone()).unwrap_or_default();
        let context = signals::context_tokens(&[&task_lines]);
        let calendar_signals = signals::derive_calendar_signals(&calendar_raw, gathered.now, gathered.zone, &context, &CalendarSettings::default());
        let email_signals = signals::derive_email_signals(&assessment.eligible, gathered.now, gathered.zone, &context, &EmailSettings::default());

        let catch_up = action_rows::build_email_catch_up(&email_raw, &rows.source_refs, gathered.since, email_evidence::is_no_action_confirmation);
        let payload = json!({"version": 1, "actionRows": rows.rows, "catchUp": catch_up, "planContext": plan});
        let ranked_evidence = rank_evidence(assessment.evidence.clone(), &email_signals);

        let mut metadata = gathered.metadata();
        let (into, now) = (metadata.as_object_mut().expect("object"), gathered.now);
        into.insert("gaps".into(), json!(gaps.iter().map(Gap::to_json).collect::<Vec<_>>()));
        into.insert("sectionLines".into(), line_count(&prompt_sections));
        into.insert("calendarSignals".into(), json!(calendar_signals));
        into.insert("emailSignals".into(), json!(email_signals));
        into.insert("emailEvidence".into(), ranked_evidence);
        into.insert("structuredPayload".into(), payload.clone());
        // The next morning run reads completed tasks from this time on.
        into.insert("tasksReadAt".into(), json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
        into.insert("degraded".into(), json!(gathered.degraded));
        if !plan.is_null() {
            into.insert("planSnapshot".into(), plan.clone());
        }

        let prompt = build_prompt(&prompt_sections);
        let answer = host.call("ai", "generate", "summarization", json!({"prompt": prompt, "maxOutputTokens": MORNING_MAX_OUTPUT_TOKENS}));
        subject.deadline.check(host)?;
        let text = answer.as_ref().ok().and_then(|a| a["text"].as_str()).map(str::trim).filter(|t| !t.is_empty());
        let Some(text) = text else {
            let reason = failure_reason(&answer.err().map(|e| e.to_string()).unwrap_or_default());
            into.insert("aiModel".into(), Value::Null);
            into.insert("degraded".into(), json!(true));
            into.insert("degradedReason".into(), json!(reason));
            into.insert("calendarSignals".into(), json!([]));
            into.insert("emailSignals".into(), json!([]));
            into.insert("structuredPayload".into(), if payload["actionRows"].as_array().is_some_and(|r| !r.is_empty()) || !payload["catchUp"].is_null() || !plan.is_null() { payload } else { empty_payload() });
            return Ok(Composed { status: "succeeded", summary_text: digest(&gathered.sections), source_metadata: metadata });
        };
        let titles: Vec<String> = calendar_raw.iter().filter_map(|e| e["title"].as_str().map(str::to_owned)).collect();
        // The router returns text only, so the model is named as the configured one.
        into.insert("aiModel".into(), json!({"id": "router", "displayName": "Configured model", "tier": "standard"}));
        Ok(Composed {
            status: "succeeded",
            summary_text: tidy_morning_sections(text, &titles, true),
            source_metadata: metadata,
        })
    }
}

/// True when the calendar was read in full, so a missing event can be called missing. A calendar
/// that was left out, failed, or has no connected account says nothing about events.
pub(crate) fn calendar_loaded(g: &Gathered, subject: &Subject<'_>, gaps: &[Gap]) -> bool {
    subject.selected_tools.iter().any(|t| t == gather::CALENDAR)
        && g.sections.iter().any(|s| s.key == "calendar")
        && g.source_context["calendar"]["accounts"].as_array().is_some_and(|a| !a.is_empty())
        && g.source_context["calendar"]["gaps"].as_array().is_some_and(|a| a.is_empty())
        && !gaps.iter().any(|gap| gap.source == "calendar" && matches!(gap.reason, Reason::ToolFailed | Reason::SourceAuth))
}

/// Marks each evidence row with its place among the email signals.
pub(crate) fn rank_evidence(mut evidence: Value, signals: &[Value]) -> Value {
    if let Some(rows) = evidence["items"].as_array_mut() {
        for row in rows {
            let rank = signals.iter().position(|s| {
                s["connectorAccountId"] == row["connectorAccountId"]
                    && s["messageIds"].as_array().is_some_and(|ids| ids.contains(&row["messageId"]))
            });
            if let Some(rank) = rank {
                row["rank"] = json!(rank);
                row["rankingReasons"] = signals[rank]["relevanceReasons"].clone();
            }
        }
    }
    evidence
}
