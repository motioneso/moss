//! Approval cards for the chat-visible write and destructive routes, and the chat class of every
//! Part 1 route. A card never grants approval and never changes data.
use crate::preferences;
use crate::records::{Snapshot, RECORDS};
use crate::text::{bounded, is_uuid};
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// How chat treats each route. Reads are open; writes and the delete need approval.
pub const CHAT_CLASSES: [(&str, &str, &str); 8] = [
    ("GET", "/records", "read"),
    ("GET", "/records/:id", "read"),
    ("POST", "/records", "write"),
    ("PUT", "/records/:id/title", "write"),
    ("PUT", "/records/:id/notes", "write"),
    ("DELETE", "/records/:id", "destructive"),
    ("GET", "/preferences", "read"),
    ("PUT", "/preferences", "write"),
];

pub const REPEAT_NOTE: &str = "An identical retry uses the original result instead of repeating the change";
pub const DELETE_NOTE: &str = "This meeting, its retained notes, transcript, summaries, action reviews and export receipts, its linked Moss chats, exact source-linked note contributions and unsupported recording memories. Accepted Tasks and independent saved vault copies remain.";

fn version(value: &Value) -> String {
    let digest = Sha256::digest(serde_json::to_string(value).unwrap_or_default().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
fn field(label: &str, value: impl Into<Value>) -> Value {
    json!({"label":label,"value":value.into()})
}
fn object(text: Option<&str>) -> Option<Map<String, Value>> {
    match text {
        None => Some(Map::new()),
        Some(t) => serde_json::from_str::<Value>(t).ok()?.as_object().cloned(),
    }
}
/// Exactly the listed keys, with none missing and none extra.
fn exact(body: &Map<String, Value>, keys: &[&str]) -> bool {
    body.len() == keys.len() && keys.iter().all(|k| body.contains_key(*k))
}
fn title_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|t| bounded(t, 240, true))
}
fn mode_label(value: &str) -> Option<&'static str> {
    Some(match value {
        "microphone-only" => "Microphone only",
        "selected-app" => "Selected app and microphone",
        "computer-audio" => "Computer audio and microphone",
        _ => return None,
    })
}

pub fn prepare<H: Host + ?Sized>(
    host: &H,
    route: &str,
    params: Option<&str>,
    query: Option<&str>,
    body: Option<&str>,
) -> Result<Option<Value>> {
    let (Some(params), Some(query), Some(body)) = (object(params), object(query), object(body)) else {
        return Ok(None);
    };
    if !query.is_empty() {
        return Ok(None);
    }
    let meeting_id = params.get("id").and_then(Value::as_str).filter(|id| is_uuid(id));
    let with_id = params.len() == 1 && meeting_id.is_some();
    let title_of = |id: &str| -> Result<Option<Value>> {
        let mut find = Query::select(Filter::eq("id", id));
        find.limit = Some(1);
        Ok(Client(host).query(RECORDS, &find)?.into_iter().next())
    };
    Ok(match route {
        "createRecord" if params.is_empty() && exact(&body, &["requestKey", "title"]) => {
            let key_ok = body["requestKey"].as_str().is_some_and(is_uuid);
            let Some(title) = title_text(&body["title"]).filter(|_| key_ok) else { return Ok(None) };
            Some(json!({"title":"Create a meeting draft","content":"user_authored","target":title,
                "fields":[field("Repeated request", REPEAT_NOTE), field("Title", title)],
                "version":version(&Value::Object(body.clone()))}))
        }
        "putTitle" if with_id && exact(&body, &["expectedTitle", "title"]) => {
            let (Some(current), Some(next)) = (title_text(&body["expectedTitle"]), title_text(&body["title"])) else { return Ok(None) };
            let Some(row) = title_of(meeting_id.unwrap_or_default())? else { return Ok(None) };
            let meeting = Snapshot::from_row(&row)?;
            Some(json!({"title":"Rename your meeting","content":"user_authored","target":meeting.title,
                "fields":[field("Current title", current), field("New title", next)],
                "version":version(&json!([meeting.dto(), body]))}))
        }
        "putNotes" if with_id && exact(&body, &["requestKey", "expectedRevision", "personalNotes"]) => {
            let revision = body["expectedRevision"].as_u64().filter(|r| *r < 2_147_483_647);
            let notes = body["personalNotes"].as_str().filter(|n| bounded(n, 64_000, false));
            let (true, Some(revision), Some(notes)) = (body["requestKey"].as_str().is_some_and(is_uuid), revision, notes) else { return Ok(None) };
            let Some(row) = title_of(meeting_id.unwrap_or_default())? else { return Ok(None) };
            let meeting = Snapshot::from_row(&row)?;
            Some(json!({"title":"Save your meeting notes","target":meeting.title,
                "fields":[field("Repeated request", REPEAT_NOTE), field("Based on notes revision", revision.to_string()), field("Personal notes", notes)],
                "version":version(&json!([meeting.dto(), body]))}))
        }
        "deleteRecord" if with_id && body.is_empty() => {
            let Some(row) = title_of(meeting_id.unwrap_or_default())? else { return Ok(None) };
            let meeting = Snapshot::from_row(&row)?;
            Some(json!({"title":"Delete meeting, retained records and linked Moss chats","content":"user_authored",
                "target":meeting.title,"fields":[field("Delete", DELETE_NOTE)],"version":version(&meeting.dto())}))
        }
        "putPreferences" if params.is_empty() && !body.is_empty() => preferences_card(host, &body)?,
        _ => None,
    })
}

