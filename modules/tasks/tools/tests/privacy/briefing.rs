//! The public Briefings calls read and change only the caller's own tasks. Both the call's own-rows
//! filter and row security keep another person out, so each control turns one layer off at a time.
use super::*;

impl Fixture {
    fn briefing(&self, actor: Uuid, parameters: Value) -> Value {
        self.api(actor, "listBriefingTasks", parameters)
    }
    fn api(&self, actor: Uuid, name: &str, parameters: Value) -> Value {
        let request = json!({"name":name,"parameters":parameters});
        let value = self
            .host
            .call(
                &self.wasm,
                self.manifest.clone(),
                AccessContext::new(actor, "briefing-api"),
                self.ports.clone(),
                "api",
                &request.to_string(),
            )
            .unwrap();
        serde_json::from_str(&value).unwrap()
    }
    fn briefing_titles(&self, actor: Uuid) -> Vec<String> {
        self.briefing(actor, json!({"status":"todo"}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect()
    }
    fn task_list_contains_fixture(&self, actor: Uuid) -> bool {
        let response = self.route(actor, "GET", "/tasks", Value::Null);
        assert_eq!(response["status"], 200);
        response["body"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == self.task.to_string())
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_task_list_privacy_fails_without_row_security() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Personal"}));
    f.seed_task(list["body"]["list"]["id"].as_str().unwrap());
    assert!(f.task_list_contains_fixture(f.owner));
    let assert_private = |actor| {
        assert!(
            !f.task_list_contains_fixture(actor),
            "another account must not read the private task"
        );
    };
    for actor in [f.other, f.admin] {
        assert_private(actor);
    }
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let control = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_private(f.other);
    }));
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    let failure = control.expect_err("the identical task-list assertion must fail without RLS");
    let message = failure
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| failure.downcast_ref::<String>().map(String::as_str));
    assert_eq!(
        message,
        Some("another account must not read the private task"),
        "a route, shape or host error is not a privacy removal proof"
    );
    println!(
        "RED row security removed: identical compiled task-list assertion saw the private task"
    );
    for actor in [f.other, f.admin] {
        assert_private(actor);
    }
    assert!(f.task_list_contains_fixture(f.owner));
    println!(
        "GREEN row security restored: ordinary and admin accounts cannot read the private task"
    );
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn briefing_task_read_excludes_other_owners_even_when_shared() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Personal"}));
    f.seed_task(list["body"]["list"]["id"].as_str().unwrap());
    assert_eq!(f.briefing_titles(f.owner), ["Owner private task"]);
    for actor in [f.other, f.admin] {
        assert!(!f.task_list_contains_fixture(actor));
        assert!(
            f.briefing_titles(actor).is_empty(),
            "an unshared task must not enter a briefing"
        );
        f.rt.block_on(f.db.execute(
            "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')",
            &[&f.task, &f.owner, &actor],
        )).unwrap();
        assert!(
            f.task_list_contains_fixture(actor),
            "RLS must allow the genuinely shared task"
        );
        assert!(
            f.briefing_titles(actor).is_empty(),
            "a shared task owned by another account must not enter a briefing"
        );
    }
    assert_eq!(f.briefing_titles(f.owner), ["Owner private task"]);
    println!("PASS compiled Briefings API: ordinary and admin accounts can list a shared task but their briefings exclude it");
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn briefing_task_writes_change_only_the_callers_tasks() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Personal"}));
    f.seed_task(list["body"]["list"]["id"].as_str().unwrap());
    let task = f.task.to_string();
    let status = |actor: Uuid| f.api(actor, "setBriefingTaskStatus", json!({"taskId":task,"status":"archived"}));
    let status_of = |actor: Uuid| f.briefing(actor, json!({"ids":[task]}))["items"][0]["status"].clone();

    assert_eq!(status(f.other), json!({"task":null}), "a second person");
    assert_eq!(status(f.admin), json!({"task":null}), "an admin");
    assert_eq!(status_of(f.owner), "todo", "the task is unchanged");
    assert!(f.briefing(f.other, json!({"ids":[task]}))["items"].as_array().unwrap().is_empty());
    println!("PASS a second person and an admin cannot archive or read the owner's task");

    let made = f.api(f.other, "createFollowUpTask", json!({"title":"Follow up with Sam"}));
    let made_id = made["task"]["id"].as_str().unwrap().to_owned();
    assert!(f.briefing(f.owner, json!({"ids":[made_id]}))["items"].as_array().unwrap().is_empty(), "the owner cannot see another person's new task");
    assert_eq!(f.briefing(f.other, json!({"ids":[made_id]}))["items"][0]["title"], "Follow up with Sam");
    println!("PASS a follow-up task belongs to the person who made it");

    // Control: with row security off, only the call's own-rows filter protects the task.
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let control = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_eq!(status(f.other), json!({"task":null}));
    }));
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    println!("CONTROL row security off, own-rows filter in place: {}", if control.is_err() { "RED, second person archived the task" } else { "GREEN, second person got not-found" });
    assert!(control.is_ok(), "the own-rows filter alone must keep another person out");
    assert_eq!(status_of(f.owner), "todo");

    assert_eq!(status(f.owner)["task"]["status"], "archived");
    assert_eq!(status_of(f.owner), "archived");
    println!("PASS the owner archives it and reads it back as archived");
}
