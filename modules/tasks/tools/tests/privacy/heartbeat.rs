use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

// Remove the actual owner predicate, leaving RLS and real shared rows intact.
struct OwnerControl {
    next: Arc<dyn Ports>,
    remove: AtomicBool,
}
impl Ports for OwnerControl {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let mut request = request.clone();
        if self.remove.load(Ordering::SeqCst)
            && port == "db"
            && request.operation == "query"
            && request.resource == TASKS
        {
            let mut query: Query = serde_json::from_value(request.parameters)?;
            if let Filter::And { filters } = &mut query.filter {
                filters.retain(|f| *f != Filter::Owned);
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
fn compiled_heartbeat_is_bounded_read_only_and_owner_only_with_removal_control() {
    let mut f = Fixture::open_with(true);
    let task = f.route(
        f.owner,
        "POST",
        "/tasks",
        json!({"title":"Private due task","dueAt":"2020-01-01T00:00:00Z","priority":4,"recurrence":{"freq":"daily","interval":1,"occurrence_date":"2020-01-01"}}),
    );
    let id = task["body"]["task"]["id"].as_str().unwrap();
    let data = f
        .tool(f.owner, "tasks.heartbeatWindow", json!({"limit":1}))
        .unwrap();
    assert_eq!(data["data"]["items"][0]["title"], "Private due task");
    assert_eq!(data["data"]["items"][0]["kind"], "task_overdue");
    assert_eq!(data["data"]["truncated"], false);
    for actor in [f.other, f.admin] {
        assert_eq!(
            f.tool(actor, "tasks.heartbeatWindow", json!({})).unwrap()["data"]["items"],
            json!([])
        );
    }
    for input in [
        json!({"ownerUserId":f.owner}),
        json!({"limit":0}),
        json!({"limit":21}),
        json!({"horizonHours":49}),
        json!({"limit":"1"}),
    ] {
        assert!(f.tool(f.owner, "tasks.heartbeatWindow", input).is_err());
    }
    // Shared visibility does not authorize background reading.
    f.rt.block_on(f.db.execute("INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')", &[&id.parse::<Uuid>().unwrap(),&f.owner,&f.other])).unwrap();
    let control = Arc::new(OwnerControl {
        next: f.ports.clone(),
        remove: AtomicBool::new(false),
    });
    f.ports = control.clone();
    for remove in [false, true, false] {
        control.remove.store(remove, Ordering::SeqCst);
        let assert_private = || {
            assert_eq!(
                f.tool(f.other, "tasks.heartbeatWindow", json!({})).unwrap()["data"]["items"],
                json!([]),
                "background reads must exclude shared tasks"
            )
        };
        if remove {
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(assert_private)).is_err(),
                "owner-guard removal must fail the same privacy assertion"
            );
        } else {
            assert_private();
        }
        println!("PASS heartbeat privacy assertion: owner predicate removed={remove}");
    }
    let before: i64 =
        f.rt.block_on(f.db.query_one(
            "SELECT count(*) FROM app.tasks WHERE owner_user_id=$1",
            &[&f.owner],
        ))
        .unwrap()
        .get(0);
    f.tool(f.owner, "tasks.heartbeatWindow", json!({})).unwrap();
    let after: i64 =
        f.rt.block_on(f.db.query_one(
            "SELECT count(*) FROM app.tasks WHERE owner_user_id=$1",
            &[&f.owner],
        ))
        .unwrap()
        .get(0);
    assert_eq!(before, after, "heartbeat must not write or roll recurrence");
}
