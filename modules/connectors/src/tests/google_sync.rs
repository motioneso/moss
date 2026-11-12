use moss_connectors::google_sync::{handle, reconcile_schedule, sync_route};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

type Reply = Box<dyn Fn(&str, &str, &Value) -> Option<Result<Value>>>;

/// Records every host call and answers from a per-test script; unscripted calls get defaults.
struct Script {
    calls: RefCell<Vec<(String, String, Value, String)>>,
    reply: Reply,
}

impl Script {
    fn new(reply: impl Fn(&str, &str, &Value) -> Option<Result<Value>> + 'static) -> Self {
        Self { calls: RefCell::default(), reply: Box::new(reply) }
    }
    fn named(&self, resource: &str) -> Vec<Value> {
        let calls = self.calls.borrow();
        calls.iter().filter(|c| c.1 == resource || c.0 == resource || c.3 == resource).map(|c| c.2.clone()).collect()
    }
    /// The parameters of the most recent job the guest queued.
    fn last_queued(&self) -> Option<Value> {
        let calls = self.calls.borrow();
        calls.iter().rev().find(|c| c.0 == "jobs" && c.3 == "enqueue-options").map(|c| c.2["params"].clone())
    }
    fn api(&self, name: &str) -> Vec<Value> {
        let calls = self.calls.borrow();
        calls.iter().filter(|c| c.2["name"] == name).map(|c| c.2["parameters"].clone()).collect()
    }
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), resource.into(), p.clone(), operation.into()));
        if let Some(answer) = (self.reply)(port, resource, &p) {
            return answer;
        }
        Ok(match (port, operation) {
            ("context", "read") => json!({"now":"2026-01-01T00:00:00.000Z"}),
            ("context", "uuid") => json!({"id":"id-1"}),
            ("jobs", _) => json!({"id":"row-1"}),
            ("api", _) => json!({"deleted":0,"keys":[]}),
            _ => json!({}),
        })
    }
}

fn run_once(host: &Script, params: Value) -> Value {
    let job = json!({"queue":"google-sync","parameters":params});
    serde_json::from_str(&handle(host, &job.to_string()).unwrap()).unwrap()
}

/// Runs the job and then every continuation it queues, the way the queue would.
fn run(host: &Script, params: Value) -> Value {
    let mut outcome = run_once(host, params);
    for _ in 0..50 {
        if outcome["outcome"] != "continued" {
            break;
        }
        let next = host.last_queued().expect("a continued run queues the next job");
        outcome = run_once(host, next);
    }
    outcome
}

fn start_params() -> Value {
    json!({
        "account-id":"acct-1","phase":"calendar","cursor":0,"calendar-upserted":0,
        "calendar-reconciled":0,"email-upserted":0,"email-failures":0,"trigger":"schedule",
        "recent-only":false,"error":"none","email-on":true,"calendar-on":true,
    })
}

fn started(kind: &'static str) -> Reply {
    Box::new(move |_, resource, _| {
        (resource == "connectors.sync-google-start")
            .then(|| Ok(json!({"state":kind,"email":true,"calendar":true})))
    })
}

fn finish_of(host: &Script) -> Value {
    host.named("connectors.sync-google-finish").pop().expect("no finish call")
}

#[test]
fn a_busy_account_ends_the_run_without_touching_anything() {
    let host = Script::new(started("busy"));
    assert_eq!(run(&host, start_params())["outcome"], "busy");
    assert!(host.named("connectors.sync-google-finish").is_empty());
    assert!(host.named("connectors.sync-google-calendar").is_empty());
}

#[test]
fn an_inactive_account_loses_both_schedules() {
    let host = Script::new(started("inactive"));
    assert_eq!(run(&host, start_params())["outcome"], "inactive");
    assert_eq!(host.named("jobs").iter().filter(|p| p["cron"].is_string()).count(), 2);
    assert_eq!(host.named("unschedule").len(), 2);
}

