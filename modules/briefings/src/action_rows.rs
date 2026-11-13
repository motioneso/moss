//! The discrete rows beside the briefing text, and the email catch-up digest. Rows come from the
//! person's suggested tasks, read through the Tasks public call. The catch-up lists important
//! mail that is not already a row. Neither is written by the model.
use crate::gather_types::SECTION_ITEM_CAP;
use crate::text::js_trim;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const CATCH_UP_ENTRY_CAP: usize = 8;

pub fn empty_payload() -> Value {
    json!({"version": 1, "actionRows": [], "catchUp": null})
}

pub struct ActionRows {
    pub rows: Vec<Value>,
    pub source_refs: HashSet<String>,
    pub invalid_metadata: usize,
}

fn nonblank(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !js_trim(s).is_empty())
}

fn valid_metadata(m: &Value) -> bool {
    m.is_object()
        && m["version"] == 1
        && matches!(m["category"].as_str(), Some("needs_reply" | "needs_action" | "time_sensitive_info"))
        && m["sourceLabel"].is_string()
        && (m["sourceHref"].is_null() || m["sourceHref"].is_string())
        && (m["cacheMessageId"].is_null() || m["cacheMessageId"].is_string())
        && m["subjectSignature"].is_string()
        && m["computedAt"].is_string()
        && (m["resurfaceReason"].is_null() || matches!(m["resurfaceReason"].as_str(), Some("due_tomorrow" | "relevant_context")))
}

fn millis(value: &Value) -> Option<i64> {
    value.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.timestamp_millis())
}

fn primary_action(m: &Value) -> Option<Value> {
    if m["category"] == "needs_reply" {
        return nonblank(&m["cacheMessageId"]).filter(|s| !s.is_empty()).map(|_| json!({"kind": "reply", "cacheMessageId": m["cacheMessageId"]}));
    }
    nonblank(&m["sourceHref"]).map(|_| json!({"kind": "view", "href": m["sourceHref"]}))
}

/// Builds rows from suggested tasks. A task with broken metadata is counted and left out.
pub fn project_action_rows(tasks: &[Value]) -> ActionRows {
    let mut invalid = 0;
    let mut rows: Vec<(Value, Option<i64>, Option<i64>)> = vec![];
    for t in tasks.iter().filter(|t| t.is_object()) {
        let m = &t["suggestionMetadata"];
        if !valid_metadata(m) {
            invalid += 1;
            continue;
        }
        let shaped = t["id"].is_string()
            && t["title"].is_string()
            && (t["description"].is_null() || t["description"].is_string())
            && (t["dueAt"].is_null() || t["dueAt"].is_string())
            && (t["updatedAt"].is_null() || t["updatedAt"].is_string())
            && t["source"].is_string();
        let Some(source_ref) = nonblank(&t["sourceRef"]).filter(|s| !s.is_empty()) else { continue };
        if !shaped || nonblank(&m["cacheMessageId"]).is_none() {
            continue;
        }
        let action = primary_action(m);
        if action.is_none() && m["category"] == "needs_reply" {
            continue;
        }
        let explanation = nonblank(&t["description"]).map(|_| t["description"].clone()).unwrap_or_else(|| json!("This email may need your attention."));
        rows.push((
            json!({
                "taskId": t["id"], "title": t["title"], "explanation": explanation,
                "category": m["category"], "status": "suggested", "primaryAction": action,
                "source": t["source"], "sourceLabel": m["sourceLabel"], "sourceRef": source_ref,
                "sourceHref": m["sourceHref"], "dueAt": t["dueAt"], "computedAt": m["computedAt"],
                "resurfaceReason": m["resurfaceReason"],
            }),
            millis(&t["dueAt"]),
            millis(&t["updatedAt"]),
        ));
    }
    rows.sort_by(|a, b| {
        a.1.unwrap_or(i64::MAX)
            .cmp(&b.1.unwrap_or(i64::MAX))
            .then_with(|| b.2.unwrap_or(0).cmp(&a.2.unwrap_or(0)))
            .then_with(|| a.0["taskId"].as_str().cmp(&b.0["taskId"].as_str()))
    });
    let rows: Vec<Value> = rows.into_iter().take(SECTION_ITEM_CAP).map(|r| r.0).collect();
    let source_refs = rows.iter().filter_map(|r| r["sourceRef"].as_str().map(str::to_owned)).collect();
    ActionRows { rows, source_refs, invalid_metadata: invalid }
}