/// A remembered recording source is checked against the linked Mac, which a later part supplies.
/// Until then only clearing it can be shown, so a card for choosing one is refused.
fn preferences_card<H: Host + ?Sized>(host: &H, body: &Map<String, Value>) -> Result<Option<Value>> {
    if body.get("rememberedSource").is_some_and(|v| !v.is_null()) {
        return Ok(None);
    }
    let current = preferences::current(host)?;
    let mut fields: Vec<Value> = Vec::new();
    let mut changes: Vec<&str> = Vec::new();
    if let Some(value) = body.get("transcriptVocabulary") {
        let Ok(next) = preferences::normalize_vocabulary(value) else { return Ok(None) };
        let language = body.get("transcriptLanguage").unwrap_or(&current["transcriptLanguage"]);
        if !next.is_empty() && language.is_null() {
            return Ok(None);
        }
        let before: Vec<String> = current["transcriptVocabulary"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let list = |label: &str, terms: &[String], none: &str| -> Vec<Value> {
            if terms.is_empty() { vec![field(&label.replace(" spelling", ""), none)] }
            else { terms.iter().enumerate().map(|(i, t)| field(&format!("{label} {}", i + 1), t.as_str())).collect() }
        };
        fields.extend(list("Before spelling", &before, "No vocabulary hint"));
        fields.extend(list("After spelling", &next, "No vocabulary hint"));
        fields.push(field("Applies to", "Upcoming meeting transcription and normal imports; selected audio service may ignore hints. Existing text and hold stay unchanged."));
        changes.push("Change transcript vocabulary");
    }
    if let Some(value) = body.get("transcriptLanguage") {
        let shown = match value.as_str() {
            None if value.is_null() => "Automatic detection".to_owned(),
            Some(code) if preferences::is_language(code) => code.to_owned(),
            _ => return Ok(None),
        };
        fields.push(field("Transcript language", shown));
        changes.push("Change the transcript language");
    }
    if let Some(value) = body.get("defaultCaptureMode") {
        let source_mode = current["rememberedSource"]["mode"].as_str().unwrap_or("computer-audio");
        let shown = mode_label(value.as_str().unwrap_or(source_mode));
        let Some(shown) = shown.filter(|_| value.is_null() || value.is_string()) else { return Ok(None) };
        fields.push(field("Default capture source", shown));
        changes.push("Change the default recording audio");
    }
    if let Some(value) = body.get("summarizeOnStop") {
        let Some(on) = value.as_bool() else { return Ok(None) };
        fields.push(field("Summarize automatically after Stop", if on { "On" } else { "Off" }));
        changes.push(if on { "Turn on automatic summaries" } else { "Turn off automatic summaries" });
    }
    if let Some(value) = body.get("summaryTemplateId") {
        let name = match value.as_str() {
            Some("general") => "General",
            Some("one-to-one") => "One-to-one",
            Some("project-review") => "Project review",
            Some("interview") => "Interview",
            _ => return Ok(None),
        };
        fields.push(field("Summary style", name));
        changes.push("Change the summary style");
    }
    if body.contains_key("rememberedSource") {
        fields.push(field("Remembered recording source", "Clear the saved Mac, microphone and application"));
        changes.push("Clear the saved recording source");
    }
    if fields.is_empty() || body.keys().any(|k| !preferences::FIELDS.contains(&k.as_str())) {
        return Ok(None);
    }
    Ok(Some(json!({"title":changes.join("; "),"content":"user_authored","target":"Meeting capture preferences",
        "fields":fields,"version":version(&json!([body, current]))})))
}

pub fn handle<H: Host + ?Sized>(host: &H, route: &str, params: Option<&str>, query: Option<&str>, body: Option<&str>) -> Value {
    match prepare(host, route, params, query, body) {
        Ok(card) => json!({"ok":card}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Meetings service is unavailable"}}),
    }
}
