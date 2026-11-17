mod common;
use common::*;
use moss_briefings_module::{
    compose::{fallback, Composed, Composer, StubComposer, Subject, EMPTY_FALLBACK},
    queue::{MANUAL, SCHEDULED},
};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

const SECRET: &str = "PRIVATE-MARKER-4471";

/// Writes text that must stay out of every side channel.
struct Slow(bool);
impl Composer for Slow {
    fn compose<H: Host + ?Sized>(&self, host: &H, subject: &Subject<'_>) -> Result<Composed> {
        subject.deadline.check(host)?;
        // The fake clock only moves when a test moves it.
        host.call("context", "read", "call", json!({}))?;
        let mut done = fallback("none");
        if self.0 {
            done.summary_text = format!("Meet {SECRET} at nine.");
        }
        Ok(done)
    }
}

struct Advancing<'a>(&'a Fake, i64);
impl Composer for Advancing<'_> {
    fn compose<H: Host + ?Sized>(&self, _: &H, _: &Subject<'_>) -> Result<Composed> {
        self.0.advance(self.1);
        Ok(fallback("none"))
    }
}

fn setup() -> (Fake, String) {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    fake.zone(B, "UTC");
    let (status, out) = fake.route(
        "POST",
        "/definitions",
        &[],
        json!({"title":"Morning","cadence":"daily","enabled":true}),
    );
    assert_eq!(status, 201, "{out}");
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    (fake, id)
}

fn scheduled(id: &str) -> Value {
    json!({"definition-id":id,"run-kind":"scheduled","briefing-type":"morning"})
}

fn manual(id: &str, run: &str) -> Value {
    json!({"definition-id":id,"briefing-run-id":run,"briefing-type":"morning"})
}

fn outcome(text: Result<String>) -> Value {
    serde_json::from_str(&text.expect("run should not fail")).unwrap()
}

#[test]
fn a_manual_run_is_queued_then_stored_with_the_fallback_text() {
    let (fake, id) = setup();
    let (status, out) = fake.route("POST", "/definitions/:id/run", &[("id", &id)], json!({}));
    assert_eq!(status, 202);
    let (job, run) = (out["jobId"].as_str().unwrap(), out["runId"].as_str().unwrap());
    let path = &[("id", id.as_str()), ("run_id", run)];
    let request = |query: Option<&str>| {
        let mut r = moss_module_sdk::RouteRequest {
            method: "GET".into(),
            path: "/definitions/:id/runs/:run_id".into(),
            params: path.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: Default::default(),
            body: json!({}),
        };
        if let Some(job) = query {
            r.query.insert("jobId".into(), json!(job));
        }
        let response = moss_briefings_module::route(&fake, r);
        (response.status, response.body)
    };
    // Queued, not yet run.
    let (status, body) = request(Some(job));
    assert_eq!((status, body["state"].as_str()), (200, Some("pending")));
    assert_eq!(fake.runs.borrow().len(), 0);
    let out = outcome(fake.deliver(&StubComposer, MANUAL, manual(&id, run)));
    assert_eq!(out, json!({"status":"created","runId":run,"notified":false}));
    let (status, body) = request(None);
    assert_eq!((status, body["state"].as_str()), (200, Some("ready")));
    // The stored text is the fallback. A run with no model reads back with empty text.
    assert_eq!(fake.runs.borrow()[0]["summary_text"], EMPTY_FALLBACK);
    assert_eq!(body["run"]["summaryText"], "");
    assert_eq!(fake.runs.borrow()[0]["run_kind"], "manual");
    assert_eq!(fake.runs.borrow()[0]["source_metadata"]["degraded"], true);
    // A manual run never notifies.
    assert!(fake.notifications.borrow().is_empty());
}

