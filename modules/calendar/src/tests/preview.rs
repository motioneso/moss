//! Day-plan preview: calendar-busy conflicts come from Connectors' calendar context.
use moss_calendar::handle;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

const PLAN: &str = "11111111-1111-4111-8111-111111111111";
const BLOCK: &str = "33333333-3333-4333-8333-333333333333";

struct Script {
    context: std::result::Result<Value, ()>,
}

impl Host for Script {
    fn call(&self, port: &str, _: &str, resource: &str, _: Value) -> Result<Value> {
        Ok(match (port, resource) {
            ("db", "app.day_plans") => json!([{"id":PLAN,"local_day":"2026-03-02","time_zone":"UTC",
                "revision":1,"source_run_id":null,"evening_intent":{}}]),
            ("db", "app.day_plan_blocks") => json!([{"id":BLOCK,"kind":"task","task_id":null,"title":"Write",
                "position":0,"actual_placement":null,
                "pending_change":{"kind":"add","startsAt":"2026-03-02T10:00:00.000Z","durationMinutes":60}}]),
            ("context", _) => json!({"actorUserId":"u1"}),
            ("api", "connectors") => return self.context.clone().map_err(|_| Error::new("no connectors")),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn run(host: &Script) -> Value {
    let request = json!({"method":"POST","path":"/day-plans/:id/preview","params":{"id":PLAN},"query":{},
        "body":{"expectedRevision":1,"selectedChangeBlockIds":[BLOCK]}});
    let reply: Value = serde_json::from_str(&handle(host, "route", &request.to_string()).unwrap()).unwrap();
    assert_eq!(reply["status"], 200, "{reply}");
    reply["body"].clone()
}

fn event(key: &str, start: &str, end: &str) -> Value {
    json!({"eventKey":key,"title":"Standup","startsAt":start,"endsAt":end,"allDay":false,
           "account":{"providerLabel":"Google"}})
}

fn context(items: Vec<Value>, source: &str, gaps: Vec<Value>) -> Value {
    json!({"items":items,"accounts":[{"source":source}],"gaps":gaps,"truncated":false,"asOf":"2026-03-02T08:00:00.000Z"})
}

#[test]
fn a_real_overlap_is_a_calendar_busy_conflict_and_a_live_read_is_available() {
    let host = Script { context: Ok(context(vec![event("e1", "2026-03-02T10:30:00.000Z", "2026-03-02T11:30:00.000Z")], "live", vec![])) };
    let body = run(&host);
    assert_eq!(body["calendarAvailability"], "available");
    assert_eq!(body["conflicts"][0]["kind"], "calendar_busy");
    assert_eq!(body["conflicts"][0]["calendarEvent"]["eventKey"], "e1");
    assert_eq!(body["conflicts"][0]["detail"], "Overlaps \"Standup\" on Google");
}

#[test]
fn an_event_that_does_not_overlap_is_not_a_conflict() {
    let host = Script { context: Ok(context(vec![event("e1", "2026-03-02T11:00:00.000Z", "2026-03-02T12:00:00.000Z")], "live", vec![])) };
    assert!(run(&host)["conflicts"].as_array().unwrap().is_empty());
}

#[test]
fn a_cached_answer_is_stale_and_a_gap_is_unavailable_but_known_events_still_count() {
    let cached = Script { context: Ok(context(vec![], "cache", vec![])) };
    assert_eq!(run(&cached)["calendarAvailability"], "stale");
    let gapped = Script {
        context: Ok(context(vec![event("e1", "2026-03-02T10:00:00.000Z", "2026-03-02T10:30:00.000Z")], "live", vec![json!({"reason":"auth_error"})])),
    };
    let body = run(&gapped);
    assert_eq!(body["calendarAvailability"], "unavailable");
    assert_eq!(body["conflicts"].as_array().unwrap().len(), 1);
}

#[test]
fn no_connectors_means_unavailable_with_no_busy_claims() {
    let host = Script { context: Err(()) };
    let body = run(&host);
    assert_eq!(body["calendarAvailability"], "unavailable");
    assert!(body["conflicts"].as_array().unwrap().is_empty());
}
