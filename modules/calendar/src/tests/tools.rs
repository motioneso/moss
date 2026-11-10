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
fn source_switch_patch_reaches_the_host_and_bad_bodies_do_not() {
    struct Sources;
    impl Host for Sources {
        fn call(&self, port: &str, operation: &str, resource: &str, body: Value) -> Result<Value> {
            assert_eq!(
                (port, operation, resource),
                ("kv", "set", "calendar.source-behaviors")
            );
            assert_eq!(body, json!({"planning":false}));
            Ok(json!({"briefings":true,"planning":false}))
        }
    }
    let route = |host: &dyn Host, body: Value| -> Value {
        struct Dyn<'a>(&'a dyn Host);
        impl Host for Dyn<'_> {
            fn call(&self, a: &str, b: &str, c: &str, d: Value) -> Result<Value> {
                self.0.call(a, b, c, d)
            }
        }
        serde_json::from_str(
            &handle(
                &Dyn(host),
                "route",
                &json!({"method":"PATCH","path":"/source-behaviors","params":{},"query":{},"body":body})
                    .to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    };
    let saved = route(&Sources, json!({"planning":false}));
    assert_eq!(saved["status"], 200);
    assert_eq!(saved["body"], json!({"briefings":true,"planning":false}));
    for bad in [
        json!({}),
        json!({"planning":"off"}),
        json!({"writeback":true}),
        json!([true]),
    ] {
        assert_eq!(route(&NoCalls, bad)["status"], 400);
    }
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
fn settings_reject_invalid_values_before_host_access() {
    for body in [
        json!(null),
        json!([]),
        json!({"lookaheadDays":3}),
        json!({"prepTaskMode":"trusted_auto"}),
        json!({"timeBlockMode":true}),
        json!({"createTasks":"yes"}),
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
            json!({"date":"2026-12-15","timeZone":null}),
            400,
        ),
        (
            "POST",
            "/day-plans",
            json!({"date":"2026-12-15","sourceRunId":"  "}),
            400,
        ),
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
        (json!(" Pacific/Auckland "), "America/Los_Angeles"),
        (json!("Pacific/Auckland"), "Pacific/Auckland"),
    ] {
        let response: Value = serde_json::from_str(&handle(&Locale(stored, zone), "route", &json!({
            "method":"GET","path":"/day-plan","params":{},"query":{"date":"2026-12-15"},"body":null
        }).to_string()).unwrap()).unwrap();
        assert_eq!(response["status"], 200);
        assert!(response["body"]["plan"].is_null());
    }
}

