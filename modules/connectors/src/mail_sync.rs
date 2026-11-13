//! IMAP mail sync, package side. A job lists the inbox through the host, compares the
//! listing with what Email has cached, fetches what is new or changed, writes it through
//! Email's public API, then removes cached mail the server no longer lists and records the
//! outcome. The host owns the network and the password, and no message text is kept here.
use crate::{kv, refresh, Result};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

pub const QUEUE: &str = "imap-sync";
/// A refresh the person asked for runs the same sync on its own queue, so the outcome can be
/// recorded against the refresh.
pub const REFRESH_QUEUE: &str = "email-refresh-imap";
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

/// The queue and parameters of a job, with the refresh id only on the refresh queue.
fn queued(account: &str, cursor: u64, upserted: u64, failures: u64, refresh: Option<&str>) -> (&'static str, Value) {
    let mut params = job_params(account, cursor, upserted, failures);
    match refresh {
        Some(id) => {
            params["refresh-id"] = json!(id);
            (REFRESH_QUEUE, params)
        }
        None => (QUEUE, params),
    }
}

/// Starts a mail-only sync for a refresh.
pub fn refresh_first(account: &str, refresh: &str) -> (&'static str, Value) {
    queued(account, 0, 0, 0, Some(refresh))
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
    enqueue_on(host, QUEUE, params)
}

fn enqueue_on(host: &impl Host, queue: &str, params: Value) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    let key = host.call("context", "uuid", "new", json!({}))?;
    host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":params,"idempotencyKey":key["id"],"availableAt":context["now"]}),
    )?;
    Ok(())
}

pub fn is_mail_provider(provider: &str) -> bool {
    provider.starts_with("imap-")
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid mail sync job")?;
    let refresh = match job["queue"].as_str() {
        Some(QUEUE) => None,
        Some(REFRESH_QUEUE) => Some(job["parameters"]["refresh-id"].as_str().ok_or("Invalid mail sync job")?),
        _ => return Err("Connectors job is unavailable".into()),
    };
    let p = &job["parameters"];
    let (Some(account), Some(cursor), Some(upserted), Some(failures)) = (
        p["account-id"].as_str(),
        p["cursor"].as_u64(),
        p["upserted"].as_u64(),
        p["failures"].as_u64(),
    ) else {
        return Err("Invalid mail sync job".into());
    };
    if let Some(id) = refresh {
        if cursor == 0 && !refresh::begin(host, id, account, "imap").map_err(|e| e.message)? {
            return Ok(json!({"outcome":"skipped"}).to_string());
        }
    }
    let outcome = step(host, account, cursor, upserted, failures, refresh);
    if let Some(id) = refresh {
        match outcome {
            // The account is mid-sync or the host failed, so a queue retry tries again. A stuck
            // row is failed by the refresh sweep.
            "busy" | "failed" if cursor == 0 => return Err("Mail sync is not ready".into()),
            "inactive" => refresh::finish(host, id, account, "failed", Some("no-active-connection"), 0, 0),
            _ => {}
        }
    }
    Ok(json!({"outcome":outcome}).to_string())
}

fn finish(host: &impl Host, account: &str, status: &str, error: Option<&str>, upserted: u64, failures: u64, truncated: bool, refresh: Option<&str>) {
    let _ = kv(
        host,
        "set",
        "connectors.imap-sync-finish",
        json!({
            "accountId":account,"status":status,"error":error,
            "counts":{"emailUpserted":upserted,"emailFailures":failures,"truncated":truncated},
        }),
    );
    if let Some(id) = refresh {
        let (status, error) = refresh::outcome(error.unwrap_or("none"));
        refresh::finish(host, id, account, status, error, upserted, failures);
    }
}

/// One run of the job. Returns a short word for the job result. A host failure ends the
/// run as failed instead of retrying, so a broken server is not hit again at once.
fn step(host: &impl Host, account: &str, cursor: u64, upserted: u64, failures: u64, refresh: Option<&str>) -> &'static str {
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
    match run_step(host, account, cursor as usize, upserted, failures, refresh) {
        Ok(outcome) => outcome,
        Err(_) => {
            finish(host, account, "failed", Some("email-error"), upserted, failures, false, refresh);
            "failed"
        }
    }
}

