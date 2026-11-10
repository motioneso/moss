//! Approval cards for task actions: field order, labels, references and refusals.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

const TASK: &str = "11111111-1111-4111-8111-111111111111";
const PARENT: &str = "22222222-2222-4222-8222-222222222222";
const LIST: &str = "33333333-3333-4333-8333-333333333333";
const OTHER_LIST: &str = "44444444-4444-4444-8444-444444444444";
const TAG: &str = "55555555-5555-4555-8555-555555555555";

struct Rows;
impl Host for Rows {
    fn call(&self, port: &str, operation: &str, table: &str, query: Value) -> Result<Value> {
        assert_eq!((port, operation), ("db", "query"));
        let wanted = query.to_string();
        let stamp = "2026-11-08T00:00:00.000Z";
        let rows: Vec<Value> = match table {
            "app.tasks" => [(TASK, "Write report"), (PARENT, "Parent job")]
                .iter()
                .filter(|(id, _)| wanted.contains(id))
                .map(|(id, title)| json!({"id":id,"owner_user_id":"o","list_id":LIST,"parent_task_id":null,
                    "title":title,"description":null,"status":"todo","priority":null,"position":0,
                    "due_at":null,"do_at":null,"effort":null,"source":"user","source_ref":null,
                    "completed_at":null,"created_at":stamp,"updated_at":stamp,
                    "suggestion_metadata":null,"recurrence":null,"recurrence_series_id":null}))
                .collect(),
            "app.task_lists" => [(LIST, "Home"), (OTHER_LIST, "Work")]
                .iter()
                .filter(|(id, _)| wanted.contains(id))
                .map(|(id, name)| json!({"id":id,"owner_user_id":"o","name":name,"position":0,"created_at":stamp,"updated_at":stamp}))
                .collect(),
            "app.task_tags" => if wanted.contains(TAG) && (!wanted.contains("list_id") || wanted.contains(LIST)) {
                vec![json!({"id":TAG,"owner_user_id":"o","list_id":LIST,"name":"Errands","created_at":stamp})]
            } else { vec![] },
            other => panic!("unexpected table {other}"),
        };
        Ok(Value::Array(rows))
    }
}

fn card(tool: &str, input: &str) -> Value {
    let request = json!({"name":"prepareTaskAction","parameters":{"tool":tool,"inputJson":input}});
    let out = moss_tasks_module::handle(&Rows, "api", &request.to_string()).unwrap();
    serde_json::from_str(&out).unwrap()
}
fn rows(card: &Value) -> Vec<(String, String)> {
    card["ok"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["label"].as_str().unwrap().into(),
                f["value"].as_str().unwrap().into(),
            )
        })
        .collect()
}
fn pair(l: &str, v: &str) -> (String, String) {
    (l.into(), v.into())
}

#[test]
fn create_follows_the_submitted_field_order_and_shows_choices_in_words() {
    let c = card(
        "tasks.create",
        &format!(
            r#"{{"title":"Buy milk","priority":2,"status":"todo","listId":"{LIST}","effort":"quick","dueAt":null,"parentTaskId":null,
        "recurrence":{{"occurrence_date":"2026-11-09","freq":"weekly","interval":2}}}}"#
        ),
    );
    assert_eq!(
        rows(&c),
        vec![
            pair("Title", "Buy milk"),
            pair("Priority", "2"),
            pair("Status", "To do"),
            pair("List", "Home"),
            pair("Effort", "Quick"),
            pair("Due at", "None"),
            pair("Parent task", "None"),
            pair("Occurrence date", "2026-11-09"),
            pair("Repeat frequency", "Weekly"),
            pair("Repeat interval", "2"),
        ]
    );
    assert_eq!(c["ok"]["target"], "Your tasks");
    assert_eq!(c["ok"]["content"], "outside");
    assert_eq!(
        c["ok"]["version"],
        format!(r#"[{{"id":"{LIST}","name":"Home"}}]"#)
    );
}

