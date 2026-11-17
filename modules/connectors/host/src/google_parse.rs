//! Turns Gmail messages and Calendar events from Google into the shapes Email and Calendar
//! cache. Message text beyond the header fields and Gmail's own short snippet is never kept.
use crate::imap_sync::looks_like_one_time_code;
use chrono::{TimeZone, Utc};
use serde_json::{json, Map, Value};

const SUMMARY_CHARS: usize = 2000;
const ATTENDEES_MAX: usize = 20;
const ATTENDEE_CHARS: usize = 80;
const FORMAT: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";

fn header(message: &Value, name: &str) -> Option<String> {
    message["payload"]["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Splits an address list on commas that sit outside quotes and angle brackets.
fn split_addresses(list: &str) -> Vec<String> {
    let (mut out, mut current, mut quoted, mut angled) = (Vec::new(), String::new(), false, false);
    for c in list.chars() {
        match c {
            '"' => quoted = !quoted,
            '<' if !quoted => angled = true,
            '>' if !quoted => angled = false,
            ',' if !quoted && !angled => {
                out.push(std::mem::take(&mut current));
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    out.push(current);
    out.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect()
}

fn iso(ms: i64) -> Option<String> {
    Utc.timestamp_millis_opt(ms).single().map(|t| t.format(FORMAT).to_string())
}

/// The cache fields of one Gmail message, or None when it has no usable id or date.
pub fn gmail_message(message: &Value) -> Option<Value> {
    let id = message["id"].as_str().filter(|id| !id.is_empty())?;
    let received = iso(message["internalDate"].as_str()?.parse().ok()?)?;
    let subject = header(message, "Subject").unwrap_or_else(|| "(no subject)".into());
    let snippet = message["snippet"].as_str().unwrap_or("").to_string();
    let mut recipients = Vec::new();
    for name in ["To", "Cc"] {
        if let Some(list) = header(message, name) {
            recipients.extend(split_addresses(&list));
        }
    }
    let references: Vec<String> = header(message, "References")
        .map(|r| r.split_whitespace().map(String::from).collect())
        .unwrap_or_default();
    let hidden = looks_like_one_time_code(&subject, &snippet);
    Some(json!({
        "externalId": id,
        "sender": header(message, "From").unwrap_or_else(|| "unknown".into()),
        "recipients": recipients,
        "subject": subject,
        "snippet": if hidden { Value::Null } else { json!(snippet) },
        "receivedAt": received,
        "receivedMs": message["internalDate"].as_str().and_then(|v| v.parse::<i64>().ok()),
        "labelIds": message["labelIds"].as_array().cloned().unwrap_or_default(),
        "historyId": message["historyId"],
        "threadId": message["threadId"],
        "messageId": header(message, "Message-ID"),
        "references": references,
    }))
}

fn when(side: &Value) -> Option<(String, bool)> {
    if let Some(date_time) = side["dateTime"].as_str() {
        let parsed = chrono::DateTime::parse_from_rfc3339(date_time).ok()?;
        return Some((parsed.with_timezone(&Utc).format(FORMAT).to_string(), false));
    }
    let day = side["date"].as_str()?;
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some((format!("{day}T00:00:00.000Z"), true))
}

fn attendee_names(event: &Value) -> Vec<String> {
    event["attendees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["self"] != true)
        .filter_map(|a| a["displayName"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.contains('@'))
        .map(|name| name.chars().take(ATTENDEE_CHARS).collect::<String>())
        .take(ATTENDEES_MAX)
        .collect()
}

/// The cache fields of one calendar event. A cancelled event, one without an id and one
/// without a readable start or end give None.
pub fn calendar_event(event: &Value) -> Option<Value> {
    let id = event["id"].as_str().filter(|id| !id.is_empty())?;
    if event["status"] == "cancelled" {
        return None;
    }
    let (starts, all_day) = when(&event["start"])?;
    let (ends, _) = when(&event["end"])?;
    let mut metadata = Map::new();
    metadata.insert("status".into(), event["status"].clone());
    metadata.insert("htmlLink".into(), event["htmlLink"].clone());
    metadata.insert("attendeeCount".into(), json!(event["attendees"].as_array().map_or(0, Vec::len)));
    metadata.insert("attendeeNames".into(), json!(attendee_names(event)));
    metadata.insert("allDay".into(), json!(all_day));
    Some(json!({
        "externalId": id,
        "event": {
            "title": event["summary"].as_str().filter(|t| !t.is_empty()).unwrap_or("(no title)"),
            "startsAt": starts, "endsAt": ends,
            "location": event["location"].as_str(),
            "summary": event["description"].as_str().map(|d| d.chars().take(SUMMARY_CHARS).collect::<String>()),
            "externalMetadata": metadata,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_keeps_headers_and_the_gmail_snippet_only() {
        let message = json!({
            "id":"m1","threadId":"t1","historyId":"42","internalDate":"1772442900000",
            "labelIds":["INBOX"],"snippet":"Lunch on Friday?",
            "payload":{"headers":[
                {"name":"From","value":"Ann <ann@example.com>"},
                {"name":"To","value":"\"Doe, Bob\" <bob@example.com>, cy@example.com"},
                {"name":"Cc","value":"di@example.com"},
                {"name":"Subject","value":"Lunch"},
                {"name":"Message-ID","value":"<a@x>"},
                {"name":"References","value":"<r1@x> <r2@x>"}],
              "body":{"data":"U0VDUkVULUJPRFk"}}
        });
        let parsed = gmail_message(&message).unwrap();
        assert_eq!(parsed["recipients"], json!(["\"Doe, Bob\" <bob@example.com>", "cy@example.com", "di@example.com"]));
        assert_eq!(parsed["references"], json!(["<r1@x>", "<r2@x>"]));
        assert_eq!(parsed["receivedAt"], "2026-03-02T09:15:00.000Z");
        assert!(!parsed.to_string().contains("SECRET"));
    }

    #[test]
    fn a_sign_in_code_message_keeps_no_snippet() {
        let message = json!({"id":"m","internalDate":"1","snippet":"Your verification code is 123456",
            "payload":{"headers":[{"name":"Subject","value":"Your verification code"}]}});
        assert!(gmail_message(&message).unwrap()["snippet"].is_null());
    }

    #[test]
    fn events_map_times_titles_and_attendees() {
        let event = json!({"id":"e1","status":"confirmed","summary":"","htmlLink":"https://x/e1",
            "start":{"date":"2026-03-05"},"end":{"date":"2026-03-06"},
            "attendees":[{"displayName":"Me","self":true},{"displayName":"Ann"},{"displayName":"a@b.c"},{"email":"z@z.z"}]});
        let parsed = calendar_event(&event).unwrap();
        assert_eq!(parsed["event"]["title"], "(no title)");
        assert_eq!(parsed["event"]["startsAt"], "2026-03-05T00:00:00.000Z");
        assert_eq!(parsed["event"]["externalMetadata"]["allDay"], true);
        assert_eq!(parsed["event"]["externalMetadata"]["attendeeNames"], json!(["Ann"]));
        assert_eq!(parsed["event"]["externalMetadata"]["attendeeCount"], 4);
    }

    #[test]
    fn cancelled_and_idless_events_are_skipped() {
        let times = json!({"start":{"dateTime":"2026-03-05T10:00:00+01:00"},"end":{"dateTime":"2026-03-05T11:00:00+01:00"}});
        let mut cancelled = times.clone();
        cancelled["id"] = json!("e");
        cancelled["status"] = json!("cancelled");
        assert!(calendar_event(&cancelled).is_none());
        assert!(calendar_event(&times).is_none());
        let mut live = times;
        live["id"] = json!("e");
        assert_eq!(calendar_event(&live).unwrap()["event"]["startsAt"], "2026-03-05T09:00:00.000Z");
    }
}
