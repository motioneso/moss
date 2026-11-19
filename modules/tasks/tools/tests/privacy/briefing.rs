//! Row security protects the Tasks list; Briefings also filters out tasks owned by anyone else.
//! Each boundary is exercised separately so one cannot hide the other's removal.
use super::*;

impl Fixture {
    fn briefing(&self, actor: Uuid, parameters: Value) -> Value {
        let request = json!({"name":"listBriefingTasks","parameters":parameters});
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
