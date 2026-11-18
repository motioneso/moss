mod common;
use common::*;
use moss_briefings_module::{compose::StubComposer, queue::MANUAL};
use serde_json::{json, Value};

const SECRET: &str = "PRIVATE-MARKER-9921";

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
    (fake, out["definition"]["id"].as_str().unwrap().to_owned())
}

fn tool(fake: &Fake, name: &str, parameters: Value, version: Option<&str>) -> Value {
    let mut payload = json!({"tool":name,"parameters":parameters});
    if let Some(v) = version {
        payload["approvalVersion"] = json!(v);
    }
    let text = moss_briefings_module::handle(fake, "tool", &payload.to_string()).expect("tool ran");
    serde_json::from_str::<Value>(&text).unwrap()["data"].clone()
}

fn api(fake: &Fake, name: &str, parameters: Value) -> Value {
    let payload = json!({"name":name,"parameters":parameters}).to_string();
    serde_json::from_str(&moss_briefings_module::handle(fake, "api", &payload).expect("api ran")).unwrap()
}

fn prepare(fake: &Fake, input: Value) -> Value {
    api(
        fake,
        "prepareBriefingAction",
        json!({"tool":"briefings.rerun","inputJson":input.to_string()}),
    )
}

fn version(fake: &Fake, input: Value) -> String {
    prepare(fake, input)["ok"]["version"].as_str().expect("card has a version").to_owned()
}

#[test]
fn a_rerun_by_type_queues_a_metadata_only_job() {
    let (fake, id) = setup();
    let input = json!({"briefingType":"morning"});
    let v = version(&fake, input.clone());
    let out = tool(&fake, "briefings.rerun", input, Some(&v));
    assert_eq!(out["status"], "queued", "{out}");
    assert_eq!(out["definitionId"], id);
    assert!(out["runId"].is_string() && out["jobId"].is_string());
    let queue = fake.queue.borrow();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0]["queue"], MANUAL);
    let mut keys: Vec<_> = queue[0]["params"].as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["briefing-run-id", "briefing-type", "definition-id"]);
}

#[test]
fn a_rerun_by_definition_id_works_and_a_second_is_already_running() {
    let (fake, id) = setup();
    let input = json!({"definitionId":id});
    let v = version(&fake, input.clone());
    assert_eq!(tool(&fake, "briefings.rerun", input.clone(), Some(&v))["status"], "queued");
    let again = tool(&fake, "briefings.rerun", input, Some(&v));
    assert_eq!(again["status"], "already_running", "{again}");
    assert_eq!(fake.queue.borrow().len(), 1);
}

#[test]
fn a_scheduled_job_in_flight_also_counts_as_running() {
    let (fake, id) = setup();
    fake.queue.borrow_mut().push(json!({
        "id":"00000000-0000-4000-8000-0000000000c1","queue":moss_briefings_module::queue::SCHEDULED,
        "actor":A,"key":null,"state":"pending","params":{"definition-id":id}
    }));
    let input = json!({"definitionId":id});
    let v = version(&fake, input.clone());
    let out = tool(&fake, "briefings.rerun", input, Some(&v));
    assert_eq!(out["status"], "already_running", "{out}");
    assert_eq!(fake.queue.borrow().len(), 1);
}

#[test]
fn the_selector_must_name_exactly_one_valid_target() {
    let (fake, id) = setup();
    let msg = |p: Value| tool(&fake, "briefings.rerun", p, Some("x"))["error"].as_str().unwrap_or("").to_owned();
    assert_eq!(msg(json!({})), "Give exactly one of briefingType or definitionId");
    assert_eq!(msg(json!({"briefingType":"morning","definitionId":id})), "Give exactly one of briefingType or definitionId");
    assert_eq!(msg(json!({"briefingType":"noon"})), "briefingType must be morning, evening or weekly_review");
    assert_eq!(msg(json!({"briefingType":"morning","extra":1})), "Invalid Briefings tool input");
    assert!(fake.queue.borrow().is_empty());
}

#[test]
fn a_missing_or_stale_approval_version_queues_nothing() {
    let (fake, _) = setup();
    let input = json!({"briefingType":"morning"});
    let stale = "Briefing changed since approval. Prepare the action again.";
    assert_eq!(tool(&fake, "briefings.rerun", input.clone(), None)["error"], stale);
    assert_eq!(tool(&fake, "briefings.rerun", input, Some("[\"old\"]"))["error"], stale);
    assert!(fake.queue.borrow().is_empty());
}