fn run_step(host: &impl Host, account: &str, cursor: usize, mut upserted: u64, mut failures: u64, refresh: Option<&str>) -> Result<&'static str> {
    let listing = kv(host, "get", "connectors.imap-list", json!({"accountId":account}))?;
    match listing["result"].as_str() {
        None => {}
        Some("inactive") => {
            cancel_schedule(host, account);
            return Ok("inactive");
        }
        Some("auth_failed") => {
            finish(host, account, "failed", Some("auth-error"), upserted, failures, false, refresh);
            return Ok("auth-error");
        }
        Some(_) => {
            finish(host, account, "failed", Some("email-error"), upserted, failures, false, refresh);
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
                        "sizeBytes":message["sizeBytes"],"arrivedAt":message["arrivedAt"],
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
        let (queue, params) = queued(account, next as u64, upserted, failures, refresh);
        enqueue_on(host, queue, params)?;
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
    finish(host, account, status, error, upserted, failures, truncated, refresh);
    Ok("done")
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::Error;
    use std::cell::RefCell;

    /// Scripted host: a server listing, an Email cache, and a record of every call.
    struct Script {
        listing: Value,
        cached: Vec<(String, u64)>,
        calls: RefCell<Vec<(String, String, Value)>>,
        start: &'static str,
    }

    impl Script {
        fn new(uids: &[(u32, u64)]) -> Self {
            let keys: Vec<Value> = uids.iter().map(|(u, s)| json!({"uid":u,"size":s})).collect();
            Self {
                listing: json!({"uidValidity":7,"truncated":false,"since":"2026-01-01T00:00:00.000Z","keys":keys}),
                cached: vec![],
                calls: RefCell::default(),
                start: "started",
            }
        }
        fn named(&self, resource: &str) -> Vec<Value> {
            self.calls.borrow().iter().filter(|c| c.1 == resource).map(|c| c.2.clone()).collect()
        }
    }

    impl Host for Script {
        fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> moss_module_sdk::Result<Value> {
            let name = match (port, resource) {
                ("api", _) => p["name"].as_str().unwrap().to_string(),
                _ => resource.to_string(),
            };
            self.calls.borrow_mut().push((port.into(), name.clone(), p.clone()));
            Ok(match name.as_str() {
                "connectors.imap-sync-start" => json!({"state":self.start}),
                "connectors.imap-list" => self.listing.clone(),
                "connectors.imap-fetch" => {
                    let messages: Vec<Value> = p["uids"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|u| json!({"uid":u,"sender":"a@example.com","recipients":["b@example.com"],"subject":"Hi","snippet":"SECRET-BODY","receivedAt":"2026-01-02T00:00:00.000Z","messageId":"<m@x>","references":[],"sizeBytes":10}))
                        .collect();
                    json!({"messages":messages,"failed":[]})
                }
                "listCachedMessageKeys" => {
                    let wanted = p["parameters"]["externalIds"].as_array().unwrap();
                    let keys: Vec<Value> = self
                        .cached
                        .iter()
                        .filter(|(id, _)| wanted.iter().any(|w| w == id))
                        .map(|(id, size)| json!({"externalId":id,"sizeBytes":size}))
                        .collect();
                    json!({"keys":keys})
                }
                "context" | "read" => json!({"now":"2026-01-01T00:00:00.000Z"}),
                _ => match (port, operation) {
                    ("context", "uuid") => json!({"id":"k"}),
                    ("jobs", "schedule") => json!({"id":"row-1"}),
                    _ => json!({}),
                },
            })
        }
    }

    fn job(cursor: u64) -> String {
        json!({"queue":QUEUE,"parameters":job_params("acct", cursor, 0, 0)}).to_string()
    }

    #[test]
    fn a_small_mailbox_syncs_in_one_run_and_prunes() {
        let host = Script::new(&[(1, 10), (2, 10)]);
        let out = handle(&host, &job(0)).unwrap();
        assert!(out.contains("done"));
        assert_eq!(host.named("insertCachedMessage").len(), 2);
        let prune = host.named("pruneCachedMessages");
        assert_eq!(prune.len(), 1);
        assert_eq!(prune[0]["parameters"]["keep"], json!(["imap:INBOX:7:1", "imap:INBOX:7:2"]));
        let finish = host.named("connectors.imap-sync-finish");
        assert_eq!(finish[0]["status"], "success");
        assert_eq!(finish[0]["counts"]["emailUpserted"], 2);
    }

    #[test]
    fn unchanged_messages_are_not_fetched_but_changed_ones_are() {
        let mut host = Script::new(&[(1, 10), (2, 99)]);
        host.cached = vec![("imap:INBOX:7:1".into(), 10), ("imap:INBOX:7:2".into(), 10)];
        handle(&host, &job(0)).unwrap();
        let fetches = host.named("connectors.imap-fetch");
        assert_eq!(fetches.len(), 1);
        assert_eq!(fetches[0]["uids"], json!([2]));
    }

    #[test]
    fn a_large_mailbox_continues_in_steps_with_metadata_only_payloads() {
        let uids: Vec<(u32, u64)> = (1..=120).map(|u| (u, 10)).collect();
        let host = Script::new(&uids);
        let out = handle(&host, &job(0)).unwrap();
        assert!(out.contains("continued"));
        assert!(host.named("pruneCachedMessages").is_empty());
        let queued: Vec<Value> = host
            .calls
            .borrow()
            .iter()
            .filter(|c| c.0 == "jobs" && c.1 != "connectors.imap-list")
            .map(|c| c.2.clone())
            .collect();
        let enqueue = queued.iter().find(|p| p["params"]["cursor"] == 50).expect("continuation");
        let text = enqueue.to_string();
        assert!(!text.contains("SECRET-BODY") && !text.contains("example.com"));
        let mut keys: Vec<&str> = enqueue["params"].as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["account-id", "cursor", "failures", "upserted"]);
    }

    #[test]
    fn a_truncated_listing_never_prunes() {
        let mut host = Script::new(&[(1, 10)]);
        host.listing["truncated"] = json!(true);
        handle(&host, &job(0)).unwrap();
        assert!(host.named("pruneCachedMessages").is_empty());
        assert_eq!(host.named("connectors.imap-sync-finish")[0]["counts"]["truncated"], true);
    }

    #[test]
    fn a_busy_account_is_left_alone() {
        let mut host = Script::new(&[(1, 10)]);
        host.start = "busy";
        assert!(handle(&host, &job(0)).unwrap().contains("busy"));
        assert!(host.named("connectors.imap-list").is_empty());
    }

    #[test]
    fn a_revoked_account_cancels_its_schedule() {
        let mut host = Script::new(&[]);
        host.start = "inactive";
        handle(&host, &job(0)).unwrap();
        assert!(host.calls.borrow().iter().any(|c| c.0 == "jobs" && c.2["id"] == "row-1"));
    }

    #[test]
    fn a_login_refusal_is_recorded_as_an_auth_error() {
        let mut host = Script::new(&[]);
        host.listing = json!({"result":"auth_failed"});
        handle(&host, &job(0)).unwrap();
        let finish = host.named("connectors.imap-sync-finish");
        assert_eq!(finish[0]["status"], "failed");
        assert_eq!(finish[0]["error"], "auth-error");
    }

    #[test]
    fn the_schedule_is_one_keyed_quarter_hour_row() {
        let host = Script::new(&[]);
        reconcile_schedule(&host, "acct");
        let calls = host.calls.borrow();
        let schedule = calls.iter().find(|c| c.0 == "jobs").unwrap();
        assert_eq!(schedule.2["cron"], "*/15 * * * *");
        assert_eq!(schedule.2["key"], "acct");
        let _ = Error::new("unused");
    }

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