#[test]
fn a_queued_run_reads_pending_then_failed_and_a_stranger_sees_nothing() {
    let (fake, id) = setup();
    let (_, out) = fake.route("POST", "/definitions/:id/run", &[("id", &id)], json!({}));
    let (job, run) = (out["jobId"].as_str().unwrap().to_owned(), out["runId"].as_str().unwrap().to_owned());
    let read = |as_b: bool, job: &str| {
        if as_b {
            fake.as_actor(B);
        }
        let mut r = moss_module_sdk::RouteRequest {
            method: "GET".into(),
            path: "/definitions/:id/runs/:run_id".into(),
            params: [("id", id.as_str()), ("run_id", run.as_str())].iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: Default::default(),
            body: json!({}),
        };
        r.query.insert("jobId".into(), json!(job));
        let response = moss_briefings_module::route(&fake, r);
        fake.as_actor(A);
        (response.status, response.body)
    };
    assert_eq!(read(false, &job).1["state"], "pending");
    fake.finish_job(&job, "failed");
    let (status, body) = read(false, &job);
    assert_eq!((status, body["state"].as_str(), body["run"].is_null()), (200, Some("failed"), true));
    // A job id that is not the caller's own is not found, and so is a made-up one.
    assert_eq!(read(true, &job).0, 404);
    assert_eq!(read(false, "00000000-0000-4000-8000-0000000000ff").0, 404);
    // A completed job with no stored run is not reported as pending.
    fake.finish_job(&job, "completed");
    assert_eq!(read(false, &job).0, 404);
}

#[test]
fn a_repeated_key_is_refused_while_running_and_reusable_after() {
    let (fake, id) = setup();
    let go = |body: Value| fake.route("POST", "/definitions/:id/run", &[("id", &id)], body);
    let (status, first) = go(json!({"idempotencyKey":"abc"}));
    assert_eq!(status, 202);
    let (status, again) = go(json!({"idempotencyKey":"abc"}));
    assert_eq!((status, again["code"].as_str()), (409, Some("briefing_run_in_flight")));
    assert_eq!(fake.queue.borrow().len(), 1);
    fake.finish_job(first["jobId"].as_str().unwrap(), "completed");
    let (status, next) = go(json!({"idempotencyKey":"abc"}));
    assert_eq!(status, 202);
    assert_ne!(next["runId"], first["runId"]);
    // Keyless runs never collide.
    assert_eq!(go(json!({})).0, 202);
    assert_eq!(go(json!({})).0, 202);
    // Bad bodies and other people's definitions.
    assert_eq!(go(json!({"idempotencyKey":"   "})).0, 400);
    assert_eq!(go(json!({"idempotencyKey":""})).0, 400);
    fake.as_actor(B);
    assert_eq!(go(json!({})).0, 404);
}

#[test]
fn a_scheduled_run_stores_once_a_day_and_notifies_once() {
    let (fake, id) = setup();
    let out = outcome(fake.deliver(&StubComposer, SCHEDULED, scheduled(&id)));
    assert_eq!(out["status"], "created");
    assert_eq!(out["notified"], true);
    assert_eq!(fake.runs.borrow().len(), 1);
    assert_eq!(fake.runs.borrow()[0]["run_kind"], "scheduled");
    assert_eq!(fake.runs.borrow()[0]["summary_text"], EMPTY_FALLBACK);
    assert_eq!(fake.definitions.borrow()[0]["last_run_at"], NOW);
    // The same local day: no second run and no second notification.
    fake.advance(60_000);
    let again = outcome(fake.deliver(&StubComposer, SCHEDULED, scheduled(&id)));
    assert_eq!((again["status"].as_str(), again["notified"].as_bool()), (Some("duplicate"), Some(false)));
    assert_eq!(fake.runs.borrow().len(), 1);
    assert_eq!(fake.notifications.borrow().len(), 1);
    // The next local day runs again.
    fake.advance(24 * 3_600_000);
    assert_eq!(outcome(fake.deliver(&StubComposer, SCHEDULED, scheduled(&id)))["status"], "created");
    assert_eq!(fake.runs.borrow().len(), 2);
    assert_eq!(fake.notifications.borrow().len(), 2);
}