#[test]
fn a_person_with_no_briefing_of_that_type_gets_no_briefing() {
    let (fake, _) = setup();
    let out = tool(&fake, "briefings.rerun", json!({"briefingType":"evening"}), Some("x"));
    assert_eq!(out["status"], "no_briefing", "{out}");
    assert!(fake.queue.borrow().is_empty());
}

#[test]
fn another_persons_briefing_is_never_picked_even_when_shared() {
    let (fake, id) = setup();
    fake.share(&id, B, "view");
    fake.as_actor(B);
    // By type: B owns none, so nothing is found.
    assert_eq!(tool(&fake, "briefings.rerun", json!({"briefingType":"morning"}), Some("x"))["status"], "no_briefing");
    // By id: B can read the shared definition but does not own it.
    assert_eq!(tool(&fake, "briefings.rerun", json!({"definitionId":id}), Some("x"))["status"], "no_briefing");
    assert!(fake.queue.borrow().is_empty());
    // The approval card is also refused.
    assert!(prepare(&fake, json!({"definitionId":id}))["ok"].is_null());
}

#[test]
fn the_card_shows_the_callers_briefing_and_refuses_extra_keys() {
    let (fake, id) = setup();
    let card = prepare(&fake, json!({"briefingType":"morning"}))["ok"].clone();
    assert_eq!(card["title"], "Re-run a briefing");
    assert_eq!(card["target"], "Morning");
    assert_eq!(card["fields"], json!([{"label":"Briefing type","value":"Morning"}]));
    let by_id = prepare(&fake, json!({"definitionId":id}))["ok"].clone();
    assert_eq!(by_id["fields"], json!([{"label":"Briefing","value":"Morning"}]));
    assert_eq!(card["version"], by_id["version"]);
    assert!(prepare(&fake, json!({"briefingType":"morning","x":1}))["ok"].is_null());
}

#[test]
fn the_approval_version_changes_when_the_briefing_is_edited() {
    let (fake, id) = setup();
    let before = version(&fake, json!({"definitionId":id}));
    fake.advance(5000);
    let (status, _) = fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"title":"Morning two"}));
    assert_eq!(status, 200);
    let out = tool(&fake, "briefings.rerun", json!({"definitionId":id}), Some(&before));
    assert_eq!(out["error"], "Briefing changed since approval. Prepare the action again.");
}

fn queue_run(fake: &Fake, id: &str) -> (String, String) {
    let input = json!({"definitionId":id});
    let v = version(fake, input.clone());
    let out = tool(fake, "briefings.rerun", input, Some(&v));
    (out["jobId"].as_str().unwrap().into(), out["runId"].as_str().unwrap().into())
}

#[test]
fn status_follows_a_queued_run_to_ready_and_every_result_is_marked_outside() {
    let (fake, id) = setup();
    let (job, run) = queue_run(&fake, &id);
    let read = |p: Value| {
        let text = moss_briefings_module::handle(&fake, "tool", &json!({"tool":"briefings.getRunStatus","parameters":p}).to_string()).unwrap();
        serde_json::from_str::<Value>(&text).unwrap()
    };
    let pending = read(json!({"runId":run,"jobId":job,"definitionId":id}));
    assert_eq!(pending["data"]["state"], "pending", "{pending}");
    assert_eq!(pending["content"], "outside");
    fake.deliver(&StubComposer, MANUAL, json!({"definition-id":id,"briefing-run-id":run,"briefing-type":"morning"})).unwrap();
    let ready = read(json!({"runId":run}));
    assert_eq!(ready["data"]["state"], "ready", "{ready}");
    assert_eq!(ready["content"], "outside");
    // A run written without the model reads back with empty text.
    assert_eq!(ready["data"]["summaryText"], "");
}

#[test]
fn status_reports_a_failed_job_and_hides_another_persons_run_and_job() {
    let (fake, id) = setup();
    let (job, run) = queue_run(&fake, &id);
    fake.finish_job(&job, "failed");
    let read = |p: Value| tool(&fake, "briefings.getRunStatus", p, None);
    assert_eq!(read(json!({"runId":run,"jobId":job,"definitionId":id}))["state"], "failed");
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000d1", "2026-11-11T09:00:00.000Z", json!({}));
    fake.as_actor(B);
    assert_eq!(read(json!({"runId":"00000000-0000-4000-8000-0000000000d1"}))["state"], "not_found");
    assert_eq!(read(json!({"runId":run,"jobId":job,"definitionId":id}))["state"], "not_found");
    assert_eq!(read(json!({"runId":run}))["state"], "not_found");
}

