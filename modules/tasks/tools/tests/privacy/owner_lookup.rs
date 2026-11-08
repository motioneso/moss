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
                    f.other, "POST", &format!("/tasks/{id}/breakdown"),
                    json!({"steps":["Forbidden"]}),
                );
                if !remove { assert_eq!(response["status"], 500); }
            } else {
                let result = f.tool(
                    f.other, "tasks.breakDown",
                    json!({"taskId":id,"steps":["Forbidden"]}),
                );
                if !remove { assert!(result.is_err()); }
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