#[test]
fn the_notification_carries_metadata_only() {
    let (fake, id) = setup();
    outcome(fake.deliver(&Slow(true), SCHEDULED, scheduled(&id)));
    let sent = fake.notifications.borrow()[0].clone();
    let keys: Vec<&String> = sent.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["eventKey", "text", "urgency"]);
    assert_eq!(sent["text"], "Your morning briefing is ready");
    let run = fake.runs.borrow()[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(sent["eventKey"], format!("briefing-run-{run}"));
    // The briefing text is stored on the run and nowhere else.
    assert!(fake.runs.borrow()[0]["summary_text"].as_str().unwrap().contains(SECRET));
    let elsewhere = json!([
        fake.notifications.borrow().clone(),
        fake.queue.borrow().clone(),
        fake.jobs.borrow().clone(),
        fake.calls.borrow().clone(),
    ])
    .to_string();
    assert!(!elsewhere.contains(SECRET));
}

#[test]
fn an_overrun_rolls_back_the_row_and_the_notification() {
    let (fake, id) = setup();
    let before = fake.definitions.borrow().clone();
    let failed = fake.deliver(&Advancing(&fake, 6 * 60_000 + 1), SCHEDULED, scheduled(&id));
    let message = failed.expect_err("an overrun fails the run").to_string();
    assert_eq!(message, "briefing_run_timeout");
    assert!(fake.runs.borrow().is_empty());
    assert!(fake.notifications.borrow().is_empty());
    assert_eq!(*fake.definitions.borrow(), before);
    // Exactly at the limit still finishes, and the retry that follows is allowed.
    fake.set_clock(NOW);
    let ok = fake.deliver(&Advancing(&fake, 6 * 60_000), SCHEDULED, scheduled(&id));
    assert_eq!(outcome(ok)["status"], "created");
}

#[test]
fn a_definition_with_a_write_tool_stores_a_blocked_run_and_stays_quiet() {
    let (fake, id) = setup();
    fake.definitions.borrow_mut()[0]["selected_tool_names"] = json!(["tasks.delete"]);
    let out = outcome(fake.deliver(&StubComposer, SCHEDULED, scheduled(&id)));
    assert_eq!((out["status"].as_str(), out["notified"].as_bool()), (Some("blocked"), Some(false)));
    assert_eq!(fake.runs.borrow()[0]["status"], "blocked");
    assert!(fake.notifications.borrow().is_empty());
}

#[test]
fn another_persons_definition_and_a_stored_run_are_not_run_again() {
    let (fake, id) = setup();
    fake.as_actor(B);
    assert_eq!(outcome(fake.deliver(&StubComposer, MANUAL, manual(&id, "00000000-0000-4000-8000-0000000000c1")))["status"], "gone");
    assert!(fake.runs.borrow().is_empty());
    fake.as_actor(A);
    let run = "00000000-0000-4000-8000-0000000000c2";
    assert_eq!(outcome(fake.deliver(&StubComposer, MANUAL, manual(&id, run)))["status"], "created");
    // A redelivery of the same run changes nothing.
    assert_eq!(outcome(fake.deliver(&StubComposer, MANUAL, manual(&id, run)))["status"], "duplicate");
    assert_eq!(fake.runs.borrow().len(), 1);
}

#[test]
fn deliveries_that_are_not_metadata_only_are_refused() {
    let (fake, id) = setup();
    let run = "00000000-0000-4000-8000-0000000000c3";
    let bad = [
        json!({"queue":SCHEDULED,"parameters":scheduled(&id),"text":"hello"}).to_string(),
        json!({"queue":SCHEDULED,"parameters":{"definition-id":id,"run-kind":"scheduled","briefing-type":"morning","note":"x"}}).to_string(),
        json!({"queue":SCHEDULED,"parameters":{"definition-id":id,"run-kind":"manual","briefing-type":"morning"}}).to_string(),
        json!({"queue":MANUAL,"parameters":{"definition-id":id,"briefing-run-id":"nope","briefing-type":"morning"}}).to_string(),
        json!({"queue":"other","parameters":manual(&id, run)}).to_string(),
        "not json".to_owned(),
    ];
    for payload in bad {
        assert!(fake.deliver_raw(&StubComposer, &payload).is_err(), "{payload}");
    }
    assert!(fake.runs.borrow().is_empty());
}
