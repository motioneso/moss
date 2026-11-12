//! IMAP mail sync, package side. A job lists the inbox through the host, compares the
//! listing with what Email has cached, fetches what is new or changed, writes it through
//! Email's public API, then removes cached mail the server no longer lists and records the
//! outcome. The host owns the network and the password, and no message text is kept here.
use crate::{kv, Result};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

pub const QUEUE: &str = "imap-sync";
/// The folder the host syncs.
const FOLDER: &str = "INBOX";
const CRON: &str = "*/15 * * * *";
/// Messages compared and fetched per job run. Each run relists, so a smaller step costs
/// more listings and a larger one risks the per-call time limit.
const STEP: usize = 50;
/// Messages fetched in one host call.
const BATCH: usize = 25;

/// Percent-encodes like JavaScript's `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The cache key of one message, stable while the server keeps its UID numbering.
pub fn message_key(folder: &str, uid_validity: u64, uid: u32) -> String {
    format!("imap:{}:{uid_validity}:{uid}", encode_component(folder))
}

/// The folder, UID validity and UID inside a message key.
pub fn parse_message_key(key: &str) -> Option<(String, u64, u32)> {
    let mut parts = key.strip_prefix("imap:")?.split(':');
    let folder = decode_component(parts.next()?)?;
    let validity = parts.next()?.parse().ok()?;
    let uid = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((folder, validity, uid))
}

fn job_params(account: &str, cursor: u64, upserted: u64, failures: u64) -> Value {
    json!({"account-id":account,"cursor":cursor,"upserted":upserted,"failures":failures})
}

/// Keeps one fifteen-minute sync schedule per mail account. The account id is the key, so a
/// repeat call replaces the row. A scheduling failure never fails the caller.
pub fn reconcile_schedule(host: &impl Host, account: &str) {
    let _ = schedule(host, account);
}

fn schedule(host: &impl Host, account: &str) -> Result<Value> {
    Ok(host.call(
        "jobs",
        "schedule",
        QUEUE,
        json!({"cron":CRON,"timezone":"UTC","key":account,"params":job_params(account, 0, 0, 0)}),
    )?)
}

/// Stops the account's schedule. The keyed schedule call is idempotent and returns the
/// stable row id to cancel.
pub fn cancel_schedule(host: &impl Host, account: &str) {
    let Ok(saved) = schedule(host, account) else { return };
    if let Some(id) = saved["id"].as_str() {
        let _ = host.call("jobs", "unschedule", QUEUE, json!({"id":id}));
    }
}

/// Starts a first sync now instead of waiting for the next quarter hour.
pub fn sync_soon(host: &impl Host, account: &str) {
    let _ = enqueue(host, job_params(account, 0, 0, 0));
}

fn enqueue(host: &impl Host, params: Value) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    let key = host.call("context", "uuid", "new", json!({}))?;
    host.call(
        "jobs",
        "enqueue-options",
        QUEUE,
        json!({"params":params,"idempotencyKey":key["id"],"availableAt":context["now"]}),
    )?;
    Ok(())
}

pub fn is_mail_provider(provider: &str) -> bool {
    provider.starts_with("imap-")
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid mail sync job")?;
    if job["queue"] != QUEUE {
        return Err("Connectors job is unavailable".into());
    }
    let p = &job["parameters"];
    let (Some(account), Some(cursor), Some(upserted), Some(failures)) = (
        p["account-id"].as_str(),
        p["cursor"].as_u64(),
        p["upserted"].as_u64(),
        p["failures"].as_u64(),
    ) else {
        return Err("Invalid mail sync job".into());
    };
    let outcome = step(host, account, cursor, upserted, failures);
    Ok(json!({"outcome":outcome}).to_string())
}

fn finish(host: &impl Host, account: &str, status: &str, error: Option<&str>, upserted: u64, failures: u64, truncated: bool) {
    let _ = kv(
        host,
        "set",
        "connectors.imap-sync-finish",
        json!({
            "accountId":account,"status":status,"error":error,
            "counts":{"emailUpserted":upserted,"emailFailures":failures,"truncated":truncated},
        }),
    );
}

/// One run of the job. Returns a short word for the job result. A host failure ends the
/// run as failed instead of retrying, so a broken server is not hit again at once.
fn step(host: &impl Host, account: &str, cursor: u64, upserted: u64, failures: u64) -> &'static str {
    if cursor == 0 {
        match kv(host, "set", "connectors.imap-sync-start", json!({"accountId":account})) {
            Ok(started) => match started["state"].as_str() {
                Some("started") => reconcile_schedule(host, account),
                Some("busy") => return "busy",
                _ => {
                    cancel_schedule(host, account);
                    return "inactive";
                }
            },
            Err(_) => return "failed",
        }
    }
    match run_step(host, account, cursor as usize, upserted, failures) {
        Ok(outcome) => outcome,
        Err(_) => {
            finish(host, account, "failed", Some("email-error"), upserted, failures, false);
            "failed"
        }
    }
}