#[test]
fn status_rejects_bad_or_missing_ids() {
    let (fake, id) = setup();
    let read = |p: Value| tool(&fake, "briefings.getRunStatus", p, None);
    assert!(read(json!({}))["error"].is_string());
    assert!(read(json!({"jobId":"00000000-0000-4000-8000-0000000000d1"}))["error"].is_string());
    assert!(read(json!({"runId":42}))["error"].is_string());
    assert_eq!(read(json!({"runId":"not-an-id"}))["state"], "not_found");
    assert!(read(json!({"runId":"00000000-0000-4000-8000-0000000000d1","extra":id}))["error"].is_string());
}

#[test]
fn a_finished_scheduled_job_falls_back_to_the_newest_own_run() {
    let (fake, id) = setup();
    let job = "00000000-0000-4000-8000-0000000000e1";
    fake.queue.borrow_mut().push(json!({
        "id":job,"queue":moss_briefings_module::queue::SCHEDULED,"actor":A,"key":null,
        "state":"completed","params":{"definition-id":id}
    }));
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000d2", "2026-11-11T09:00:00.000Z", json!({}));
    let out = tool(&fake, "briefings.getRunStatus", json!({"jobId":job,"definitionId":id}), None);
    assert_eq!(out["state"], "ready", "{out}");
    assert_eq!(out["summaryText"], "Today you have two meetings.");
}

#[test]
fn briefing_text_never_reaches_job_payloads_calls_or_notifications() {
    let (fake, id) = setup();
    fake.runs.borrow_mut().push(json!({
        "id":"00000000-0000-4000-8000-0000000000d3","definition_id":id,"owner_user_id":A,"status":"succeeded",
        "run_kind":"manual","briefing_type":"morning","summary_text":SECRET,"source_metadata":{},
        "created_at":"2026-11-11T09:00:00.000Z"
    }));
    let _ = queue_run(&fake, &id);
    tool(&fake, "briefings.getRunStatus", json!({"runId":"00000000-0000-4000-8000-0000000000d3"}), None);
    assert!(!format!("{:?}", fake.jobs.borrow()).contains(SECRET));
    assert!(!fake.queue.borrow().iter().any(|j| j.to_string().contains(SECRET)));
    assert!(!fake.notifications.borrow().iter().any(|n| n.to_string().contains(SECRET)));
}

#[test]
fn an_unknown_tool_fails_with_the_fixed_message() {
    let (fake, _) = setup();
    let err = moss_briefings_module::handle(&fake, "tool", &json!({"tool":"briefings.nope","parameters":{}}).to_string());
    assert_eq!(err.unwrap_err().to_string().contains("Briefings tool failed"), true);
}

fn verify(fake: &Fake, p: Value) -> Value {
    api(fake, "verifyBriefingFeedbackTarget", p)
}

#[test]
fn the_verifier_accepts_an_owned_run_and_refuses_anothers() {
    let (fake, id) = setup();
    let run = "00000000-0000-4000-8000-0000000000d4";
    fake.seed_run(&id, A, run, "2026-11-11T09:00:00.000Z", json!({}));
    let ok = verify(&fake, json!({"targetKind":"briefing_run","targetRef":run,"surface":"briefing"}));
    assert!(ok.get("ok").is_some() && !ok["ok"].is_null(), "{ok}");
    assert_eq!(ok["ok"]["canRemember"], false);
    let wrong = verify(&fake, json!({"targetKind":"briefing_run","targetRef":run,"surface":"chat"}));
    assert!(wrong["ok"].is_null(), "{wrong}");
    fake.as_actor(B);
    let other = verify(&fake, json!({"targetKind":"briefing_run","targetRef":run,"surface":"briefing"}));
    assert!(other["ok"].is_null(), "{other}");
}

#[test]
fn the_approval_version_stays_short_with_many_selected_tools() {
    let (fake, id) = setup();
    let names: Vec<String> = (0..30).map(|i| format!("tasks.some_long_tool_name_{i}")).collect();
    for d in fake.definitions.borrow_mut().iter_mut() {
        d["selected_tool_names"] = json!(names);
    }
    let v = version(&fake, json!({"definitionId":id}));
    assert!(v.len() <= 256, "{}", v.len());
}

#[test]
fn many_finished_reruns_never_block_the_next_one() {
    let (fake, id) = setup();
    let input = json!({"definitionId":id});
    let v = version(&fake, input.clone());
    for _ in 0..60 {
        let out = tool(&fake, "briefings.rerun", input.clone(), Some(&v));
        assert_eq!(out["status"], "queued", "{out}");
        fake.finish_job(out["jobId"].as_str().unwrap(), "completed");
    }
}
