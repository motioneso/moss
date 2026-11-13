//! Email refresh, package side. A person asks for a refresh of every connected mail account.
//! The host keeps the refresh rows. The package turns pending rows into one sync job per
//! account, and a per-person sweep repeats that until every account has an outcome. Job
//! parameters hold only ids, counts and fixed choices, never mail text.
use crate::{fastify, google_sync, kv, mail_sync, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const SWEEP: &str = "email-refresh-sweep";
const SWEEP_CRON: &str = "*/1 * * * *";
const SWEEP_KEY: &str = "email-refresh";
const NOT_FOUND: &str = "Email refresh not found";

/// The statuses the app tells the browser about: all but the first two end a refresh.
pub fn outcome(error: &str) -> (&'static str, Option<&'static str>) {
    match error {
        "none" => ("succeeded", None),
        "auth-error" => ("failed", Some("auth-error")),
        "no-active-connection" => ("failed", Some("no-active-connection")),
        "email-needs-config" => ("failed", Some("email-needs-config")),
        "email-message-error" => ("partial", Some("email-message-error")),
        _ => ("partial", Some("email-error")),
    }
}

/// Marks the account's refresh row as running. False means the row is already finished or
/// was never waiting, so the job has nothing to do.
pub fn begin(host: &impl Host, refresh: &str, account: &str, provider: &str) -> Result<bool> {
    let started = kv(
        host,
        "set",
        "connectors.refresh-account-start",
        json!({"refreshId":refresh,"accountId":account,"provider":provider}),
    )?;
    Ok(started["state"] == "started")
}

/// Records the account's outcome. A failure to record is left to the sweep, which fails any
/// row that stays unfinished.
pub fn finish(
    host: &impl Host,
    refresh: &str,
    account: &str,
    status: &str,
    error: Option<&str>,
    upserted: u64,
    failures: u64,
) {
    let _ = kv(
        host,
        "set",
        "connectors.refresh-account-finish",
        json!({
            "refreshId":refresh,"accountId":account,"status":status,"error":error,
            "counts":{"emailUpserted":upserted,"emailFailures":failures},
        }),
    );
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&groups).all(|(n, g)| g.len() == *n)
        && groups.iter().all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn uuid_param(value: &Value, path: &str, place: &str) -> Result<String> {
    let text = fastify::string(value, path)?;
    if is_uuid(&text) {
        Ok(text)
    } else {
        Err(Error::new(400, format!("{place}/{path} must match format \"uuid\"")))
    }
}

/// POST /email-refresh. Starts a refresh, or returns the one this key or an active refresh
/// already has.
pub fn request(host: &impl Host, body: &Value) -> Result<(u16, Value)> {
    let object = fastify::object(body)?;
    fastify::required(object, &["idempotencyKey"])?;
    let key = uuid_param(&object["idempotencyKey"], "idempotencyKey", "body")?;
    let made = kv(host, "set", "connectors.refresh-request", json!({"key":key}))?;
    let id = made["refreshId"].as_str().ok_or_else(|| Error::new(500, "Internal server error"))?;
    let mut enqueued = false;
    if made["created"] == true && made["active"] == true {
        ensure_sweep(host);
        enqueued = dispatch(host, Some(id)) > 0;
    }
    Ok((202, json!({"refreshId":id,"enqueued":enqueued,"deduped":made["deduped"]})))
}

/// GET /email-refresh/:refresh_id. Another person's refresh looks the same as a missing one.
pub fn status(host: &impl Host, id: &str) -> Result<(u16, Value)> {
    let id = uuid_param(&json!(id), "refreshId", "params")?;
    let found = kv(host, "get", "connectors.refresh-status", json!({"refreshId":id}))?;
    if found.is_null() {
        return Err(Error::new(404, NOT_FOUND));
    }
    Ok((200, found))
}

fn ensure_sweep(host: &impl Host) {
    let _ = host.call(
        "jobs",
        "schedule",
        SWEEP,
        json!({"cron":SWEEP_CRON,"timezone":"UTC","key":SWEEP_KEY,"params":{"round":0}}),
    );
}

fn stop_sweep(host: &impl Host) {
    let Ok(saved) = host.call(
        "jobs",
        "schedule",
        SWEEP,
        json!({"cron":SWEEP_CRON,"timezone":"UTC","key":SWEEP_KEY,"params":{"round":0}}),
    ) else {
        return;
    };
    if let Some(id) = saved["id"].as_str() {
        let _ = host.call("jobs", "unschedule", SWEEP, json!({"id":id}));
    }
}

fn enqueue(host: &impl Host, queue: &str, params: Value, key: &str) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":params,"idempotencyKey":key,"availableAt":context["now"]}),
    )?;
    Ok(())
}

