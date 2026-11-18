//! Queues and their handlers. A job carries ids and a source kind only, never text. The host
//! adds the person to every job, and the handler reads whatever text it needs while it runs.
use crate::{extract, judge, util};
use chrono::{DateTime, Duration, SecondsFormat};
use moss_module_sdk::{Client, Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const EXTRACTION: &str = "commitments-extraction";
pub const EMAIL_JUDGEMENT: &str = "commitments-email-judgement";
/// A thread is judged once per burst of new mail, not once per message.
pub const DEBOUNCE_SECONDS: i64 = 180;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Value,
}

/// A stable id for a request, so asking again folds into the first request.
fn request_key(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash.finalize()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn actor<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["actorUserId"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host actor unavailable"))
}

/// The current window. A request key repeats inside one window and changes in the next, because
/// the queue keeps finished jobs and refuses a key it has already seen.
fn window<H: Host + ?Sized>(host: &H) -> Result<String> {
    let now = DateTime::parse_from_rfc3339(&crate::store::now(host)?).map_err(|_| Error::new("Host clock unavailable"))?;
    Ok((now.timestamp() / DEBOUNCE_SECONDS).to_string())
}

/// `POST /extract`. One request per person and source in each window.
pub fn enqueue_extraction<H: Host + ?Sized>(host: &H, source_kind: &str) -> Result<()> {
    let key = request_key(&["extract", &actor(host)?, source_kind, &window(host)?]);
    host.call(
        "jobs",
        "enqueue-options",
        EXTRACTION,
        json!({"params":{"source-kind":source_kind},"idempotencyKey":key,
               "availableAt":crate::store::now(host)?}),
    )?;
    Ok(())
}

/// Asks for a thread to be judged after the debounce. Another message in the same thread inside
/// the wait folds into this request.
pub fn request_thread_judgement<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let message = input["cacheMessageId"].as_str().filter(|m| util::is_uuid(m)).ok_or_else(|| Error::new("cacheMessageId must be an id"))?;
    let reply = Client(host).api("email", "replyContext", json!({"cacheMessageId": message}))?;
    let Some(thread) = reply["threadId"].as_str().filter(|t| !t.is_empty()) else {
        return Ok(json!({"queued": false}));
    };
    let key = request_key(&["email-thread", &actor(host)?, thread, &window(host)?]);
    let now = DateTime::parse_from_rfc3339(&crate::store::now(host)?).map_err(|_| Error::new("Host clock unavailable"))?;
    let at = (now + Duration::seconds(DEBOUNCE_SECONDS)).to_rfc3339_opts(SecondsFormat::Millis, true);
    host.call(
        "jobs",
        "enqueue-options",
        EMAIL_JUDGEMENT,
        json!({"params":{"message-id":message},"idempotencyKey":key,"availableAt":at}),
    )?;
    Ok(json!({"queued": true}))
}

/// Runs one job. The reply lists the warning events and nothing else.
pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    let warnings = match job.queue.as_str() {
        EXTRACTION => {
            let kind = job.parameters["source-kind"].as_str().ok_or_else(|| Error::new("Invalid extraction job"))?;
            extract::run(host, kind)?
        }
        EMAIL_JUDGEMENT => {
            let id = job.parameters["message-id"].as_str().filter(|m| util::is_uuid(m)).ok_or_else(|| Error::new("Invalid judgement job"))?;
            judge::run(host, id)?.1
        }
        _ => return Err(Error::new("Unknown Commitments job")),
    };
    Ok(serde_json::to_string(&json!({"warnings": warnings.iter().map(extract::Warning::to_json).collect::<Vec<_>>()}))?)
}
