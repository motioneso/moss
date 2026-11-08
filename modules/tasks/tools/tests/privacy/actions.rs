use super::*;

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_actions_match_legacy_shapes_and_preserve_text() {
    let f = Fixture::open_with(true);
    let list = f
        .tool(f.owner, "tasks.createList", json!({"name":"  Tool list  "}))
        .unwrap();
    assert_eq!(list["data"]["summary"], "Created task list:   Tool list  ");
    let list = list["data"]["list"]["id"].as_str().unwrap();
    let renamed = f
        .tool(
            f.owner,
            "tasks.renameList",
            json!({"listId":list,"name":"Renamed"}),
        )
        .unwrap();
    assert_eq!(renamed["data"]["summary"], "Renamed task list: Renamed");
    let tag = f
        .tool(
            f.owner,
            "tasks.createTag",
            json!({"listId":list,"name":"Tag"}),
        )
        .unwrap();
    let tag = tag["data"]["tag"]["id"].as_str().unwrap();
    let renamed = f
        .tool(
            f.owner,
            "tasks.renameTag",
            json!({"listId":list,"tagId":tag,"name":"New tag"}),
        )
        .unwrap();
    assert_eq!(renamed["data"]["summary"], "Renamed tag New tag.");
    let task = f.tool(f.owner, "tasks.create", json!({"title":"  Exact title  ","description":"  Exact body  ","listId":list,"priority":3})).unwrap();
    assert_eq!(task["data"]["summary"], "Created task:   Exact title  ");
    assert_eq!(task["data"]["task"]["description"], "  Exact body  ");
    let id = task["data"]["task"]["id"].as_str().unwrap();
    let updated = f
        .tool(
            f.owner,
            "tasks.update",
            json!({"taskId":id,"title":"","description":""}),
        )
        .unwrap();
    assert_eq!(updated["data"]["task"]["title"], "");
    assert_eq!(updated["data"]["task"]["description"], "");
    let note = f
        .tool(
            f.owner,
            "tasks.addActivity",
            json!({"taskId":id,"body":"  Keep note  "}),
        )
        .unwrap();
    assert_eq!(note["data"]["summary"], "Added note/activity to .");
    assert_eq!(note["data"]["activity"]["body"], "  Keep note  ");
    let assigned = f
        .tool(f.owner, "tasks.assignTag", json!({"taskId":id,"tagId":tag}))
        .unwrap();
    assert_eq!(assigned["data"]["summary"], "Assigned tag New tag.");
    assert_eq!(assigned["data"]["task"]["tags"][0]["id"], tag);
    let unassigned = f
        .tool(
            f.owner,
            "tasks.unassignTag",
            json!({"taskId":id,"tagId":tag}),
        )
        .unwrap();
    assert_eq!(unassigned["data"]["summary"], "Removed tag New tag.");
    assert_eq!(unassigned["data"]["task"]["tags"], json!([]));
    for (status, summary) in [
        ("done", "Completed task: "),
        ("archived", "Archived task: "),
        ("todo", "Reopened task: "),
    ] {
        let result = f
            .tool(
                f.owner,
                "tasks.updateStatus",
                json!({"taskId":id,"status":status}),
            )
            .unwrap();
        assert_eq!(result["data"]["summary"], summary);
        assert_eq!(result["data"]["task"]["status"], status);
    }
    assert_eq!(
        f.tool(
            f.owner,
            "tasks.updateStatus",
            json!({"taskId":id,"status":"suggested"})
        )
        .unwrap(),
        json!({"data":{"error":"Invalid status"}})
    );
    let breakdown = f
        .tool(
            f.owner,
            "tasks.breakDown",
            json!({"taskId":id,"steps":["  Keep space  ","Second"]}),
        )
        .unwrap();
    assert_eq!(breakdown["data"]["summary"], "Added 2 subtasks.");
    let children = breakdown["data"]["tasks"].as_array().unwrap();
    assert_eq!(children[0]["title"], "  Keep space  ");
    assert_eq!(children[0]["position"], 0);
    assert_eq!(children[1]["position"], 1);
    assert!(children
        .iter()
        .all(|t| t["listId"] == list && t["parentTaskId"] == id));
    let activity = f
        .tool(f.owner, "tasks.activity", json!({"taskId":id}))
        .unwrap();
    assert!(activity["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["activityType"] == "broken_down" && v["body"] == "Broken into 2 steps"));
    assert_eq!(
        f.tool(
            f.owner,
            "tasks.deleteTag",
            json!({"listId":list,"tagId":tag})
        )
        .unwrap(),
        json!({"data":{"summary":"Deleted task tag.","deleted":true}})
    );
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_breakdown_route_normalizes_steps_and_rolls_back_invalid_hierarchy() {
    let f = Fixture::open_with(true);
    let parent = f.route(f.owner, "POST", "/tasks", json!({"title":"Parent"}));
    let parent = parent["body"]["task"]["id"].as_str().unwrap();
    let path = format!("/tasks/{parent}/breakdown");
    let broken = f.route(f.owner, "POST", &path, json!({"steps":["  First  ",2]}));
    assert_eq!(broken["status"], 201);
    assert_eq!(broken["body"]["tasks"][0]["title"], "First");
    assert_eq!(broken["body"]["tasks"][1]["title"], "2");
    let child = broken["body"]["tasks"][0]["id"].as_str().unwrap();
    assert!(f
        .try_route(
            f.owner,
            "POST",
            &format!("/tasks/{child}/breakdown"),
            json!({"steps":["Grandchild"]})
        )
        .is_err());
    let subtasks = f.route(
        f.owner,
        "GET",
        &format!("/tasks/{child}/subtasks"),
        Value::Null,
    );
    assert_eq!(subtasks["body"]["tasks"], json!([]));
    let empty = f.route(f.owner, "POST", &path, json!({"steps":[]}));
    assert_eq!(empty["status"], 201);
    assert_eq!(empty["body"]["tasks"], json!([]));
    let invalid = f.route(f.owner, "POST", &path, json!({"steps":[" "]}));
    assert_eq!(invalid["status"], 400);
    assert_eq!(
        invalid["body"]["error"],
        "steps[0] must be a non-empty string"
    );
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_action_privacy_assertions_fail_without_rls_then_pass_with_it() {
    let f = Fixture::open_with(true);
    let task = f.route(
        f.owner,
        "POST",
        "/tasks",
        json!({"title":"Private action target"}),
    );
    let id = task["body"]["task"]["id"].as_str().unwrap();
    let assert_hidden = |actor| {
        for (tool, input) in [
            ("tasks.update", json!({"taskId":id,"title":"Forbidden"})),
            ("tasks.updateStatus", json!({"taskId":id,"status":"done"})),
            (
                "tasks.addActivity",
                json!({"taskId":id,"body":"Forbidden note"}),
            ),
        ] {
            assert_eq!(
                f.tool(actor, tool, input).unwrap(),
                json!({"data":{"error":"Task not found"}})
            );
        }
    };
    for actor in [f.other, f.admin] {
        assert_hidden(actor);
    }
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let failed =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_hidden(f.other))).is_err();
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    assert!(
        failed,
        "the identical compiled action assertion must fail with RLS removed"
    );
    for actor in [f.other, f.admin] {
        assert_hidden(actor);
    }
    println!("PASS compiled Tasks actions: cross-account mutation assertion fails with RLS removed and passes with RLS restored");
}