/// Queues one sync job for every account row still waiting. The key comes from the host and is
/// fixed per row, so a repeat dispatch never queues a second job. Returns how many rows it queued.
fn dispatch(host: &impl Host, refresh: Option<&str>) -> usize {
    let Ok(pending) = kv(host, "get", "connectors.refresh-pending", json!({"refreshId":refresh})) else {
        return 0;
    };
    let mut queued = 0;
    for row in pending.as_array().into_iter().flatten() {
        let (Some(id), Some(account), Some(provider), Some(key)) = (
            row["refreshId"].as_str(),
            row["accountId"].as_str(),
            row["provider"].as_str(),
            row["dedupeKey"].as_str(),
        ) else {
            continue;
        };
        let (queue, params) = if provider == "google" {
            (google_sync::REFRESH_QUEUE, google_sync::refresh_first(account, id))
        } else {
            mail_sync::refresh_first(account, id)
        };
        let sent = enqueue(host, queue, params, key).is_ok();
        let _ = kv(
            host,
            "set",
            "connectors.refresh-dispatch",
            json!({"refreshId":id,"accountId":account,"ok":sent}),
        );
        if sent {
            queued += 1;
        }
    }
    queued
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid email refresh job")?;
    let outcome = match job["queue"].as_str() {
        Some(SWEEP) => sweep(host).map_err(|e| e.message)?,
        _ => return Err("Connectors job is unavailable".into()),
    };
    Ok(json!({"outcome":outcome}).to_string())
}

