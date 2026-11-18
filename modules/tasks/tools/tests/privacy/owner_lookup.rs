//! Removal control changes the real query predicate, never the database response.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct LookupControl {
    next: Arc<dyn Ports>,
    remove_owned: AtomicBool,
    inserts: AtomicUsize,
}
impl Ports for LookupControl {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let mut request = request.clone();
        if port == "db" && request.operation == "query" && request.resource == TASKS {
            let mut query: Query = serde_json::from_value(request.parameters.clone())?;
            if query.kind == moss_module_sdk::query::Kind::Insert {
                self.inserts.fetch_add(1, Ordering::SeqCst);
            }
            if self.remove_owned.load(Ordering::SeqCst) {
                if let Filter::And { filters } = &mut query.filter {
                    filters.retain(|f| *f != Filter::Owned);
                }
            }
            request.parameters = serde_json::to_value(query)?;
        }
        self.next.invoke(scope, port, &request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn view_shared_completion_retry_requires_owner_before_successor_insert() {
    for missing_next in [false, true] {
        let mut f = Fixture::open_with(true);
        let task = f.route(
            f.owner,
            "POST",
            "/tasks",
            json!({
                "title":"Shared retry fixture",
                "recurrence":{"freq":"monthly","interval":1,"occurrence_date":"2099-05-01"}
            }),
        );
        assert_eq!(task["status"], 201);
        let id = task["body"]["task"]["id"].as_str().unwrap();
        let path = format!("/tasks/{id}");
        assert_eq!(
            f.route(f.owner, "PATCH", &path, json!({"status":"done"}))["status"],
            200
        );
        if missing_next {
            let tasks = f.route(f.owner, "GET", "/tasks", Value::Null);
            let next = tasks["body"]["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["source"] == "recurrence")
                .unwrap();
            let next_id = next["id"].as_str().unwrap().parse::<Uuid>().unwrap();
            f.rt.block_on(f.db.execute(
                "DELETE FROM app.tasks WHERE id=$1 AND owner_user_id=$2",
                &[&next_id, &f.owner],
            ))
            .unwrap();
        }
        let completed = f.route(f.owner, "GET", &path, Value::Null);
        f.rt.block_on(f.db.execute(
            "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')",
            &[&id.parse::<Uuid>().unwrap(), &f.owner, &f.other],
        )).unwrap();
        assert_eq!(f.route(f.other, "GET", &path, Value::Null)["status"], 200);
        let control = Arc::new(LookupControl {
            next: f.ports.clone(),
            remove_owned: AtomicBool::new(false),
            inserts: AtomicUsize::new(0),
        });
        f.ports = control.clone();
        for removed in [false, true, false] {
            control.remove_owned.store(removed, Ordering::SeqCst);
            for channel in ["http", "tool", "job"] {
                control.inserts.store(0, Ordering::SeqCst);
                let result = match channel {
                    "http" => Ok(f.route(f.other, "PATCH", &path, json!({"status":"done"}))),
                    "tool" => f.tool(
                        f.other,
                        "tasks.updateStatus",
                        json!({"taskId":id,"status":"done"}),
                    ),
                    _ => f
                        .host
                        .call(
                            &f.wasm,
                            f.manifest.clone(),
                            AccessContext::new(f.other, "shared-retry"),
                            f.ports.clone(),
                            "job",
                            &json!({"queue":"tasks-deferred-status","parameters":{
                                "task-id":id,"requested-status":"done"
                            }})
                            .to_string(),
                        )
                        .and_then(|s| Ok(serde_json::from_str::<Value>(&s)?)),
                };
                let assert_refused = || {
                    assert_eq!(
                        control.inserts.load(Ordering::SeqCst),
                        0,
                        "view-only retries must not attempt next-occurrence inserts"
                    );
                    let value = result.as_ref().unwrap();
                    match channel {
                        "http" => assert_eq!(value["status"], 404),
                        "tool" => assert_eq!(value, &json!({"data":{"error":"Task not found"}})),
                        _ => assert_eq!(value, &json!({"taskId":id,"updated":false,"status":null})),
                    }
                };
                if removed {
                    assert_eq!(control.inserts.load(Ordering::SeqCst), 1);
                    assert!(
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(assert_refused))
                            .is_err()
                    );
                    // Remove only any synthetic row created by the deliberately stripped guard.
                    f.rt.block_on(f.db.execute("DELETE FROM app.tasks WHERE owner_user_id=$1 AND title='Shared retry fixture'", &[&f.other])).unwrap();
                } else {
                    assert_refused();
                    let count: i64 = f.rt.block_on(f.db.query_one(
                        "SELECT count(*) FROM app.tasks WHERE owner_user_id IN ($1,$2) AND title='Shared retry fixture'",
                        &[&f.owner, &f.other],
                    )).unwrap().get(0);
                    assert_eq!(count, if missing_next { 1 } else { 2 });
                }
                assert_eq!(f.route(f.owner, "GET", &path, Value::Null), completed);
                println!("PASS shared completion owner guard: channel={channel}, missing_next={missing_next}, removed={removed}");
            }
        }
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn view_shared_parent_is_refused_before_any_breakdown_insert() {
    let mut f = Fixture::open_with(true);
    let parent = f.route(f.owner, "POST", "/tasks", json!({"title":"Shared parent"}));
    let id = parent["body"]["task"]["id"].as_str().unwrap();
    f.rt.block_on(f.db.execute(
        "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')",
        &[&id.parse::<Uuid>().unwrap(), &f.owner, &f.other],
    )).unwrap();
    assert_eq!(
        f.tool(f.other, "tasks.get", json!({"taskId":id})).unwrap()["data"]["task"]["id"],
        id
    );
    let control = Arc::new(LookupControl {
        next: f.ports.clone(),
        remove_owned: AtomicBool::new(false),
        inserts: AtomicUsize::new(0),
    });
    f.ports = control.clone();
    for remove in [false, true, false] {
        control.remove_owned.store(remove, Ordering::SeqCst);
        for route in [false, true] {
            control.inserts.store(0, Ordering::SeqCst);
            if route {
                let response = f.route(
                    f.other,
                    "POST",
                    &format!("/tasks/{id}/breakdown"),
                    json!({"steps":["Forbidden"]}),
                );
                if !remove {
                    assert_eq!(response["status"], 500);
                }
            } else {
                let result = f.tool(
                    f.other,
                    "tasks.breakDown",
                    json!({"taskId":id,"steps":["Forbidden"]}),
                );
                if !remove {
                    assert!(result.is_err());
                }
            }
            // With Owned stripped, the real shared row is read and an insert
            // is attempted. The no-insert assertion fails at this exact guard,
            // regardless of any later checks. This is a disposable database.
            assert_eq!(control.inserts.load(Ordering::SeqCst), usize::from(remove));
            println!(
                "PASS shared-parent owner lookup: route={route}, removed={remove}, attempted inserts={}",
                control.inserts.load(Ordering::SeqCst)
            );
        }
    }
}
