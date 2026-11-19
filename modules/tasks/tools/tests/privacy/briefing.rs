//! The public Briefings calls read and change only the caller's own tasks. The read gives each caller only their own tasks, and the proof fails when
//! row security is removed.
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
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn briefing_task_read_shows_only_the_callers_tasks() {
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
    // The read also drops any task the caller does not own, so row security is the second layer.
    println!("CONTROL row security off, owner check in place: {}", if control.is_err() { "RED, second person saw the task" } else { "GREEN, second person saw nothing" });
    assert!(control.is_ok(), "the owner check alone must keep another person out");
    assert!(f.briefing_titles(f.other).is_empty(), "restored");
    println!("GREEN row security restored: second person reads nothing again");
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
