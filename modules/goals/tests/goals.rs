mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

fn create(f: &Fake, title: &str) -> (u16, Value) {
    f.route("POST", "/goals", &[], json!({"title":title,"desiredOutcome":"Done well"}))
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

    let (status, changed) = f.route("PATCH", "/goals/:id", &[("id", &id)], json!({"status":"completed"}));
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
    assert_eq!(f.route("POST", "/goals", &[], json!({"desiredOutcome":"x"})).0, 400);
    assert_eq!(f.route("POST", "/goals", &[], json!({"title":"","desiredOutcome":"x"})).0, 400);
    assert_eq!(f.route("POST", "/goals", &[], json!({"title":"t","desiredOutcome":"x","priority":9})).0, 400);
    assert_eq!(f.route("POST", "/goals", &[], json!({"title":"t","desiredOutcome":"x","reviewCadence":"yearly"})).0, 400);
    let missing = "99999999-9999-4999-8999-999999999999";
    assert_eq!(f.route("GET", "/goals/:id", &[("id", missing)], json!(null)),
        (404, json!({"error":"Goal not found"})));
    assert_eq!(f.route("GET", "/goals/:id", &[("id", "nope")], json!(null)).0, 400);
    assert_eq!(f.route("GET", "/nope", &[], json!(null)).0, 404);
}

#[test]
fn a_second_person_sees_none_of_it() {
    let f = Fake::new();
    let (_, goal) = create(&f, "Private goal");
    let id = goal["id"].as_str().unwrap().to_owned();
    f.as_actor(B);
    assert_eq!(f.route("GET", "/goals", &[], json!(null)).1, json!([]));
    assert_eq!(f.route("GET", "/goals/:id", &[("id", &id)], json!(null)).0, 404);
    assert_eq!(f.route("PATCH", "/goals/:id", &[("id", &id)], json!({"title":"Stolen"})).0, 500);
    f.as_actor(A);
    assert_eq!(f.route("GET", "/goals/:id", &[("id", &id)], json!(null)).1["title"], "Private goal");
}

#[test]
fn clearing_a_field_and_keeping_it_when_omitted() {
    let f = Fake::new();
    let (_, goal) = f.route("POST", "/goals", &[], json!({"title":"t","desiredOutcome":"x","targetAt":"2030-01-01T00:00:00.000Z"}));
    let id = goal["id"].as_str().unwrap().to_owned();
    let (_, kept) = f.route("PATCH", "/goals/:id", &[("id", &id)], json!({"blockerSummary":"blocked"}));
    assert_eq!(kept["targetAt"], "2030-01-01T00:00:00.000Z");
    let (_, cleared) = f.route("PATCH", "/goals/:id", &[("id", &id)], json!({"targetAt":null,"blockerSummary":null}));
    assert_eq!(cleared["targetAt"], Value::Null);
    assert_eq!(cleared["blockerSummary"], "");
}