struct SavedRead {
    visible: bool,
    calls: std::cell::RefCell<Vec<String>>,
}
impl Host for SavedRead {
    fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
        self.calls.borrow_mut().push(resource.into());
        assert!(matches!((port, op), ("db", "query") | ("kv", "get")));
        match resource {
            "app.day_plans" if self.visible => Ok(json!([{
                "id":"plan","local_day":"2026-11-08","time_zone":"UTC","revision":1,
                "source_run_id":"run", "evening_intent":{
                    "priorityTaskIds":["visible","missing"],
                    "corrections":[{"taskId":"visible","note":"Keep","source":"actor"}],
                    "commitments":[{"taskId":"shared","decision":"commit"}]
                }
            }])),
            "app.day_plans" => Ok(json!([])),
            "app.day_plan_blocks" => Ok(
                json!([{"id":"block","kind":"task","task_id":"missing","title":"Stored title","position":0}]),
            ),
            "calendar.task-reference" => Ok(json!({"task": match body["id"].as_str().unwrap() {
                "visible" | "shared" => json!({"id":body["id"],"ownerUserId":"public-interface-owner","title":"Live title","status":"todo","dueAt":null,"doAt":null,"effort":null,"privateExtra":"must not be forwarded"}),
                _ => Value::Null,
            }})),
            "calendar.briefing-reference" => Ok(
                json!({"run":{"id":"run","briefingType":"evening","status":"complete","createdAt":"2026-11-08T00:00:00.000Z","privateExtra":"must not be forwarded"}}),
            ),
            _ => panic!("unexpected read {resource}"),
        }
    }
}
fn saved_read(host: &impl Host) -> Value {
    let reply: Value = serde_json::from_str(
        &handle(
            host,
            "route",
            &json!({
                "method":"GET","path":"/day-plan","params":{},
                "query":{"date":"2026-11-08","timeZone":"UTC"},"body":null
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(reply["status"], 200, "{reply}");
    reply["body"].clone()
}
#[test]
fn saved_plan_read_projects_references_in_first_seen_order_without_changing_plan() {
    let host = SavedRead {
        visible: true,
        calls: Default::default(),
    };
    let out = saved_read(&host);
    assert_eq!(out["unavailableTaskIds"], json!(["missing"]));
    assert_eq!(
        out["tasks"],
        json!([
            {"id":"visible","title":"Live title","status":"todo","dueAt":null,"doAt":null,"effort":null},
            {"id":"shared","title":"Live title","status":"todo","dueAt":null,"doAt":null,"effort":null}
        ])
    );
    assert_eq!(
        out["sourceRun"],
        json!({"id":"run","briefingType":"evening","status":"complete","createdAt":"2026-11-08T00:00:00.000Z"})
    );
    assert_eq!(out["sourceRunUnavailable"], false);
    assert_eq!(out["plan"]["blocks"][0]["title"], "Stored title");
    assert_eq!(
        host.calls
            .borrow()
            .iter()
            .filter(|r| r.as_str() == "calendar.task-reference")
            .count(),
        3
    );
}
#[test]
fn absent_or_foreign_plan_does_not_resolve_any_references() {
    let host = SavedRead {
        visible: false,
        calls: Default::default(),
    };
    assert_eq!(
        saved_read(&host),
        json!({"plan":null,"tasks":[],"unavailableTaskIds":[],"sourceRun":null,"sourceRunUnavailable":false})
    );
    assert_eq!(*host.calls.borrow(), vec!["app.day_plans"]);
}

#[test]
fn unavailable_and_mismatched_public_references_keep_the_stored_plan_readable() {
    struct Unavailable(bool);
    impl Host for Unavailable {
        fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
            if port == "kv" {
                if self.0 {
                    return Err(moss_module_sdk::Error::new("adapter unavailable"));
                }
                return Ok(json!({
                    "task":{"id":"different","title":"Wrong task","status":"todo"},
                    "run":{"id":"different","briefingType":"evening","status":"succeeded","createdAt":"2026-11-08T00:00:00.000Z"}
                }));
            }
            SavedRead {
                visible: true,
                calls: Default::default(),
            }
            .call(port, op, resource, body)
        }
    }
    for failure in [true, false] {
        let out = saved_read(&Unavailable(failure));
        assert_eq!(
            out["unavailableTaskIds"],
            json!(["visible", "missing", "shared"])
        );
        assert_eq!(out["tasks"], json!([]));
        assert_eq!(out["sourceRun"], Value::Null);
        assert_eq!(out["sourceRunUnavailable"], true);
        assert_eq!(out["plan"]["blocks"][0]["title"], "Stored title");
    }
}

#[test]
fn visible_events_resolve_named_days_in_the_saved_zone_and_summarize_only_live_answers() {
    use moss_calendar::visible_events::{project, summarize, window_range};
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-08T01:00:00Z")
        .unwrap()
        .to_utc();
    let (start, end, label) = window_range("today", now, "America/New_York").unwrap();
    assert_eq!(label, "today");
    assert_eq!(start.to_rfc3339(), "2026-11-07T05:00:00+00:00");
    // The local day is still 7 November in New York and the clocks are on standard time.
    let (start, end2, _) = window_range("tomorrow", now, "America/New_York").unwrap();
    assert_eq!(start, end);
    assert_eq!(end2.to_rfc3339(), "2026-11-09T05:00:00+00:00");
    assert!(window_range("someday", now, "").is_none());
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-09T12:00:00Z")
        .unwrap()
        .to_utc();
    let offset = window_range("today", now, "+05:30").unwrap();
    assert_eq!(offset.0.to_rfc3339(), "2026-11-08T18:30:00+00:00");
    assert!(window_range("today", now, "Not/AZone").is_none());
    let blank = vec![json!({"title":"\u{feff}"}), json!({"title":"B"})];
    assert_eq!(
        summarize(&blank, "today", false, false).unwrap(),
        "2 events today. Next: B."
    );

    let item = |title: &str, source: &str| {
        json!({"eventKey":"k","account":{"connectorAccountId":"a","providerLabel":"G"},
            "title":title,"startsAt":"s","endsAt":"e","allDay":false,"location":null,
            "attendeeCount":0,"flags":[],"source":source,"degradedReason":null})
    };
    let live = json!({"items":[item("A","live"),item("B","live")],
        "accounts":[{"source":"live","degradedReason":null}],"gaps":[]});
    let out = project(&live, Some("today")).unwrap();
    assert_eq!(out["data"]["summary"], "2 events today. Next: A; B.");
    assert_eq!(out["data"]["events"][0]["id"], "k");
    assert!(project(&live, None).unwrap()["data"]
        .get("summary")
        .is_none());
    let cached =
        json!({"items":[],"accounts":[{"source":"cache","degradedReason":null}],"gaps":[]});
    assert!(project(&cached, Some("today")).unwrap()["data"]
        .get("summary")
        .is_none());
    let gap = json!({"items":[],"accounts":[],"gaps":[{}]});
    assert!(project(&gap, Some("today")).unwrap()["data"]
        .get("summary")
        .is_none());
    assert!(project(&json!({}), None).is_err());
    assert_eq!(
        summarize(&[], "today", false, false).unwrap(),
        "No events today."
    );
    assert!(summarize(&[], "today", false, true).is_none());
    let long = vec![json!({"title":"x".repeat(90)})];
    assert_eq!(
        summarize(&long, "today", false, false).unwrap(),
        format!("1 event today. Next: {}....", "x".repeat(77))
    );
}

#[test]
fn visible_events_fail_closed_without_the_connectors_interface() {
    struct Missing;
    impl Host for Missing {
        fn call(&self, port: &str, _: &str, resource: &str, _: Value) -> Result<Value> {
            assert_eq!((port, resource), ("api", "connectors"));
            Err(moss_module_sdk::Error::new("missing"))
        }
    }
    let raw = handle(
        &Missing,
        "tool",
        &json!({"tool":"calendar.listVisibleEvents","parameters":{"startsAfter":"2026-11-08T00:00:00Z"}}).to_string(),
    );
    assert_eq!(raw.unwrap_err(), "Calendar data is unavailable");
}

#[test]
fn trusted_settings_port_stays_strict_despite_http_coercion() {
    for body in [
        json!({"ownerUserId":"foreign"}),
        json!({"lookaheadDays":"1"}),
        json!({"blockTime":null}),
        json!({"timeBlockMode":["auto"]}),
    ] {
        assert!(moss_calendar::settings::patch(&body).is_err());
    }
}

#[test]
fn http_settings_normalize_before_the_scoped_host_call() {
    struct Settings;
    impl Host for Settings {
        fn call(&self, _: &str, _: &str, _: &str, body: Value) -> Result<Value> {
            assert_eq!(
                body,
                json!({"lookaheadDays":1,"timeBlockMode":"auto","blockTime":false})
            );
            Ok(json!({}))
        }
    }
    let response: Value = serde_json::from_str(
        &handle(
            &Settings,
            "route",
            &json!({
                "method":"PATCH", "path":"/briefing-settings", "body":{
                    "lookaheadDays":"1", "timeBlockMode":["auto"], "blockTime":null,
                    "ownerUserId":"foreign", "unrecognized":{"timeBlockMode":"auto"}
                }
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response["status"], 200);
}

mod provider {
    use super::*;
    use chrono::{DateTime, Utc};
    use moss_calendar::provider_tools::resolve_window;
    use std::cell::RefCell;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }
    fn iso(w: DateTime<Utc>) -> String {
        w.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn relative_request_means_tomorrow_morning_in_the_saved_zone() {
        let now = at("2026-11-10T03:00:00Z"); // still Nov 9 in New York
        let w = resolve_window(&json!({}), now, "America/New_York").unwrap();
        assert_eq!(iso(w.start), "2026-11-10T14:00:00.000Z");
        assert_eq!(iso(w.end), "2026-11-10T17:00:00.000Z");
        assert_eq!((w.duration_minutes, w.title.as_str()), (120, "Focus time"));
    }

    #[test]
    fn bands_dates_and_fixed_offsets() {
        let now = at("2026-11-10T12:00:00Z");
        let w = resolve_window(
            &json!({"date":"2026-07-01","partOfDay":"evening","title":"  Plan  ","durationMinutes":5000.9}),
            now,
            "+05:30",
        )
        .unwrap();
        assert_eq!(iso(w.start), "2026-07-01T11:30:00.000Z");
        assert_eq!(iso(w.end), "2026-07-01T15:30:00.000Z");
        assert_eq!((w.duration_minutes, w.title.as_str()), (480, "Plan"));
        let short = resolve_window(&json!({"durationMinutes":3}), now, "UTC").unwrap();
        assert_eq!(short.duration_minutes, 15);
        let text = resolve_window(&json!({"durationMinutes":"60"}), now, "UTC").unwrap();
        assert_eq!(text.duration_minutes, 120);
    }

    #[test]
    fn explicit_start_wins_and_bad_input_is_refused() {
        let now = at("2026-11-10T12:00:00Z");
        let w = resolve_window(
            &json!({"start":"2026-11-12T10:00:00-05:00","date":"nonsense","durationMinutes":45}),
            now,
            "UTC",
        )
        .unwrap();
        assert_eq!(iso(w.start), "2026-11-12T15:00:00.000Z");
        assert_eq!(iso(w.end), "2026-11-12T15:45:00.000Z");
        for (input, message) in [
            (
                json!({"start":"soon"}),
                "start must be a valid RFC3339 datetime",
            ),
            (
                json!({"date":"2026-1-1"}),
                "date must be in yyyy-mm-dd format",
            ),
            (
                json!({"date":"2026-02-30"}),
                "date is not a valid calendar date",
            ),
            (
                json!({"partOfDay":"night"}),
                "partOfDay must be morning, afternoon or evening",
            ),
        ] {
            assert_eq!(
                resolve_window(&input, now, "UTC").unwrap_err().message,
                message
            );
        }
        assert_eq!(
            resolve_window(&json!({}), now, "Mars/Base")
                .unwrap_err()
                .status,
            503
        );
    }

    struct Recorder(RefCell<Vec<(String, Value)>>);
    impl Host for Recorder {
        fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
            match (port, op, resource) {
                ("context", "read", "call") => Ok(json!({"now":"2026-11-10T12:00:00Z"})),
                ("kv", "get", "calendar.chat-context") => Ok(json!({"timezone":"UTC"})),
                ("api", _, "connectors") => {
                    self.0.borrow_mut().push((
                        body["name"].as_str().unwrap().to_string(),
                        body["parameters"].clone(),
                    ));
                    Ok(json!({"created":true}))
                }
                _ => panic!("unexpected call {port}/{op}/{resource}"),
            }
        }
    }
    fn run(host: &Recorder, tool: &str, parameters: Value) -> Value {
        let raw = handle(
            host,
            "tool",
            &json!({"tool":tool,"parameters":parameters}).to_string(),
        );
        serde_json::from_str(&raw.unwrap()).unwrap()
    }

    #[test]
    fn create_sends_the_requested_window_to_connectors() {
        let host = Recorder(RefCell::new(vec![]));
        let out = run(
            &host,
            "calendar.createEvent",
            json!({"partOfDay":"afternoon","title":"Deep work"}),
        );
        assert_eq!(out["data"]["created"], true);
        let calls = host.0.borrow();
        assert_eq!(calls[0].0, "createCalendarEvent");
        assert_eq!(
            calls[0].1,
            json!({"windowStart":"2026-11-11T12:00:00.000Z","windowEnd":"2026-11-11T17:00:00.000Z",
                "durationMinutes":120,"title":"Deep work"})
        );
    }

    #[test]
    fn delete_and_reschedule_validate_before_any_provider_call() {
        let host = Recorder(RefCell::new(vec![]));
        let out = run(&host, "calendar.deleteEvent", json!({"eventId":""}));
        assert_eq!(out["data"]["deleted"], false);
        assert_eq!(out["data"]["message"], "eventId is required");
        let out = run(
            &host,
            "calendar.rescheduleEvent",
            json!({"eventRef":"e","newStart":"x","newEnd":"2026-11-12T10:00:00Z"}),
        );
        assert_eq!(out["data"]["ok"], false);
        assert_eq!(out["data"]["reason"], "not_found");
        assert!(host.0.borrow().is_empty());

        run(
            &host,
            "calendar.deleteEvent",
            json!({"eventId":"abc","displayTitle":"x"}),
        );
        run(
            &host,
            "calendar.rescheduleEvent",
            json!({"eventRef":"abc","newStart":"2026-11-12T10:00:00+01:00","newEnd":"2026-11-12T11:00:00Z"}),
        );
        let calls = host.0.borrow();
        assert_eq!(
            calls[0],
            ("deleteCalendarEvent".to_string(), json!({"eventId":"abc"}))
        );
        assert_eq!(
            calls[1],
            (
                "rescheduleCalendarEvent".to_string(),
                json!({"eventRef":"abc","newStart":"2026-11-12T09:00:00.000Z","newEnd":"2026-11-12T11:00:00.000Z"})
            )
        );
    }

    #[test]
    fn provider_tools_fail_closed_without_connectors() {
        struct Missing;
        impl Host for Missing {
            fn call(&self, port: &str, _: &str, resource: &str, _: Value) -> Result<Value> {
                match (port, resource) {
                    ("context", _) => Ok(json!({"now":"2026-11-10T12:00:00Z"})),
                    ("kv", _) => Ok(json!({})),
                    _ => Err(moss_module_sdk::Error::new("missing")),
                }
            }
        }
        for (tool, p) in [
            ("calendar.createEvent", json!({})),
            ("calendar.deleteEvent", json!({"eventId":"a"})),
            (
                "calendar.rescheduleEvent",
                json!({"eventRef":"a","newStart":"2026-11-12T10:00:00Z","newEnd":"2026-11-12T11:00:00Z"}),
            ),
        ] {
            let raw = handle(
                &Missing,
                "tool",
                &json!({"tool":tool,"parameters":p}).to_string(),
            );
            assert_eq!(raw.unwrap_err(), "Calendar data is unavailable");
        }
    }
}
