use moss_calendar::{handle, heartbeat};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

struct NoCalls;
impl Host for NoCalls {
    fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
        panic!("Invalid tool input must fail before any host call")
    }
}

#[test]
fn settings_patch_reaches_the_scoped_host_once() {
    struct Settings;
    impl Host for Settings {
        fn call(&self, port: &str, operation: &str, resource: &str, body: Value) -> Result<Value> {
            assert_eq!(
                (port, operation, resource),
                ("kv", "set", "calendar.briefing-settings")
            );
            assert_eq!(body, json!({"lookaheadDays":0,"timeBlockMode":"auto"}));
            Ok(json!({"calendar.briefing_lookahead_days":0,"calendar.time_block_mode":"auto"}))
        }
    }
    let response: Value = serde_json::from_str(
        &handle(
            &Settings,
            "route",
            &json!({
                "method":"PATCH","path":"/briefing-settings","params":{},"query":{},
                "body":{"lookaheadDays":0,"timeBlockMode":"auto"}
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["body"]["settings"]["lookaheadDays"], 0);
    assert_eq!(response["body"]["settings"]["timeBlockMode"], "auto");
}

#[test]
fn chat_rejects_provider_effects_and_extra_authority_before_host_access() {
    for key in [
        "startsAt",
        "endsAt",
        "durationMinutes",
        "pendingChange",
        "actualPlacement",
        "kind",
        "position",
        "blocks",
        "move",
        "remove",
        "times",
        "placement",
        "ownerUserId",
    ] {
        let mut input = json!({"planId":"plan","expectedRevision":1});
        input[key] = Value::Null;
        assert!(handle(
            &NoCalls,
            "tool",
            &json!({"tool":"calendar.dayPlanDraft","parameters":input}).to_string()
        )
        .is_err());
    }
    for input in [
        json!({}),
        json!({"planId":"plan","expectedRevision":0}),
        json!({"planId":"plan","expectedRevision":1,"additions":[{"taskId":"task","startsAt":"now"}]}),
        json!({"planId":"plan","expectedRevision":1,"additions":null}),
    ] {
        assert!(handle(
            &NoCalls,
            "tool",
            &json!({"tool":"calendar.dayPlanDraft","parameters":input}).to_string()
        )
        .is_err());
    }
}

#[test]
fn heartbeat_projection_tracks_material_change_and_bounded_boundaries() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-08T10:00:00Z")
        .unwrap()
        .to_utc();
    let mut rows = vec![
        json!({"id":"ongoing","title":"🪴","starts_at":"2026-11-08T09:00:00Z","ends_at":"2026-11-08T11:00:00Z","location":null}),
        json!({"id":"upcoming","title":"Café","starts_at":"2026-11-08T10:30:00Z","ends_at":"2026-11-08T12:00:00Z","location":"Room"}),
    ];
    let out = heartbeat::project(&rows, Some(&json!("2026-11-08T07:00:00Z")), now, 1).unwrap();
    assert_eq!(out["data"]["nextBoundaryAt"], "2026-11-08T11:00:00.000Z");
    assert_eq!(out["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(out["data"]["items"][0]["facts"]["inProgress"], true);
    assert_eq!(out["data"]["truncated"], true);
    assert_eq!(out["data"]["freshness"], "fresh");
    rows[0]["updated_at"] = json!("2026-11-08T10:00:00Z");
    let same = heartbeat::project(&rows, Some(&json!("2026-11-08T06:59:59Z")), now, 1).unwrap();
    assert_eq!(out["data"]["revision"], same["data"]["revision"]);
    assert_eq!(same["data"]["freshness"], "stale");
    rows[1]["title"] = json!("Changed beyond cap");
    let changed = heartbeat::project(&rows, None, now, 1).unwrap();
    assert_ne!(out["data"]["revision"], changed["data"]["revision"]);
    assert_eq!(changed["data"]["freshness"], "unknown");
}

#[test]
fn settings_reject_unknown_owners_and_invalid_values_before_host_access() {
    for body in [
        json!(null),
        json!([]),
        json!({"ownerUserId":"foreign"}),
        json!({"lookaheadDays":3}),
        json!({"lookaheadDays":null}),
        json!({"prepTaskMode":"trusted_auto"}),
        json!({"timeBlockMode":true}),
        json!({"createTasks":"yes"}),
        json!({"blockTime":null}),
    ] {
        let response: Value = serde_json::from_str(
            &handle(
                &NoCalls,
                "route",
                &json!({
                    "method":"PATCH","path":"/briefing-settings","body":body
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(response["status"], 400);
    }
}

#[test]
fn display_projects_the_account_assistant_name_without_persona_text() {
    struct Display;
    impl Host for Display {
        fn call(&self, _: &str, _: &str, resource: &str, _: Value) -> Result<Value> {
            Ok(match resource {
                "calendar.chat-context" => json!({"timezone":"UTC", "assistantName":"Cedar"}),
                _ => json!({}),
            })
        }
    }
    let output: Value = serde_json::from_str(
        &handle(
            &Display,
            "route",
            &json!({"method":"GET", "path":"/display-settings", "body":null}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(output["status"], 200);
    assert_eq!(output["body"]["assistantName"], "Cedar");
}

#[test]
fn original_draft_envelopes_reject_ambiguous_or_unsupported_requests_before_host_access() {
    for (method, path, body, status) in [
        (
            "POST",
            "/day-plans",
            json!({"date":"2026-12-15","localDay":"2026-12-16"}),
            400,
        ),
        (
            "POST",
            "/day-plans",
            json!({"date":"2026-12-15","eveningIntent":{}}),
            400,
        ),
        (
            "POST",
            "/day-plans",
            json!({"date":"2026-12-15","sourceRunId":"source"}),
            503,
        ),
        (
            "PATCH",
            "/day-plans/:id/draft",
            json!({"date":"2026-12-15","expectedRevision":1}),
            400,
        ),
    ] {
        let response: Value = serde_json::from_str(
            &handle(
                &NoCalls,
                "route",
                &json!({
                    "method":method,"path":path,"params":{"id":"plan"},"query":{},"body":body
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(response["status"], status);
    }
}

#[test]
fn original_day_read_uses_account_timezone_or_the_product_default() {
    struct Locale(Value, &'static str);
    impl Host for Locale {
        fn call(&self, port: &str, operation: &str, resource: &str, body: Value) -> Result<Value> {
            if (port, operation, resource) == ("kv", "get", "calendar.chat-context") {
                return Ok(json!({"timezone":self.0}));
            }
            assert_eq!(
                (port, operation, resource),
                ("db", "query", "app.day_plans")
            );
            let query: moss_module_sdk::query::Query = serde_json::from_value(body).unwrap();
            assert_eq!(
                query.filter,
                moss_module_sdk::query::Filter::And {
                    filters: vec![
                        moss_module_sdk::query::Filter::eq("local_day", "2026-12-15"),
                        moss_module_sdk::query::Filter::eq("time_zone", self.1),
                    ]
                }
            );
            Ok(json!([]))
        }
    }
    for (stored, zone) in [
        (Value::Null, "America/Los_Angeles"),
        (json!("invalid"), "America/Los_Angeles"),
        (json!("Pacific/Auckland"), "Pacific/Auckland"),
    ] {
        let response: Value = serde_json::from_str(&handle(&Locale(stored, zone), "route", &json!({
            "method":"GET","path":"/day-plan","params":{},"query":{"date":"2026-12-15"},"body":null
        }).to_string()).unwrap()).unwrap();
        assert_eq!(response["status"], 200);
        assert!(response["body"]["plan"].is_null());
    }
}