#[test]
fn update_names_the_task_and_warns_when_a_list_move_drops_tags() {
    let c = card(
        "tasks.update",
        &format!(r#"{{"taskId":"{TASK}","parentTaskId":"{PARENT}","listId":"{OTHER_LIST}"}}"#),
    );
    assert_eq!(c["ok"]["target"], "Write report");
    assert_eq!(rows(&c), vec![
        pair("Task","Write report"), pair("Parent task","Parent job"), pair("List","Work"),
        pair("Tags","Remove this task's tag assignments that do not belong to the selected destination list."),
    ]);
    assert_eq!(
        c["ok"]["version"],
        format!(
            r#"[{{"id":"{TASK}","title":"Write report","updated_at":"2026-11-08T00:00:00.000Z"}},{{"id":"{OTHER_LIST}","name":"Work"}},{{"id":"{PARENT}","title":"Parent job","updated_at":"2026-11-08T00:00:00.000Z"}}]"#
        )
    );
}

#[test]
fn deletes_and_breakdown_disclose_their_effects() {
    let c = card("tasks.deleteList", &format!(r#"{{"listId":"{LIST}"}}"#));
    assert_eq!(c["ok"]["target"], "Home");
    assert_eq!(rows(&c)[1], pair("Tasks", "Only an empty list can be deleted. A list that still contains tasks is left unchanged."));
    assert_eq!(rows(&c).len(), 4);
    let c = card(
        "tasks.deleteList",
        &format!(r#"{{"listId":"{LIST}","reassignToListId":"{OTHER_LIST}"}}"#),
    );
    assert_eq!(
        rows(&c)[2],
        pair(
            "Tasks",
            "Move all tasks to the selected destination list; the tasks are kept."
        )
    );
    let c = card(
        "tasks.deleteTag",
        &format!(r#"{{"listId":"{LIST}","tagId":"{TAG}"}}"#),
    );
    assert_eq!(c["ok"]["target"], "Errands");
    assert_eq!(
        rows(&c),
        vec![
            pair("List", "Home"),
            pair("Tag", "Errands"),
            pair(
                "Effect",
                "Delete this tag and remove it from every task. The tasks are kept."
            )
        ]
    );
    let c = card(
        "tasks.breakDown",
        &format!(r#"{{"taskId":"{TASK}","steps":["Draft","Send"]}}"#),
    );
    assert_eq!(
        rows(&c),
        vec![
            pair("Task", "Write report"),
            pair("Subtask 1", "Draft"),
            pair("Subtask 2", "Send")
        ]
    );
    let c = card(
        "tasks.breakDown",
        &format!(r#"{{"taskId":"{TASK}","steps":[]}}"#),
    );
    assert_eq!(rows(&c)[1], pair("Subtasks", "No subtasks"));
}

#[test]
fn name_only_actions_use_their_own_targets() {
    let c = card("tasks.createList", r#"{"name":"Errands"}"#);
    assert_eq!(c["ok"]["target"], "Your task lists");
    assert_eq!(c["ok"]["content"], "user_authored");
    assert_eq!(c["ok"]["version"], "[]");
    assert_eq!(rows(&c), vec![pair("Name", "Errands")]);
    assert_eq!(
        card(
            "tasks.renameList",
            &format!(r#"{{"listId":"{LIST}","name":"Houses"}}"#)
        )["ok"]["target"],
        "Home"
    );
    assert_eq!(
        card(
            "tasks.createTag",
            &format!(r#"{{"listId":"{LIST}","name":"x"}}"#)
        )["ok"]["target"],
        "Home"
    );
}

#[test]
fn anything_that_cannot_be_shown_in_full_gets_no_card() {
    for (tool, input) in [
        ("tasks.create", r#"{"priority":1}"#.to_string()),
        ("tasks.create", r#"{"title":"x","extra":1}"#.into()),
        ("tasks.create", r#"{"title":3}"#.into()),
        ("tasks.create", r#"{"title":"x","status":"bogus"}"#.into()),
        ("tasks.create", r#"{"title":"x","recurrence":{"freq":"daily","interval":1}}"#.into()),
        ("tasks.create", r#"{"title":"x","recurrence":{"freq":"daily","interval":1,"occurrence_date":"d","more":1}}"#.into()),
        ("tasks.create", r#"{"title":"x","listId":"not-a-uuid"}"#.into()),
        ("tasks.create", r#"{"title":"x","listId":"99999999-9999-4999-8999-999999999999"}"#.into()),
        ("tasks.update", r#"{"taskId":"11111111-1111-4111-8111-111111111111","parentTaskId":5}"#.into()),
        ("tasks.updateStatus", format!(r#"{{"taskId":"{TASK}"}}"#)),
        ("tasks.breakDown", format!(r#"{{"taskId":"{TASK}","steps":["a",2]}}"#)),
        ("tasks.assignTag", format!(r#"{{"taskId":"{TASK}","tagId":"{TAG}","listId":"{LIST}"}}"#)),
        ("tasks.createList", "[]".into()),
        ("tasks.createList", "nope".into()),
    ] {
        assert_eq!(card(tool, &input), json!({"ok":null}), "{tool} {input}");
    }
    // A tag from a different list than the one named is not found.
    assert_eq!(
        card(
            "tasks.deleteTag",
            &format!(r#"{{"listId":"{OTHER_LIST}","tagId":"{TAG}"}}"#)
        ),
        json!({"ok":null})
    );
}

#[test]
fn read_tools_and_unknown_requests_are_refused() {
    assert_eq!(
        card("tasks.list", "{}"),
        json!({"error":{"statusCode":400,"error":"Unknown Tasks tool"}})
    );
    let other = json!({"name":"prepareTaskAction","parameters":{"tool":"tasks.createList","inputJson":"{}"},"actorUserId":"x"});
    assert!(moss_tasks_module::handle(&Rows, "api", &other.to_string()).is_err());
}