/// The message's reference, from its own ref or its account and message ids.
pub fn email_source_ref(item: &Value) -> Option<String> {
    if let Some(r) = item["sourceRef"].as_str().filter(|s| !s.is_empty()) {
        return Some(r.to_owned());
    }
    let account = item["connectorAccountId"].as_str().or_else(|| item["account"]["connectorAccountId"].as_str())?;
    let message = item["id"].as_str().or_else(|| item["messageKey"].as_str())?;
    Some(format!("{account}:{message}"))
}

/// Stable per message across runs: a short hash of the cleaned source reference.
pub fn catch_up_entry_id(source_ref: &str) -> String {
    let clean = source_ref.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let digest = Sha256::digest(clean.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("email-digest:{}", &hex[..16])
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let decoded = tail.find(';').filter(|e| *e <= 10).and_then(|e| {
            let name = &tail[1..e];
            let ch = match name.to_lowercase().as_str() {
                "amp" => Some('&'),
                "apos" => Some('\''),
                "gt" => Some('>'),
                "lt" => Some('<'),
                "quot" => Some('"'),
                "nbsp" => Some(' '),
                n if n.starts_with("#x") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
                n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            ch.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn summary_of(item: &Value) -> Option<String> {
    let text = decode_entities(item["summary"].as_str()?).split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

fn sender_name(sender: &Value) -> String {
    let raw = sender.as_str().map(|s| decode_entities(s).trim().to_owned()).unwrap_or_default();
    let (name, address) = match (raw.rfind('<'), raw.ends_with('>')) {
        (Some(open), true) => (raw[..open].trim().trim_matches('"').trim().to_owned(), raw[open + 1..raw.len() - 1].trim().to_owned()),
        _ => (String::new(), raw.clone()),
    };
    if !name.is_empty() {
        return name;
    }
    let local = address.split('@').next().filter(|_| address.find('@').is_some_and(|a| a > 0)).unwrap_or(&address);
    if local.is_empty() { "Unknown sender".into() } else { local.to_owned() }
}

fn https_href(value: &Value) -> Option<String> {
    value.as_str().filter(|s| s.starts_with("https://") && s.len() > 8).map(str::to_owned)
}

fn rank(item: &Value) -> u8 {
    if item["importance"] == "high" {
        0
    } else if item["actionability"] == "waiting_on_someone" {
        1
    } else {
        2
    }
}

fn entry(item: &Value) -> Option<Value> {
    let source_ref = email_source_ref(item)?;
    let summary = summary_of(item)?;
    let received = item["receivedAt"].as_str()?;
    Some(json!({
        "id": catch_up_entry_id(&source_ref),
        "senderName": sender_name(&item["sender"]),
        "summary": summary,
        "receivedAt": received,
        "reason": if item["importance"] == "high" { json!("important") } else if item["actionability"] == "waiting_on_someone" { json!("waiting_on_them") } else { Value::Null },
        "cacheMessageId": item["cacheMessageId"].as_str().filter(|s| !s.is_empty()),
        "openHref": https_href(&item["sourceHref"]),
    }))
}

/// Important informational mail since `since` that is not already an action row. Mail left out as
/// newsletters, receipts or notifications is counted. Unsorted mail is neither shown nor counted.
pub fn build_email_catch_up(items: &[Value], row_refs: &HashSet<String>, since: DateTime<Utc>, confirmed: impl Fn(&Value) -> bool) -> Option<Value> {
    let mut left_out = 0;
    let mut eligible: Vec<&Value> = vec![];
    for item in items {
        if email_source_ref(item).is_some_and(|r| row_refs.contains(&r)) {
            continue;
        }
        let in_window = item["receivedAt"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).is_some_and(|t| t >= since);
        if !in_window || item["answered"] == true {
            continue;
        }
        let kind = item["actionability"].as_str();
        if confirmed(item) || matches!(kind, Some("noise" | "receipt_or_notice")) {
            left_out += 1;
            continue;
        }
        if !matches!(kind, Some("fyi" | "waiting_on_someone")) || item["awaitingJudgement"] == true || summary_of(item).is_none() {
            continue;
        }
        if item["importance"] == "low" || (item["bulk"] == true && item["importance"] != "high") {
            left_out += 1;
            continue;
        }
        eligible.push(item);
    }
    eligible.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| millis(&b["receivedAt"]).unwrap_or(0).cmp(&millis(&a["receivedAt"]).unwrap_or(0))));
    let entries: Vec<Value> = eligible.into_iter().filter_map(entry).take(CATCH_UP_ENTRY_CAP).collect();
    if entries.is_empty() {
        return None;
    }
    Some(json!({
        "source": "email", "itemCount": entries.len(),
        "since": since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "leftOutCount": left_out, "asOf": null, "entries": entries,
    }))
}
