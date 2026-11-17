//! Email judgement. One model call per thread answers one question: does this thread create
//! something the owner owes. The result is a candidate that waits for the person's review.
use crate::extract::Warning;
use crate::{signature, store};
use moss_module_sdk::{Client, Error, Host, Result};
use serde_json::{json, Value};

pub const WHY_MAX_LINES: usize = 3;
pub const WHY_MAX_CHARS: usize = 240;
pub const ACTIONS_MAX: usize = 4;
pub const MESSAGES_MAX: usize = 12;
const TITLE_MAX: usize = 200;
const LABEL_MAX: usize = 200;
const ADDRESS_MAX: usize = 320;
const REPLY_FACTS_MAX: usize = 6;
const OPEN_TASKS_LIMIT: usize = 25;
const MAX_OUTPUT_TOKENS: u32 = 2048;

const CODE_WORDS: [&str; 9] = [
    "verification code", "one-time", "passcode", "security code", "sign-in code", "login code",
    "confirmation code", "otp", "2fa",
];

#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub owed: bool,
    pub title: Option<String>,
    pub counterparty_label: Option<String>,
    pub counterparty_address: Option<String>,
    pub due_local_date: Option<String>,
    pub confidence: String,
    pub why: Vec<String>,
    pub actions: Vec<Value>,
}

fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// One sentence at most, quotes kept, never longer than a why line may be.
pub fn cap_quote(line: &str) -> String {
    let trimmed: String = line.trim().chars().take(WHY_MAX_CHARS).collect();
    let quoted = trimmed.starts_with('"');
    let inner = if quoted { trimmed[1..].strip_suffix('"').unwrap_or(&trimmed[1..]) } else { &trimmed[..] };
    let one = match inner.find(['.', '!', '?']) {
        Some(at) => &inner[..=at],
        None => inner,
    };
    let out = if quoted { format!("\"{one}\"") } else { one.to_owned() };
    out.chars().take(WHY_MAX_CHARS).collect()
}

fn action(raw: &Value) -> Option<Value> {
    let a = raw.as_object()?;
    match a.get("kind")?.as_str()? {
        "reply" => Some(json!({
            "kind": "reply",
            "facts": a.get("facts").and_then(Value::as_array).into_iter().flatten()
                .filter_map(Value::as_str).take(REPLY_FACTS_MAX).collect::<Vec<_>>(),
            "wantsFreeSlots": a.get("wantsFreeSlots") == Some(&json!(true)),
        })),
        "task" => {
            let title = a.get("title")?.as_str()?;
            let due = a.get("dueLocalDate").and_then(Value::as_str).filter(|d| is_date(d));
            Some(json!({"kind":"task","title":title.chars().take(TITLE_MAX).collect::<String>(),"dueLocalDate":due}))
        }
        "snooze" => {
            let until = a.get("untilLocalDate")?.as_str().filter(|d| is_date(d))?;
            Some(json!({"kind":"snooze","untilLocalDate":until}))
        }
        "dismiss" => Some(json!({"kind":"dismiss"})),
        _ => None,
    }
}

/// None for anything malformed. Otherwise a capped, deduplicated outcome that is safe to store.
pub fn parse_outcome(raw: &Value) -> Option<Outcome> {
    let r = raw.as_object()?;
    let owed = r.get("owed")?.as_bool()?;
    let empty = Outcome { owed: false, title: None, counterparty_label: None, counterparty_address: None,
        due_local_date: None, confidence: "low".into(), why: vec![], actions: vec![] };
    if !owed {
        return Some(empty);
    }
    let title = r.get("title")?.as_str().map(str::trim).filter(|t| !t.is_empty())?;
    let due = match r.get("dueLocalDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if is_date(d) => Some(d.clone()),
        _ => return None,
    };
    let confidence = r.get("confidence").and_then(Value::as_str).filter(|c| ["high", "medium", "low"].contains(c)).unwrap_or("low");
    let why = r.get("why").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).take(WHY_MAX_LINES).map(cap_quote).collect();
    let mut seen = vec![];
    let mut actions = vec![];
    for candidate in r.get("actions").and_then(Value::as_array).into_iter().flatten() {
        let Some(parsed) = action(candidate) else { continue };
        let kind = parsed["kind"].as_str().unwrap_or("").to_owned();
        if seen.contains(&kind) {
            continue;
        }
        seen.push(kind);
        actions.push(parsed);
        if actions.len() == ACTIONS_MAX {
            break;
        }
    }
    Some(Outcome {
        owed: true,
        title: Some(title.chars().take(TITLE_MAX).collect()),
        counterparty_label: r.get("counterpartyLabel").and_then(Value::as_str).map(|l| l.chars().take(LABEL_MAX).collect()),
        counterparty_address: r.get("counterpartyAddress").and_then(Value::as_str)
            .map(|a| a.trim().to_lowercase().chars().take(ADDRESS_MAX).collect()),
        due_local_date: due,
        confidence: confidence.to_owned(),
        why,
        actions,
    })
}

