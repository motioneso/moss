//! The public Briefings read gives each caller only their own tasks, and the proof fails when
//! row security is removed.
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
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn briefing_task_read_shows_only_the_callers_tasks_and_fails_without_row_security() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Personal"}));
    f.seed_task(list["body"]["list"]["id"].as_str().unwrap());
    assert_eq!(f.briefing_titles(f.owner), ["Owner private task"]);
    assert!(f.briefing_titles(f.other).is_empty(), "another person must see nothing");
    assert!(f.briefing_titles(f.admin).is_empty(), "an admin must see nothing");
    println!("PASS owner reads the task, a second person and an admin read nothing");

    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let control = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(f.briefing_titles(f.other).is_empty(), "another person must see nothing");
    }));
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    println!("RED with row security removed: {}", if control.is_err() { "second person saw the task" } else { "second person saw nothing" });
    assert!(control.is_err(), "the check must fail when row security is removed");
    assert!(f.briefing_titles(f.other).is_empty(), "restored");
    println!("GREEN row security restored: second person reads nothing again");
}