/// Fails rows that stayed unfinished too long, queues rows still waiting, and stops itself when
/// the person has no active refresh left.
fn sweep(host: &impl Host) -> Result<&'static str> {
    let state = kv(host, "set", "connectors.refresh-sweep", json!({}))?;
    if state["pending"] == true {
        dispatch(host, None);
    }
    if state["active"] == true {
        return Ok("active");
    }
    stop_sweep(host);
    Ok("idle")
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::Error as HostError;
    use std::cell::RefCell;

    const REFRESH: &str = "11111111-1111-4111-8111-111111111111";
    const KEY: &str = "22222222-2222-4222-8222-222222222222";

    /// Scripted host that records every call and can refuse queue sends.
    #[derive(Default)]
    struct Script {
        calls: RefCell<Vec<(String, String, Value)>>,
        pending: Vec<Value>,
        fail_queue: bool,
        sweep: Value,
        request: Value,
    }

    impl Script {
        fn named(&self, resource: &str) -> Vec<Value> {
            self.calls.borrow().iter().filter(|c| c.1 == resource).map(|c| c.2.clone()).collect()
        }
    }

    impl Host for Script {
        fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> moss_module_sdk::Result<Value> {
            self.calls.borrow_mut().push((port.into(), resource.into(), p.clone()));
            Ok(match (port, operation, resource) {
                ("jobs", "enqueue-options", _) if self.fail_queue => return Err(HostError::new("queue refused")),
                ("context", "read", _) => json!({"now":"2026-01-01T00:00:00.000Z"}),
                ("kv", "set", "connectors.refresh-request") => self.request.clone(),
                ("kv", "get", "connectors.refresh-pending") => Value::Array(self.pending.clone()),
                ("kv", "set", "connectors.refresh-sweep") => self.sweep.clone(),
                ("jobs", "schedule", _) => json!({"id":"row-1"}),
                _ => json!({}),
            })
        }
    }

    fn row(account: &str, provider: &str) -> Value {
        json!({"refreshId":REFRESH,"accountId":account,"provider":provider,"dedupeKey":"33333333-3333-4333-8333-333333333333"})
    }

    fn fresh() -> Script {
        Script {
            request: json!({"refreshId":REFRESH,"created":true,"active":true,"deduped":false}),
            pending: vec![row("a1", "google"), row("a2", "imap")],
            ..Script::default()
        }
    }

    #[test]
    fn a_request_queues_one_metadata_only_job_per_account_and_marks_each_sent() {
        let host = fresh();
        let (status, body) = request(&host, &json!({"idempotencyKey":KEY})).unwrap();
        assert_eq!((status, body["enqueued"].clone(), body["deduped"].clone()), (202, json!(true), json!(false)));
        let google = host.named("email-refresh-google");
        let mail = host.named("email-refresh-imap");
        assert_eq!((google.len(), mail.len()), (1, 1));
        assert_eq!(google[0]["idempotencyKey"], "33333333-3333-4333-8333-333333333333");
        let mut keys: Vec<&str> = mail[0]["params"].as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["account-id", "cursor", "failures", "refresh-id", "upserted"]);
        assert_eq!(google[0]["params"]["trigger"], "manual");
        assert_eq!(google[0]["params"]["phase"], "email-day");
        assert_eq!(google[0]["params"]["recent-only"], true);
        assert_eq!(google[0]["params"]["calendar-on"], false);
        assert_eq!(host.named("connectors.refresh-dispatch").iter().filter(|d| d["ok"] == true).count(), 2);
        assert_eq!(host.named("email-refresh-sweep").len(), 1, "the sweep schedule is created");
    }

    #[test]
    fn a_failed_send_is_reported_and_not_counted_as_queued() {
        let mut host = fresh();
        host.fail_queue = true;
        let (_, body) = request(&host, &json!({"idempotencyKey":KEY})).unwrap();
        assert_eq!(body["enqueued"], false);
        let sent = host.named("connectors.refresh-dispatch");
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|d| d["ok"] == false));
    }

    #[test]
    fn a_joined_or_repeated_request_queues_nothing() {
        let mut host = fresh();
        host.request = json!({"refreshId":REFRESH,"created":false,"active":true,"deduped":true});
        let (status, body) = request(&host, &json!({"idempotencyKey":KEY})).unwrap();
        assert_eq!((status, body["enqueued"].clone(), body["deduped"].clone()), (202, json!(false), json!(true)));
        assert!(host.named("email-refresh-google").is_empty() && host.named("email-refresh-imap").is_empty());
    }

    #[test]
    fn a_bad_body_is_refused_with_the_old_messages() {
        let host = fresh();
        assert_eq!(request(&host, &json!({})).unwrap_err().status, 400);
        assert_eq!(request(&host, &json!({"idempotencyKey":"nope"})).unwrap_err().message, "body/idempotencyKey must match format \"uuid\"");
        assert_eq!(status(&host, "nope").unwrap_err().status, 400);
        assert!(host.calls.borrow().is_empty(), "nothing is stored for a bad request");
    }

    #[test]
    fn a_missing_refresh_is_a_404() {
        let mut host = fresh();
        host.request = Value::Null;
        // The host answers null for the status of a refresh that is missing or another person's.
        struct Missing;
        impl Host for Missing {
            fn call(&self, _: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
                Ok(Value::Null)
            }
        }
        let error = status(&Missing, REFRESH).unwrap_err();
        assert_eq!((error.status, error.message.as_str()), (404, "Email refresh not found"));
    }

    #[test]
    fn errors_map_to_the_outcome_the_old_server_gave() {
        assert_eq!(outcome("none"), ("succeeded", None));
        assert_eq!(outcome("auth-error"), ("failed", Some("auth-error")));
        assert_eq!(outcome("email-message-error"), ("partial", Some("email-message-error")));
        assert_eq!(outcome("email-error"), ("partial", Some("email-error")));
        assert_eq!(outcome("calendar-error"), ("partial", Some("email-error")));
    }

    #[test]
    fn the_sweep_sends_waiting_rows_and_stops_itself_when_idle() {
        let mut host = fresh();
        host.sweep = json!({"pending":true,"active":true});
        let job = json!({"queue":SWEEP,"parameters":{"round":0}}).to_string();
        assert!(handle(&host, &job).unwrap().contains("active"));
        assert_eq!(host.named("email-refresh-google").len(), 1);
        let mut idle = fresh();
        idle.sweep = json!({"pending":false,"active":false});
        assert!(handle(&idle, &job).unwrap().contains("idle"));
        assert!(idle.calls.borrow().iter().any(|c| c.0 == "jobs" && c.2["id"] == "row-1"), "the schedule is cancelled");
        assert!(idle.named("email-refresh-google").is_empty());
    }
}
