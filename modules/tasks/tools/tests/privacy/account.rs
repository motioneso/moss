use super::*;

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_policy_routes_preserve_legacy_keys_and_account_choices() {
    let f = Fixture::open_with(true);
    let path = "/tasks/agency-auto-execute";
    let read = |actor| f.route(actor, "GET", path, Value::Null);
    let write = |actor, enabled| f.route(actor, "PATCH", path, json!({"enabled":enabled}));
    assert_eq!(read(f.owner), json!({"status":200,"body":{"enabled":true}}));
    assert_eq!(write(f.owner, false)["body"], json!({"enabled":false}));
    f.rt.block_on(async {
        let rows = f.db.query("SELECT key,value_json FROM app.preferences WHERE owner_user_id=$1 ORDER BY key", &[&f.owner]).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<_, String>(0), "assistant.action_policy.v1.tasks.task_changes");
        assert_eq!(rows[0].get::<_, Value>(1), "ask_each_time");
        assert_eq!(rows[1].get::<_, String>(0), "tasks.agency_auto_execute");
        assert_eq!(rows[1].get::<_, Value>(1), false);
        f.db.execute("UPDATE app.preferences SET value_json='\"always_confirm\"' WHERE owner_user_id=$1 AND key='assistant.action_policy.v1.tasks.task_changes'", &[&f.owner]).await.unwrap();
        f.db.execute("UPDATE app.preferences SET value_json='true' WHERE owner_user_id=$1 AND key='tasks.agency_auto_execute'", &[&f.owner]).await.unwrap();
    });
    assert_eq!(read(f.owner)["body"], json!({"enabled":false}));
    // The same assertion must fail when account privacy is removed, then pass
    // again once RLS is restored. Only the owner has these keys at this point.
    let hidden = || assert_eq!(read(f.other)["body"], json!({"enabled":true}));
    f.sql("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY");
    let red = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hidden));
    f.sql("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY");
    assert!(
        red.is_err(),
        "compiled policy read privacy assertion must fail without RLS"
    );
    hidden();
    for actor in [f.other, f.admin] {
        assert_eq!(write(actor, true)["body"], json!({"enabled":true}));
        assert_eq!(read(f.owner)["body"], json!({"enabled":false}));
    }
    assert_eq!(write(f.owner, true)["body"], json!({"enabled":true}));
    for body in [json!({}), json!({"enabled":"invalid"})] {
        assert_eq!(f.route(f.owner, "PATCH", path, body)["status"], 400);
    }
    assert_eq!(
        f.route(f.owner, "PATCH", path, json!({"enabled":null}))["body"],
        json!({"enabled":false})
    );
    println!("PASS compiled policy routes: legacy precedence and account privacy removal control");
}