#[test]
fn a_full_walk_finishes_with_counts_and_saves_the_position() {
    let host = Script::new(|_, resource, p| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":true}))),
        "connectors.sync-google-calendar" => Some(Ok(json!({"events":[{"externalId":"e1","event":{"title":"T"}}],"done":true,"seenSince":"S"}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":[],"done":true}))),
        _ => {
            let _ = p;
            None
        }
    });
    let outcome = run(&host, start_params());
    assert_eq!(outcome["outcome"], "done");
    let finish = finish_of(&host);
    assert_eq!(finish["status"], "success");
    assert_eq!(finish["savePosition"], true);
    assert_eq!(finish["counts"]["calendarUpserted"], 1);
    assert_eq!(host.api("pruneCachedEvents").len(), 1);
}

#[test]
fn a_long_walk_continues_in_a_new_job_with_metadata_only_params() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":true}))),
        "connectors.sync-google-calendar" => Some(Ok(json!({"events":[],"done":false,"next":100,"pageToken":"SENTINEL-PAGE-TOKEN"}))),
        _ => None,
    });
    assert_eq!(run(&host, start_params())["outcome"], "continued");
    let queued = host.named("enqueue-options").pop().unwrap();
    let text = queued.to_string();
    assert!(!text.contains("SENTINEL"), "{text}");
    let keys: Vec<&String> = queued["params"].as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 12, "{keys:?}");
    assert_eq!(queued["params"]["cursor"], 100);
    assert_eq!(queued["params"]["phase"], "calendar");
    assert!(host.named("connectors.sync-google-finish").is_empty());
}

#[test]
fn a_continuation_does_not_start_a_second_run() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-calendar" => Some(Ok(json!({"events":[],"done":true,"seenSince":"S"}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":[],"done":true}))),
        _ => None,
    });
    let mut params = start_params();
    params["cursor"] = json!(100);
    run(&host, params);
    assert!(host.named("connectors.sync-google-start").is_empty());
}

#[test]
fn a_rejected_login_fails_the_run_and_skips_the_prune() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":true}))),
        "connectors.sync-google-calendar" => Some(Ok(json!({"result":"auth_failed"}))),
        _ => None,
    });
    run(&host, start_params());
    let finish = finish_of(&host);
    assert_eq!((finish["status"].clone(), finish["error"].clone()), (json!("failed"), json!("auth-error")));
    assert_eq!(finish["savePosition"], false);
    assert!(host.api("pruneCachedEvents").is_empty());
}

#[test]
fn a_calendar_write_failure_skips_the_prune_and_the_run_is_partial() {
    let host = Script::new(|port, resource, p| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":true}))),
        "connectors.sync-google-calendar" => Some(Ok(json!({"events":[{"externalId":"e1","event":{}}],"done":true,"seenSince":"S"}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":[],"done":true}))),
        _ if port == "api" && p["name"] == "upsertCachedEvent" => Some(Err(Error::new("write failed"))),
        _ => None,
    });
    run(&host, start_params());
    assert_eq!(finish_of(&host)["status"], "partial");
    assert!(host.api("pruneCachedEvents").is_empty());
}

#[test]
fn a_settled_message_is_not_rewritten_but_a_changed_one_is() {
    let host = Script::new(|port, resource, p| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":false}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":["a","b"],"done":true}))),
        "connectors.sync-google-fetch" => Some(Ok(json!({"failures":0,"messages":[
            {"externalId":"a","historyId":"1","subject":"s"},{"externalId":"b","historyId":"2","subject":"s"}]}))),
        _ if port == "api" && p["name"] == "listCachedMessageKeys" => Some(Ok(json!({"keys":[
            {"externalId":"a","historyId":"1","finished":true},{"externalId":"b","historyId":"1","finished":true}]}))),
        _ => None,
    });
    let mut params = start_params();
    params["recent-only"] = json!(true);
    run(&host, params);
    let inserted = host.api("insertCachedMessage");
    assert_eq!(inserted.len(), 1);
    assert_eq!(inserted[0]["externalId"], "b");
    assert_eq!(finish_of(&host)["counts"]["emailUpserted"], 1);
}

#[test]
fn a_message_that_failed_five_times_is_given_up_on() {
    let host = Script::new(|port, resource, p| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":false}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":["a"],"done":true}))),
        "connectors.sync-google-fetch" => Some(Ok(json!({"failures":0,"messages":[{"externalId":"a","historyId":"1"}]}))),
        _ if port == "api" && p["name"] == "listCachedMessageKeys" => {
            Some(Ok(json!({"keys":[{"externalId":"a","historyId":"1","finished":false,"analysisAttempts":5}]})))
        }
        _ => None,
    });
    run(&host, start_params());
    assert!(host.api("insertCachedMessage").is_empty());
}

#[test]
fn a_message_the_host_could_not_fetch_makes_the_run_partial() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":false}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":["a"],"done":true}))),
        "connectors.sync-google-fetch" => Some(Ok(json!({"failures":1,"messages":[]}))),
        _ => None,
    });
    let mut params = start_params();
    params["recent-only"] = json!(true);
    run(&host, params);
    let finish = finish_of(&host);
    assert_eq!((finish["status"].clone(), finish["error"].clone()), (json!("partial"), json!("email-message-error")));
    assert_eq!(finish["counts"]["emailFailures"], 1);
    assert_eq!(finish["savePosition"], false);
}