fn run_step(host: &impl Host, account: &str, cursor: usize, mut upserted: u64, mut failures: u64) -> Result<&'static str> {
    let listing = kv(host, "get", "connectors.imap-list", json!({"accountId":account}))?;
    match listing["result"].as_str() {
        None => {}
        Some("inactive") => {
            cancel_schedule(host, account);
            return Ok("inactive");
        }
        Some("auth_failed") => {
            finish(host, account, "failed", Some("auth-error"), upserted, failures, false);
            return Ok("auth-error");
        }
        Some(_) => {
            finish(host, account, "failed", Some("email-error"), upserted, failures, false);
            return Ok("failed");
        }
    }
    let validity = listing["uidValidity"].as_u64().unwrap_or(0);
    let truncated = listing["truncated"].as_bool().unwrap_or(false);
    let entries: Vec<(u32, u64)> = listing["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| Some((u32::try_from(k["uid"].as_u64()?).ok()?, k["size"].as_u64().unwrap_or(0))))
        .collect();
    let key = |uid: u32| message_key(FOLDER, validity, uid);
    let window: Vec<&(u32, u64)> = entries.iter().skip(cursor).take(STEP).collect();
    let ids: Vec<String> = window.iter().map(|(uid, _)| key(*uid)).collect();
    let cached = Client(host).api("email", "listCachedMessageKeys", json!({"connectorAccountId":account,"externalIds":ids}))?;
    let size_of = |id: &str| {
        cached["keys"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|k| k["externalId"] == id)
            .map(|k| k["sizeBytes"].as_u64())
    };
    let todo: Vec<u32> = window
        .iter()
        .filter(|(uid, size)| size_of(&key(*uid)).map_or(true, |known| known != Some(*size)))
        .map(|(uid, _)| *uid)
        .collect();
    for batch in todo.chunks(BATCH) {
        let fetched = kv(host, "get", "connectors.imap-fetch", json!({"accountId":account,"uidValidity":validity,"uids":batch}))?;
        if fetched["result"].is_string() {
            // The mailbox was rebuilt between the listing and the fetch, so the next run starts over.
            failures += batch.len() as u64;
            continue;
        }
        failures += fetched["failed"].as_array().map_or(0, |f| f.len() as u64);
        for message in fetched["messages"].as_array().into_iter().flatten() {
            let Some(uid) = message["uid"].as_u64().and_then(|u| u32::try_from(u).ok()) else { continue };
            if message["unreadable"] == true {
                failures += 1;
                continue;
            }
            let stored = Client(host).api(
                "email",
                "insertCachedMessage",
                json!({
                    "connectorAccountId":account,"externalId":key(uid),"sender":message["sender"],
                    "recipients":message["recipients"],"subject":message["subject"],
                    "snippet":message["snippet"],"receivedAt":message["receivedAt"],
                    "externalMetadata":{
                        "messageId":message["messageId"],"references":message["references"],
                        "sizeBytes":message["sizeBytes"],
                    },
                }),
            );
            match stored {
                Ok(_) => upserted += 1,
                Err(_) => failures += 1,
            }
        }
    }
    let next = cursor + STEP;
    if next < entries.len() {
        enqueue(host, job_params(account, next as u64, upserted, failures))?;
        return Ok("continued");
    }
    // Only a complete listing proves a cached message is gone from the server.
    if !truncated {
        let keep: Vec<String> = entries.iter().map(|(uid, _)| key(*uid)).collect();
        Client(host).api(
            "email",
            "pruneCachedMessages",
            json!({"connectorAccountId":account,"prefix":"imap:","since":listing["since"],"keep":keep}),
        )?;
    }
    let (status, error) = if failures == 0 { ("success", None) } else { ("partial", Some("email-message-error")) };
    finish(host, account, status, error, upserted, failures, truncated);
    Ok("done")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_matches_javascript_encoding() {
        assert_eq!(message_key("INBOX", 1, 42), "imap:INBOX:1:42");
        assert_eq!(message_key("Sent Items/2026", 7, 3), "imap:Sent%20Items%2F2026:7:3");
        assert_eq!(message_key("Entw\u{fc}rfe", 7, 3), "imap:Entw%C3%BCrfe:7:3");
        assert_eq!(message_key("a:b(c)!~*'.-_", 9, 1), "imap:a%3Ab(c)!~*'.-_:9:1");
    }

    #[test]
    fn key_round_trips() {
        for folder in ["INBOX", "Sent Items/2026", "Entw\u{fc}rfe", "a:b%c"] {
            let key = message_key(folder, 123456, 99);
            assert_eq!(parse_message_key(&key), Some((folder.to_string(), 123456, 99)));
        }
        assert_eq!(parse_message_key("gmail:1"), None);
        assert_eq!(parse_message_key("imap:INBOX:1"), None);
        assert_eq!(parse_message_key("imap:INBOX:1:2:3"), None);
    }
}
