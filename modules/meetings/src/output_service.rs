//! Generating, editing and storing summaries. One call is one transaction under the meeting's row
//! lock, so reserve, model call and save happen together and no second caller can interleave.
use crate::output_run::{self, Model, ModelFail};
use crate::output_validation::{template, validate, Content};
use crate::outputs::{self, Current};
use moss_module_sdk::{Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// How long a reservation stays valid. Longer than the model deadline, so a finished run is kept.
const RESERVATION_SECONDS: i64 = 660;
const MAX_VERSION: i64 = 1000;
const MAX_CANDIDATES: usize = 1000;
const MAX_WARNINGS: usize = 47;
const MAX_OUTPUT_TOKENS: i64 = 8192;

/// A status and body, ready for the route.
pub type Answer = (u16, Value);

pub fn refuse(status: u16, code: &str) -> Answer {
    (status, json!({"code": code}))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generate {
    pub request_key: String,
    pub expected_output_version: i64,
    pub expected_transcript_revision: i64,
    pub expected_notes_revision: i64,
    pub template_id: String,
    pub template_version: i64,
}
impl Generate {
    fn encoded(&self) -> Value {
        json!({"kind": "generate", "requestKey": self.request_key,
            "expectedOutputVersion": self.expected_output_version,
            "expectedTranscriptRevision": self.expected_transcript_revision,
            "expectedNotesRevision": self.expected_notes_revision,
            "templateId": self.template_id, "templateVersion": self.template_version})
    }
}

/// The model call: the host's `ai` port, answered by whichever model the person configured.
struct Router<'a, H: ?Sized>(&'a H);
impl<H: Host + ?Sized> Model for Router<'_, H> {
    fn generate(&self, prompt: &str) -> std::result::Result<String, ModelFail> {
        match self.0.call("ai", "generate", "summarization", json!({"prompt": prompt, "maxOutputTokens": MAX_OUTPUT_TOKENS})) {
            Ok(reply) => reply["text"].as_str().map(str::to_owned).ok_or(ModelFail::Failed),
            Err(error) if error.to_string().to_lowercase().contains("deadline") => Err(ModelFail::TimedOut),
            Err(_) => Err(ModelFail::Failed),
        }
    }
}

fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    Ok(context["now"].as_str().unwrap_or_default().to_owned())
}

fn new_id<H: Host + ?Sized>(host: &H) -> Result<String> {
    let id = host.call("context", "uuid", "new", json!({}))?;
    Ok(id["id"].as_str().unwrap_or_default().to_owned())
}

fn finish<H: Host + ?Sized>(host: &H, meeting: &str, key: &str, result: &Value) -> Result<()> {
    outputs::call(
        host,
        "finish",
        meeting,
        json!({"requestKey": key, "resultJson": result.to_string(),
            "status": result["status"].as_str(), "code": result["code"].as_str()}),
    )?;
    Ok(())
}

fn reserve<H: Host + ?Sized>(host: &H, meeting: &str, key: &str, encoded: &Value, ttl: Option<i64>) -> Result<()> {
    outputs::call(
        host,
        "reserve",
        meeting,
        json!({"requestKey": key, "inputJson": encoded.to_string(), "kind": encoded["kind"].as_str(), "ttlSeconds": ttl}),
    )?;
    Ok(())
}

pub enum Saved {
    Done(Value),
    Limit,
}