#[test]
fn a_recent_only_run_stops_after_the_day_phase_and_keeps_the_position() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-start" => Some(Ok(json!({"state":"started","email":true,"calendar":false}))),
        "connectors.sync-google-list" => Some(Ok(json!({"ids":[],"done":true}))),
        _ => None,
    });
    let mut params = start_params();
    params["recent-only"] = json!(true);
    run(&host, params);
    let phases: Vec<Value> = host.named("connectors.sync-google-list").iter().map(|p| p["phase"].clone()).collect();
    assert_eq!(phases, vec![json!("email-day")]);
    assert_eq!(finish_of(&host)["savePosition"], false);
}

#[test]
fn a_host_failure_ends_the_run_without_a_retry_loop() {
    let host = Script::new(|_, resource, _| match resource {
        "connectors.sync-google-start" => Some(Err(Error::new("down"))),
        _ => None,
    });
    assert_eq!(run(&host, start_params())["outcome"], "failed");
    assert_eq!(host.calls.borrow().iter().filter(|c| c.1 == "connectors.sync-google-start").count(), 1);
}

#[test]
fn schedules_use_the_account_id_as_key_with_the_agreed_cron_lines() {
    let host = Script::new(|_, _, _| None);
    reconcile_schedule(&host, "acct-1");
    let scheduled: Vec<Value> = host.named("jobs").into_iter().filter(|p| p["cron"].is_string()).collect();
    let crons: Vec<&str> = scheduled.iter().map(|p| p["cron"].as_str().unwrap()).collect();
    assert_eq!(crons, vec!["*/15 * * * *", "*/30 * * * *"]);
    assert!(scheduled.iter().all(|p| p["key"] == "acct-1"));
    assert!(!scheduled[0]["params"].to_string().contains("token"));
}

fn sweep(host: &Script) -> Value {
    let job = json!({"queue":"google-sync-sweep","parameters":{"account-id":"acct-1"}});
    serde_json::from_str(&handle(host, &job.to_string()).unwrap()).unwrap()
}

fn account_reply(status: &'static str, last: Value) -> Script {
    Script::new(move |_, resource, _| {
        (resource == "connectors.accounts").then(|| Ok(json!([{"id":"acct-1","status":status,"lastSyncStatus":last}])))
    })
}

#[test]
fn the_sweep_leaves_healthy_accounts_alone_and_restarts_failed_ones() {
    assert_eq!(sweep(&account_reply("active", json!("success")))["outcome"], "healthy");
    assert_eq!(sweep(&account_reply("active", json!("partial")))["outcome"], "healthy");
    let failed = account_reply("active", json!("failed"));
    assert_eq!(sweep(&failed)["outcome"], "restarted");
    assert_eq!(failed.named("enqueue-options").len(), 1);
    let never = account_reply("active", Value::Null);
    assert_eq!(sweep(&never)["outcome"], "restarted");
}

#[test]
fn the_sweep_cancels_both_schedules_of_a_revoked_account() {
    let host = account_reply("revoked", json!("success"));
    assert_eq!(sweep(&host)["outcome"], "inactive");
    assert_eq!(host.named("unschedule").len(), 2);
}

fn route_host(accounts: Value) -> Script {
    Script::new(move |_, resource, _| (resource == "connectors.accounts").then(|| Ok(accounts.clone())))
}

#[test]
fn the_manual_route_is_409_without_google_and_202_with_it() {
    let none = route_host(json!([{"id":"x","providerId":"imap-fastmail","status":"active"}]));
    let err = sync_route(&none, &json!({})).unwrap_err();
    assert_eq!(err.status, 409);
    let some = route_host(json!([{"id":"acct-1","providerId":"google","status":"active"}]));
    let (status, body) = sync_route(&some, &json!({"recentOnly":true})).unwrap();
    assert_eq!((status, body["enqueued"].clone()), (202, json!(true)));
    let queued = some.named("enqueue-options").pop().unwrap();
    assert_eq!(queued["params"]["recent-only"], true);
    assert_eq!(queued["params"]["trigger"], "manual");
}

#[test]
fn bad_job_payloads_are_rejected() {
    let host = Script::new(|_, _, _| None);
    assert!(handle(&host, "not json").is_err());
    assert!(handle(&host, &json!({"queue":"google-sync","parameters":{}}).to_string()).is_err());
    assert!(handle(&host, &json!({"queue":"other","parameters":{}}).to_string()).is_err());
}
