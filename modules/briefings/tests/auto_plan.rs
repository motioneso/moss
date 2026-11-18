//! The day plan step of a run. Calendar owns the plan, so the step only goes through Calendar's
//! public API, only for a succeeded run, and only when the person allows planning.
mod common;
use common::*;
use moss_briefings_module::{
    compose::{Composed, Composer, Subject},
    queue::SCHEDULED,
};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

const SECRET: &str = "PRIVATE-MARKER-4471";

/// Returns a run that carries one calendar signal with a suggested action.
struct Signals(&'static str);
impl Composer for Signals {
    fn compose<H: Host + ?Sized>(&self, _: &H, _: &Subject<'_>) -> Result<Composed> {
        Ok(Composed {
            status: self.0,
            summary_text: format!("Briefing mentioning {SECRET}."),
            source_metadata: json!({
                "calendarSignals": [{"summary": format!("Prep for {SECRET}"), "suggestedActions": [{"kind": "prep_block"}]}],
                "emailSignals": [], "gaps": [], "structuredPayload": {"version":1,"actionRows":[],"catchUp":null},
            }),
        })
    }
}

fn setup() -> (Fake, String) {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    let (_, out) = fake.route("POST", "/definitions", &[], json!({"title":"Morning","cadence":"daily","enabled":true}));
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    (fake, id)
}

fn fire(fake: &Fake, id: &str) -> Value {
    let params = json!({"definition-id":id,"run-kind":"scheduled","briefing-type":"morning"});
    serde_json::from_str(&fake.deliver(&Signals("succeeded"), SCHEDULED, params).unwrap()).unwrap()
}

fn reservation() -> Value {
    json!({"reservation": {"planId":"plan-1","autoBlockIds":["b1"],"suggestBlockIds":[],"operationId":"op-1","batchKey":"day-plan-auto:run","revisionRace":false}})
}

#[test]
fn a_succeeded_run_reserves_blocks_through_calendars_public_api_only() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "getSourceSwitches", Some(json!({"briefings": true, "planning": true})));
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    let out = fire(&fake, &id);
    assert_eq!(out["dayPlanAuto"]["planId"], "plan-1");
    let calls = fake.api_calls.borrow();
    let reserve: Vec<_> = calls.iter().filter(|(_, m, n, _)| m == "calendar" && n == "reserveAutoPlan").collect();
    assert_eq!(reserve.len(), 1);
    assert_eq!(reserve[0].3["localDay"], "2026-11-11");
    assert!(calls.iter().all(|(person, module, ..)| person == A && module != "plans"));
    let stored = fake.runs.borrow()[0]["source_metadata"].clone();
    assert_eq!(stored["dayPlanAuto"]["operationId"], "op-1");
    assert_eq!(stored["dayPlanAuto"].as_object().unwrap().len(), 3);
}

#[test]
fn a_person_who_turned_planning_off_gets_no_reservation() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "getSourceSwitches", Some(json!({"briefings": true, "planning": false})));
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    let out = fire(&fake, &id);
    assert!(out.get("dayPlanAuto").is_none());
    assert!(fake.api_calls.borrow().iter().all(|(_, _, name, _)| name != "reserveAutoPlan"));
}

#[test]
fn a_blocked_or_failed_run_never_reaches_calendar() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    fake.definitions.borrow_mut()[0]["selected_tool_names"] = json!(["tasks.delete"]);
    fire(&fake, &id);
    assert!(fake.api_calls.borrow().iter().all(|(_, _, name, _)| name != "reserveAutoPlan"));
}

#[test]
fn a_calendar_failure_does_not_lose_the_briefing() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "reserveAutoPlan", None);
    let out = fire(&fake, &id);
    assert_eq!(out["status"], "created");
    assert_eq!(fake.runs.borrow().len(), 1);
    assert!(out.get("dayPlanAuto").is_none());
}

#[test]
fn a_repeated_fire_resumes_the_unfinished_batch_and_adds_nothing() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "getSourceSwitches", Some(json!({"briefings": true, "planning": true})));
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    fire(&fake, &id);
    fake.answer(A, "calendar", "findUnfinishedBatch", Some(json!({"operationId": "op-1"})));
    fake.advance(60_000);
    let again = fire(&fake, &id);
    assert_eq!(again["status"], "duplicate");
    assert_eq!(again["dayPlanAuto"]["operationId"], "op-1");
    assert_eq!(fake.runs.borrow().len(), 1);
    let reserves = fake.api_calls.borrow().iter().filter(|(_, _, n, _)| n == "reserveAutoPlan").count();
    assert_eq!(reserves, 1);
}

#[test]
fn the_briefing_text_never_reaches_a_job_payload_or_a_notification() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    fire(&fake, &id);
    assert!(!format!("{:?}", fake.jobs.borrow()).contains(SECRET));
    assert!(!format!("{:?}", fake.notifications.borrow()).contains(SECRET));
    assert!(!format!("{:?}", fake.queue.borrow()).contains(SECRET));
    let reserve_calls: Vec<_> = fake.api_calls.borrow().iter().filter(|(_, _, n, _)| n == "reserveAutoPlan").cloned().collect();
    // The signal summary is the person's own derived text, sent to their own Calendar only.
    assert!(reserve_calls.iter().all(|(person, module, ..)| person == A && module == "calendar"));
    assert!(!fake.runs.borrow()[0]["source_metadata"]["dayPlanAuto"].to_string().contains(SECRET));
}

#[test]
fn a_calendar_that_cannot_report_the_switches_is_treated_as_everything_off() {
    let (fake, id) = setup();
    fake.answer(A, "calendar", "getSourceSwitches", None);
    fake.answer(A, "calendar", "reserveAutoPlan", Some(reservation()));
    let out = fire(&fake, &id);
    assert!(out.get("dayPlanAuto").is_none());
    assert!(fake.api_calls.borrow().iter().all(|(_, _, name, _)| name != "reserveAutoPlan"));
}