/// Writes the next artifact version and its action candidates.
fn save<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    base: &Value,
    content: &Content,
    origin: &str,
    stale: bool,
) -> Result<Saved> {
    let next = outputs::call(host, "next", meeting, json!({}))?;
    let version = next["version"].as_i64().unwrap_or(1);
    if version > MAX_VERSION {
        return Ok(Saved::Limit);
    }
    let existing = next["candidateIds"].as_array().map_or(0, Vec::len);
    if !stale && existing + content.actions.len() > MAX_CANDIDATES {
        return Ok(Saved::Limit);
    }
    let id = new_id(host)?;
    let content_value = serde_json::to_value(content)?;
    let mut artifact = base.clone();
    artifact["id"] = json!(id);
    artifact["version"] = json!(version);
    artifact["content"] = content_value;
    artifact["origin"] = json!(origin);
    artifact["stale"] = json!(stale);
    artifact["createdAt"] = json!(now(host)?);
    let actions: Vec<Value> = content
        .actions
        .iter()
        .map(|action| {
            let text = serde_json::to_string(action).unwrap_or_default();
            json!({"identity": format!("{:x}", Sha256::digest(text.as_bytes())), "proposalJson": text})
        })
        .collect();
    outputs::call(
        host,
        "save",
        meeting,
        json!({"id": id, "version": version, "artifactJson": artifact.to_string(),
            "overview": outputs::overview_text(&content.overview), "origin": origin,
            "notesRevision": artifact["inputs"]["notesRevision"],
            "transcriptRevision": artifact["inputs"]["transcript"]["transcriptRevision"].as_i64().unwrap_or(0),
            "stale": stale, "actions": actions}),
    )?;
    Ok(Saved::Done(artifact))
}

fn failed(key: &str, code: &str) -> Value {
    json!({"status": "failed", "requestKey": key, "code": code})
}

fn conflict(version: i64, now: Option<&Current>) -> Answer {
    let mut versions = json!({"outputVersion": version});
    if let Some(now) = now {
        versions["notesRevision"] = json!(now.notes_revision);
        versions["transcriptRevision"] = json!(now.transcript_revision);
    }
    (409, json!({"code": "meeting_output_version_conflict", "currentVersions": versions}))
}

/// Looks up an earlier attempt under this key. `Some` is the answer to give instead of a new run.
fn earlier<H: Host + ?Sized>(host: &H, meeting: &str, key: &str, encoded: &Value) -> Result<Option<Answer>> {
    let found = outputs::call(host, "request", meeting, json!({"requestKey": key}))?;
    if found["found"] != true {
        return Ok(None);
    }
    let same = found["inputJson"].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()).as_ref() == Some(encoded);
    if !same {
        return Ok(Some(refuse(409, "meeting_output_request_conflict")));
    }
    let result = match found["resultJson"].as_str() {
        Some(text) => outputs::parse(text)?,
        None if found["expired"] == true => {
            let interrupted = failed(key, "meeting_output_interrupted");
            finish(host, meeting, key, &interrupted)?;
            interrupted
        }
        None => return Ok(Some((202, json!({"status": "pending", "requestKey": key})))),
    };
    Ok(Some(match result["status"].as_str() {
        Some("saved") => {
            let mut replay = result.clone();
            replay["replayed"] = json!(true);
            (200, replay)
        }
        Some("failed") => (422, result),
        _ => (200, result),
    }))
}

/// Runs one generation under the meeting lock. `None` means the meeting is not visible.
pub fn generate<H: Host + ?Sized>(host: &H, meeting: &str, input: &Generate) -> Result<Answer> {
    let Some(chosen) = template(&input.template_id, input.template_version) else {
        return Ok(refuse(400, "meeting_output_invalid_input"));
    };
    let Some(now) = outputs::inputs(host, meeting, true)? else {
        return Ok(refuse(404, "meeting_not_found"));
    };
    let encoded = input.encoded();
    if let Some(answer) = earlier(host, meeting, &input.request_key, &encoded)? {
        return Ok(answer);
    }
    let pending = outputs::call(host, "expire-pending", meeting, json!({}))?;
    if pending["pendingKey"].is_string() {
        return Ok(refuse(409, "meeting_output_busy"));
    }
    let head = outputs::head(host, meeting)?;
    let head_version = head.as_ref().and_then(|h| h["version"].as_i64()).unwrap_or(0);
    if head_version != input.expected_output_version
        || now.notes_revision != input.expected_notes_revision
        || now.transcript_revision != input.expected_transcript_revision
    {
        return Ok(conflict(head_version, Some(&now)));
    }
    if !now.has_notes && now.segment_count == 0 {
        return Ok(refuse(400, "meeting_output_evidence_unavailable"));
    }
    let key = input.request_key.as_str();
    let generated = output_run::generate(&Router(host), &now.inputs, chosen.id, chosen.version);
    let generated = match generated {
        Err(error) if error.bad_request => return Ok(refuse(400, &error.code)),
        other => other,
    };
    reserve(host, meeting, key, &encoded, Some(RESERVATION_SECONDS))?;
    let outcome = match generated {
        Err(error) => failed(key, &error.code),
        Ok(done) => store_generated(host, meeting, input, &now, done.content, done.model_route)?,
    };
    finish(host, meeting, key, &outcome)?;
    let status = if outcome["status"] == "failed" { 422 } else { 200 };
    Ok((status, outcome))
}