/// The model's answer as JSON, whether or not it wrapped the object in text or a fence.
fn answer_json(text: &str) -> Option<Value> {
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    serde_json::from_str(text.get(start..=end)?).ok()
}

pub struct Context {
    pub today: String,
    pub timezone: String,
    pub person: Option<Value>,
    pub open_tasks: Vec<Value>,
    pub missing: Vec<&'static str>,
    pub sender_ruled_not_obligation: bool,
}

/// A message that could hand over a sign-in code never sends its body to the model.
fn may_hold_a_code(message: &Value) -> bool {
    let text = format!("{} {}", message["subject"].as_str().unwrap_or(""), message["bodyExcerpt"].as_str().unwrap_or("")).to_lowercase();
    CODE_WORDS.iter().any(|w| text.contains(w))
}

pub fn build_prompt(messages: &[Value], c: &Context) -> String {
    let mut lines = vec![
        "You are the user's chief of staff. Read this email thread with what you know about the user, and answer one question: does this thread create something the user owes?".to_owned(),
        "Owed means a person or institution the user deals with is waiting on them, or a date binds them. Urgent wording is not evidence. Promotions, notices, newsletters and routine back-and-forth that ask nothing are not owed.".into(),
        "If owed: give a short title in the form 'Do X for Y', who is waiting, the due date as when the user's reply or step is owed, never the event date, a confidence, up to three why lines (quote at most one sentence from the email; otherwise say which fact you leaned on), and up to four proposed actions from: reply (with facts to use and whether free slots help), task (title, dueLocalDate), snooze (untilLocalDate), dismiss.".into(),
        "Dates are YYYY-MM-DD in the user's timezone. If not owed, answer owed:false and nothing else.".into(),
        "Answer with one JSON object with the keys owed, title, counterpartyLabel, counterpartyAddress, dueLocalDate, confidence (high, medium or low), why (list of strings) and actions (list of objects with a kind key).".into(),
        format!("Today: {} ({})", c.today, c.timezone),
    ];
    if c.sender_ruled_not_obligation {
        lines.push("The user has ruled that mail from this sender is not something they owe. Only answer owed:true if this thread is clearly different.".into());
    }
    lines.push(String::new());
    lines.push("## Thread (oldest first)".into());
    for m in &messages[messages.len().saturating_sub(MESSAGES_MAX)..] {
        let who = if m["fromIsUser"] == json!(true) { "the user" } else { m["fromAddress"].as_str().unwrap_or("") };
        let body = if may_hold_a_code(m) { "" } else { m["bodyExcerpt"].as_str().unwrap_or("") };
        lines.push(format!("- {} from {}: {}\n  {}", m["receivedAt"].as_str().unwrap_or(""), who, m["subject"].as_str().unwrap_or(""), body));
    }
    lines.push(String::new());
    lines.push("## Who this is".into());
    if c.missing.contains(&"people") {
        lines.push("People: unavailable".into());
    } else if let Some(p) = &c.person {
        let rel = p["relationshipSummary"].as_str().map(|r| format!(", {r}")).unwrap_or_default();
        lines.push(format!("Person: {}{}", p["displayName"].as_str().unwrap_or("(unnamed)"), rel));
    } else {
        lines.push("Person: not in the user's People.".into());
    }
    lines.push(String::new());
    lines.push("## Notes that mention them".into());
    lines.push("None.".into());
    lines.push(String::new());
    lines.push("## Open tasks that may relate".into());
    if c.missing.contains(&"tasks") {
        lines.push("Tasks: unavailable".into());
    } else if c.open_tasks.is_empty() {
        lines.push("None.".into());
    } else {
        for t in &c.open_tasks {
            let due = t["dueAt"].as_str().map(|d| format!(" (due {})", d.get(..10).unwrap_or(d))).unwrap_or_default();
            lines.push(format!("- {}{}", t["title"].as_str().unwrap_or(""), due));
        }
    }
    lines.push(String::new());
    lines.push("## Calendar, next 14 days (busy)".into());
    lines.push("Not needed for this thread.".into());
    lines.join("\n")
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    NoItem,
    Item,
    Skipped,
}

fn to_jobs_error(_: Error) -> Error {
    Error::new("Email thread unavailable")
}

/// The thread this message belongs to, and the owner's own addresses.
fn locate<H: Host + ?Sized>(host: &H, message_id: &str) -> Result<Option<(String, Vec<Value>)>> {
    let client = Client(host);
    let reply = client.api("email", "replyContext", json!({"cacheMessageId": message_id})).map_err(to_jobs_error)?;
    let Some(thread) = reply["threadId"].as_str().filter(|t| !t.is_empty()) else { return Ok(None) };
    let own = client.api("email", "emailTriageContext", json!({})).map_err(to_jobs_error)?;
    let addresses = own["ownAddresses"].as_array().cloned().unwrap_or_default();
    Ok(Some((thread.to_owned(), addresses)))
}

