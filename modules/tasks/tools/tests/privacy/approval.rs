use super::*;

impl Fixture {
    fn prepare(&self, actor: Uuid, tool: &str, input: Value) -> Value {
        let request = json!({"name":"prepareTaskAction","parameters":{"tool":tool,"inputJson":input.to_string()}});
        let value = self
            .host
            .call(
                &self.wasm,
                self.manifest.clone(),
                AccessContext::new(actor, "component-approval"),
                self.ports.clone(),
                "api",
                &request.to_string(),
            )
            .unwrap();
        serde_json::from_str(&value).unwrap()
    }
}

#[test]
#[ignore = "Database work only through modules/tasks/tools/gate.sh and verify-gate"]
fn compiled_approval_cards_use_real_rows_and_hide_other_accounts_rows() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Cards list"}));
    let list = list["body"]["list"]["id"].as_str().unwrap();
    let task = f.route(f.owner, "POST", "/tasks", json!({"title":"Card task","listId":list}));
    let task = task["body"]["task"]["id"].as_str().unwrap();
    let card = f.prepare(
        f.owner,
        "tasks.update",
        json!({"taskId":task,"title":"Renamed","priority":3,"listId":list}),
    );
    let fields = card["ok"]["fields"].as_array().unwrap();
    let shown: Vec<(&str, &str)> = fields
        .iter()
        .map(|f| (f["label"].as_str().unwrap(), f["value"].as_str().unwrap()))
        .collect();
    assert_eq!(
        shown[..4],
        [("Task", "Card task"), ("Title", "Renamed"), ("Priority", "3"), ("List", "Cards list")]
    );
    assert_eq!(card["ok"]["target"], "Card task");
    assert_eq!(card["ok"]["content"], "outside");
    assert!(card["ok"]["version"].as_str().unwrap().contains(task));
    for actor in [f.other, f.admin] {
        assert_eq!(
            f.prepare(actor, "tasks.update", json!({"taskId":task,"title":"x"})),
            json!({"ok":null}),
            "another account must not learn a task title"
        );
        assert_eq!(
            f.prepare(actor, "tasks.renameList", json!({"listId":list,"name":"x"})),
            json!({"ok":null})
        );
    }
}
