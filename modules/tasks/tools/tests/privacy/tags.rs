use super::*;

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_tag_manager_routes_require_rls_and_keep_tasks_on_delete() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Tag manager"}));
    let list = list["body"]["list"]["id"].as_str().unwrap();
    let path = format!("/tasks/lists/{list}/tags");
    let task = f.route(
        f.owner, "POST", "/tasks", json!({"title":"Kept task","listId":list}),
    );
    let task = task["body"]["task"]["id"].as_str().unwrap();
    let assign = format!("/tasks/{task}/tags");
    let assert_hidden = |response: &Value| {
        assert_eq!(response["status"], 200);
        assert_eq!(response["body"]["tags"], json!([]));
    };
    let assert_denied = |response: &Value| assert_eq!(response["status"], 404);
    let check_private = |item: &str| {
        for actor in [f.other, f.admin] {
            assert_hidden(&f.route(actor, "GET", &path, Value::Null));
            assert_denied(&f.route(actor, "PATCH", item, json!({"name":"Forbidden"})));
            assert_denied(&f.route(actor, "DELETE", item, Value::Null));
        }
    };
    for actor in [f.other, f.admin] {
        let tag = f.route(f.owner, "POST", &path, json!({"name":"Private tag"}));
        assert_eq!(tag["status"], 201);
        let id = tag["body"]["tag"]["id"].as_str().unwrap();
        let item = format!("{path}/{id}");
        assert_eq!(f.route(f.owner, "POST", &assign, json!({"tagId":id}))["status"], 200);
        check_private(&item);
        // Host errors cannot count as assertion failures. Restore RLS even when
        // a real operation unexpectedly panics in this disposable fixture.
        f.sql("ALTER TABLE app.task_tags DISABLE ROW LEVEL SECURITY");
        let removed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (
                f.route(actor, "GET", &path, Value::Null),
                f.route(actor, "PATCH", &item, json!({"name":"Forbidden"})),
                f.route(actor, "DELETE", &item, Value::Null),
            )
        }));
        f.sql("ALTER TABLE app.task_tags ENABLE ROW LEVEL SECURITY; ALTER TABLE app.task_tags FORCE ROW LEVEL SECURITY");
        let (exposed, renamed, deleted) = removed.expect("Removed-policy calls must succeed");
        assert_eq!(exposed["body"]["tags"][0]["id"], id);
        assert_eq!(renamed["status"], 200);
        assert_eq!(renamed["body"]["tag"]["name"], "Forbidden");
        assert_eq!(deleted["status"], 200);
        assert_eq!(deleted["body"], json!({"deleted":true}));
        assert!(std::panic::catch_unwind(|| assert_hidden(&exposed)).is_err());
        assert!(std::panic::catch_unwind(|| assert_denied(&renamed)).is_err());
        assert!(std::panic::catch_unwind(|| assert_denied(&deleted)).is_err());
        // Re-create a real tag and repeat the same assertions with RLS restored.
        let tag = f.route(f.owner, "POST", &path, json!({"name":"Restored tag"}));
        let id = tag["body"]["tag"]["id"].as_str().unwrap();
        let item = format!("{path}/{id}");
        check_private(&item);
        let renamed = f.route(f.owner, "PATCH", &item, json!({"name":"Renamed tag"}));
        assert_eq!(renamed["body"]["tag"]["name"], "Renamed tag");
        assert_eq!(f.route(f.owner, "POST", &assign, json!({"tagId":id}))["status"], 200);
        assert_eq!(f.route(f.owner, "DELETE", &item, Value::Null)["body"], json!({"deleted":true}));
        let kept = f.route(f.owner, "GET", &format!("/tasks/{task}"), Value::Null);
        assert_eq!(kept["body"]["task"]["title"], "Kept task");
        assert_eq!(kept["body"]["task"]["tags"], json!([]));
    }
    println!("PASS compiled tag manager: read, rename and delete assertions fail without RLS, pass after restoration; owner deletion removes assignments and keeps tasks");
}
