mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

fn create(f: &Fake, title: &str) -> (u16, Value) {
    f.route(
        "POST",
        "/goals",
        &[],
        json!({"title":title,"desiredOutcome":"Done well"}),
    )
}

#[test]
fn create_list_get_change_close_and_evidence() {
    let f = Fake::new();
    let (status, goal) = create(&f, "Ship the port");
    assert_eq!(status, 201, "{goal}");
    assert_eq!(goal["status"], "active");
    assert_eq!(goal["priority"], 3);
    assert_eq!(goal["reviewCadence"], "weekly");
    let id = goal["id"].as_str().unwrap().to_owned();

    let (status, evidence) = f.route("POST", "/goals/:id/evidence", &[("id", &id)],
        json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Halfway"}));
    assert_eq!(status, 201, "{evidence}");
    assert_eq!(evidence["goalId"], id);

    let (status, list) = f.route("GET", "/goals", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(list.as_array().unwrap().len(), 1);

    let (status, changed) = f.route(
        "PATCH",
        "/goals/:id",
        &[("id", &id)],
        json!({"status":"completed"}),
    );
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["status"], "completed");

    // A closed goal refuses new evidence.
    let (status, refused) = f.route("POST", "/goals/:id/evidence", &[("id", &id)],
        json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Late"}));
    assert_eq!(status, 409, "{refused}");
}

#[test]
fn validation_and_missing_goals_match_the_old_answers() {
    let f = Fake::new();
    assert_eq!(
        f.route("POST", "/goals", &[], json!({"desiredOutcome":"x"}))
            .0,
        400
    );
    assert_eq!(
        f.route(
            "POST",
            "/goals",
            &[],
            json!({"title":"","desiredOutcome":"x"})
        )
        .0,
        400
    );
    assert_eq!(
        f.route(
            "POST",
            "/goals",
            &[],
            json!({"title":"t","desiredOutcome":"x","priority":9})
        )
        .0,
        400
    );
    assert_eq!(
        f.route(
            "POST",
            "/goals",
            &[],
            json!({"title":"t","desiredOutcome":"x","reviewCadence":"yearly"})
        )
        .0,
        400
    );
    let missing = "99999999-9999-4999-8999-999999999999";
    assert_eq!(
        f.route("GET", "/goals/:id", &[("id", missing)], json!(null)),
        (404, json!({"error":"Goal not found"}))
    );
    assert_eq!(
        f.route("GET", "/goals/:id", &[("id", "nope")], json!(null))
            .0,
        400
    );
    assert_eq!(f.route("GET", "/nope", &[], json!(null)).0, 404);
}

#[test]
fn a_second_person_sees_none_of_it() {
    let f = Fake::new();
    let (_, goal) = create(&f, "Private goal");
    let id = goal["id"].as_str().unwrap().to_owned();
    f.as_actor(B);
    assert_eq!(f.route("GET", "/goals", &[], json!(null)).1, json!([]));
    assert_eq!(
        f.route("GET", "/goals/:id", &[("id", &id)], json!(null)).0,
        404
    );
    assert_eq!(
        f.route(
            "PATCH",
            "/goals/:id",
            &[("id", &id)],
            json!({"title":"Stolen"})
        )
        .0,
        500
    );
    f.as_actor(A);
    assert_eq!(
        f.route("GET", "/goals/:id", &[("id", &id)], json!(null)).1["title"],
        "Private goal"
    );
}

#[test]
fn clearing_a_field_and_keeping_it_when_omitted() {
    let f = Fake::new();
    let (_, goal) = f.route(
        "POST",
        "/goals",
        &[],
        json!({"title":"t","desiredOutcome":"x","targetAt":"2030-01-01T00:00:00.000Z"}),
    );
    let id = goal["id"].as_str().unwrap().to_owned();
    let (_, kept) = f.route(
        "PATCH",
        "/goals/:id",
        &[("id", &id)],
        json!({"blockerSummary":"blocked"}),
    );
    assert_eq!(kept["targetAt"], "2030-01-01T00:00:00.000Z");
    let (_, cleared) = f.route(
        "PATCH",
        "/goals/:id",
        &[("id", &id)],
        json!({"targetAt":null,"blockerSummary":null}),
    );
    assert_eq!(cleared["targetAt"], Value::Null);
    assert_eq!(cleared["blockerSummary"], "");
}

fn tool(f: &Fake, name: &str, parameters: Value) -> Value {
    let result = moss_goals_module::handle(
        f,
        "tool",
        &json!({"tool":name,"parameters":parameters}).to_string(),
    )
    .unwrap();
    serde_json::from_str(&result).unwrap()
}

#[test]
fn tools_share_route_writes_and_get_only_ten_newest_evidence_summaries() {
    let f = Fake::new();
    let created = tool(
        &f,
        "goals.create",
        json!({"title":"Ship","desiredOutcome":"Done"}),
    );
    let id = created["data"]["id"].as_str().unwrap();
    assert_eq!(
        f.route("GET", "/goals/:id", &[("id", id)], Value::Null).1,
        created["data"]
    );
    for n in 0..12 {
        let evidence = tool(
            &f,
            "goals.addEvidence",
            json!({"goalId":id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":format!("Step {n}")}),
        );
        assert_eq!(evidence["data"]["goalId"], id);
    }
    let read = tool(&f, "goals.get", json!({"goalId":id}));
    let evidence = read["data"]["evidence"].as_array().unwrap();
    assert_eq!(evidence.len(), 10);
    assert_eq!(
        evidence[0],
        json!({"evidenceKind":"progress","sourceLabel":"Note","summary":"Step 11"})
    );
    assert_eq!(evidence[9]["summary"], "Step 2");
    let changed = tool(
        &f,
        "goals.update",
        json!({"goalId":id,"status":"completed"}),
    );
    assert_eq!(changed["data"]["status"], "completed");
    assert_eq!(
        tool(&f, "goals.list", json!({}))["data"]["items"],
        f.route("GET", "/goals", &[], Value::Null).1
    );
    assert_eq!(
        tool(
            &f,
            "goals.addEvidence",
            json!({"goalId":id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Late"})
        )["data"]["error"],
        "Goal is closed"
    );
    f.as_actor(B);
    assert_eq!(
        tool(&f, "goals.list", json!({})),
        json!({"data":{"items":[]}})
    );
    assert_eq!(
        tool(&f, "goals.get", json!({"goalId":id})),
        json!({"data":{"error":"Goal not found"}})
    );
}

#[test]
fn today_filters_all_non_active_states_without_changing_priority_order() {
    let f = Fake::new();
    assert_eq!(
        f.route("GET", "/goals/today", &[], Value::Null),
        (200, json!([]))
    );
    for (n, state) in [
        "active",
        "paused",
        "blocked",
        "completed",
        "archived",
        "active",
    ]
    .iter()
    .enumerate()
    {
        let (_, goal) = f.route(
            "POST",
            "/goals",
            &[],
            json!({"title":state,"desiredOutcome":"Done","priority":if n == 0 {5} else {3}}),
        );
        f.route(
            "PATCH",
            "/goals/:id",
            &[("id", goal["id"].as_str().unwrap())],
            json!({"status":state}),
        );
    }
    let active = f.route("GET", "/goals/today", &[], Value::Null).1;
    assert_eq!(active.as_array().unwrap().len(), 2);
    assert_eq!(active[0]["priority"], 5);
    assert_eq!(active[1]["priority"], 3);
    f.as_actor(B);
    assert_eq!(
        f.route("GET", "/goals/today", &[], Value::Null).1,
        json!([])
    );
}

#[test]
fn tool_validation_and_errors_do_not_echo_private_input_or_host_failures() {
    let f = Fake::new();
    let mark = "TOOL-PRIVATE-MARKER";
    for input in [
        json!({"title":mark,"desiredOutcome":"x","priority":"5"}),
        json!({"title":mark,"desiredOutcome":"x","ownerUserId":B}),
    ] {
        assert_eq!(
            tool(&f, "goals.create", input),
            json!({"data":{"error":"Invalid Goals tool input"}})
        );
    }
    *f.db_failure.borrow_mut() = Some(mark.into());
    let result = moss_goals_module::handle(
        &f,
        "tool",
        &json!({"tool":"goals.list","parameters":{}}).to_string(),
    );
    assert!(!result.unwrap_err().to_string().contains(mark));
    let response = f.route(
        "POST",
        "/goals/tools/run",
        &[],
        json!({"tool":"goals.create","parameters":{"title":mark,"desiredOutcome":"x"}}),
    );
    assert_eq!(
        response,
        (
            403,
            json!({"error":"Goal tool unavailable or approval required"})
        )
    );
    assert_eq!(f.calls.borrow().last().unwrap().0, "tools");
}