fn store_generated<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    input: &Generate,
    now: &Current,
    mut content: Content,
    model_route: &str,
) -> Result<Value> {
    let key = input.request_key.as_str();
    content.warnings.truncate(MAX_WARNINGS);
    if now.omitted {
        content.warnings.push("Some retained transcript segments were omitted from this bounded input.".into());
    }
    if now.provisional {
        content.warnings.push("This output includes provisional transcript evidence.".into());
    }
    content.warnings.push("Capture gaps and participant attribution have not been independently verified.".into());
    let checked = match validate(&serde_json::to_value(&content)?, &now.inputs) {
        Ok(valid) => valid,
        Err(reason) => return Ok(failed(key, &format!("meeting_output_rejected_{}", reason.code()))),
    };
    let base = json!({"meetingId": meeting, "inputs": now.stored, "templateId": input.template_id,
        "templateVersion": input.template_version, "modelRoute": model_route});
    // The summary and its inputs were read under one lock, so it is current when stored.
    Ok(match save(host, meeting, &base, &checked, "generated", false)? {
        Saved::Done(artifact) => json!({"status": "saved", "artifact": artifact, "replayed": false}),
        Saved::Limit => failed(key, "meeting_output_limit"),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub request_key: String,
    pub expected_output_version: i64,
    pub content: Value,
}

/// Replaces the newest summary with the person's own edit, as a new version.
pub fn edit<H: Host + ?Sized>(host: &H, meeting: &str, input: &Edit) -> Result<Answer> {
    if outputs::inputs(host, meeting, true)?.is_none() {
        return Ok(refuse(404, "meeting_not_found"));
    }
    let encoded = json!({"kind": "edit", "requestKey": input.request_key,
        "expectedOutputVersion": input.expected_output_version, "content": input.content});
    let found = outputs::call(host, "request", meeting, json!({"requestKey": input.request_key}))?;
    if found["found"] == true {
        let same = found["inputJson"].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()).as_ref() == Some(&encoded);
        if !same {
            return Ok(refuse(409, "meeting_output_request_conflict"));
        }
        if let Some(text) = found["resultJson"].as_str() {
            return Ok((200, outputs::parse(text)?));
        }
    }
    let head = outputs::head(host, meeting)?;
    let Some(head) = head.filter(|h| h["version"].as_i64() == Some(input.expected_output_version)) else {
        let version = outputs::head(host, meeting)?.and_then(|h| h["version"].as_i64()).unwrap_or(0);
        return Ok(conflict(version, None));
    };
    let Ok(content) = validate(&input.content, &outputs::stored_inputs(&head)) else {
        return Ok(refuse(400, "meeting_output_invalid_input"));
    };
    reserve(host, meeting, &input.request_key, &encoded, None)?;
    let mut base = head.clone();
    for key in ["id", "version", "createdAt"] {
        base.as_object_mut().map(|m| m.remove(key));
    }
    match save(host, meeting, &base, &content, "manual", false)? {
        Saved::Done(artifact) => {
            finish(host, meeting, &input.request_key, &artifact)?;
            Ok((200, artifact))
        }
        // The old app threw its limit error here, which is not a stored result.
        Saved::Limit => Ok(refuse(400, "meeting_output_limit")),
    }
}