/// Judges one thread. A failed model call fails the job so the queue retries it. An answer
/// that cannot be read is recorded as nothing owed, so the thread is not judged again until a
/// newer message arrives.
pub fn run<H: Host + ?Sized>(host: &H, message_id: &str) -> Result<(Verdict, Vec<Warning>)> {
    let mut warnings = vec![];
    let Some((thread_ref, addresses)) = locate(host, message_id)? else { return Ok((Verdict::Skipped, warnings)) };
    let listed = Client(host)
        .api("email", "listThreadMessages", json!({"threadRef": thread_ref, "userAddresses": addresses}))
        .map_err(to_jobs_error)?;
    let messages = listed["messages"].as_array().cloned().unwrap_or_default();
    let Some(newest) = messages.last() else { return Ok((Verdict::Skipped, warnings)) };
    let newest_id = newest["externalId"].as_str().unwrap_or("").to_owned();
    if let Some(prior) = store::thread_judgement(host, &thread_ref)? {
        if prior["last_judged_external_id"] == json!(newest_id) {
            return Ok((Verdict::Skipped, warnings));
        }
    }
    let user_wrote = |m: &Value| m["fromIsUser"] == json!(true);
    if user_wrote(newest) || !messages.iter().any(user_wrote) {
        store::record_thread_judgement(host, &thread_ref, &newest_id, "no_item")?;
        return Ok((Verdict::NoItem, warnings));
    }
    let sender = newest["fromAddress"].as_str().unwrap_or("").to_owned();
    let mut missing = vec![];
    let person = match Client(host).api("people", "resolve", json!({"query": sender})) {
        Ok(found) => found["person"].as_object().map(|_| found["person"].clone()),
        Err(_) => {
            missing.push("people");
            None
        }
    };
    let open_tasks = match Client(host).api("tasks", "listBriefingTasks", json!({"status": "todo"})) {
        Ok(found) => found["items"].as_array().cloned().unwrap_or_default().into_iter().take(OPEN_TASKS_LIMIT).collect(),
        Err(_) => {
            missing.push("tasks");
            vec![]
        }
    };
    let day = host.call("context", "local-date", "account", json!({"instant": store::now(host)?, "offsetDays": 0}))?;
    let context = Context {
        today: day["date"].as_str().unwrap_or("").to_owned(),
        timezone: day["timezone"].as_str().unwrap_or("UTC").to_owned(),
        person: person.clone(),
        open_tasks,
        missing,
        sender_ruled_not_obligation: false,
    };
    let prompt = build_prompt(&messages, &context);
    let answer = host.call("ai", "generate", "structured", json!({"prompt": prompt, "maxOutputTokens": MAX_OUTPUT_TOKENS}))?;
    let outcome = answer["text"].as_str().and_then(answer_json).and_then(|v| parse_outcome(&v));
    let Some(outcome) = outcome else {
        warnings.push(Warning { event: "commitments.email_judgement_malformed", source_kind: "email".into() });
        store::record_thread_judgement(host, &thread_ref, &newest_id, "no_item")?;
        return Ok((Verdict::NoItem, warnings));
    };
    let Some(title) = outcome.title.as_deref().filter(|_| outcome.owed) else {
        store::record_thread_judgement(host, &thread_ref, &newest_id, "no_item")?;
        return Ok((Verdict::NoItem, warnings));
    };
    let has_task = outcome.actions.iter().any(|a| a["kind"] == "task");
    let sig = signature::candidate_signature(&signature::SignatureInput {
        kind: "obligation", counterparty_label: None, title: "email-thread", due_local_date: None,
        source_kind: "email", source_ref: &thread_ref,
    });
    let person_name = person.as_ref().and_then(|p| p["displayName"].as_str());
    let person_id = person.as_ref().and_then(|p| p["id"].as_str());
    store::upsert_candidate(host, &store::Candidate {
        signature: &sig,
        kind: "obligation",
        title,
        due_local_date: outcome.due_local_date.as_deref(),
        counterparty_label: Some(outcome.counterparty_label.as_deref().or(person_name).unwrap_or(&sender)),
        confidence: &outcome.confidence,
        suggested_handling: has_task.then_some("create_task"),
        email: Some(store::EmailFields {
            person_id,
            address: Some(outcome.counterparty_address.as_deref().unwrap_or(&sender)),
            actions: outcome.actions.clone(),
            why: outcome.why.clone(),
            thread_ref: &thread_ref,
            last_judged_external_id: &newest_id,
        }),
    })?;
    store::record_thread_judgement(host, &thread_ref, &newest_id, "item")?;
    Ok((Verdict::Item, warnings))
}
