//! Part 5 proofs through the installed Wasm component and its host approval transport.
use super::*;

fn run(w: &World, actor: uuid::Uuid, tool: &str, parameters: Value, approve: bool) -> Value {
    if approve {
        w.app
            .services
            .approve_tool(&w.f.access(actor), "goals", tool, &parameters)
            .unwrap();
    }
    w.call(
        actor,
        "POST",
        "/goals/tools/run",
        json!({"tool":tool,"parameters":parameters}),
    )
}
fn compare(mut a: Value, mut b: Value) {
    replay::mask(&mut a);
    replay::mask(&mut b);
    assert_eq!(a, b);
}
fn without_receipt(mut reply: Value, expected: Value) -> Value {
    let receipt = reply["data"].as_object_mut().unwrap().remove("changed").unwrap();
    assert_eq!(receipt, expected);
    reply
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_tools_match_legacy_tools_and_routes_and_today_filters_states() {
    let w = World::new();
    let (actor, old) = (w.f.a, w.add_user());
    let input = json!({"title":"Fixture goal","desiredOutcome":"Ship","priority":5,"reviewCadence":"daily","targetAt":"2030-01-01T00:00:00.000Z"});
    assert_eq!(
        run(&w, actor, "goals.create", input.clone(), false)["status"],
        403
    );
    let created = run(&w, actor, "goals.create", input.clone(), true);
    assert_eq!(created["status"], 200, "{created}");
    let legacy = replay::old_tool(old, "goals.create", input.clone());
    let created_reply = without_receipt(created["body"].clone(), json!([
        {"label":"Title","before":"None","after":"Fixture goal"},
        {"label":"Desired outcome","before":"None","after":"Ship"},
        {"label":"Priority","before":"None","after":"5"},
        {"label":"Review frequency","before":"None","after":"daily"},
        {"label":"Target date","before":"None","after":"2030-01-01T00:00:00.000Z"}
    ]));
    compare(created_reply.clone(), legacy.clone());
    let id = created["body"]["data"]["id"].as_str().unwrap();
    let old_id = legacy["data"]["id"].as_str().unwrap();
    assert_eq!(
        w.call(actor, "GET", &format!("/goals/{id}"), Value::Null)["body"],
        created_reply["data"]
    );
    // Replaying an approval cannot create a second goal.
    assert_eq!(run(&w, actor, "goals.create", input, false)["status"], 403);
    for n in 0..12 {
        let params = json!({"goalId":id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":format!("Step {n}"),"occurredAt":"2026-11-13T12:00:00.000Z"});
        let mut old_params = params.clone();
        old_params["goalId"] = json!(old_id);
        let saved = run(&w, actor, "goals.addEvidence", params, true);
        compare(
            without_receipt(saved["body"].clone(), json!([
                {"label":"Evidence type","before":"None","after":"progress"},
                {"label":"Source type","before":"None","after":"manual"},
                {"label":"Source label","before":"None","after":"Note"},
                {"label":"Summary","before":"None","after":format!("Step {n}")},
                {"label":"Occurred at","before":"None","after":"2026-11-13T12:00:00.000Z"}
            ])),
            replay::old_tool(old, "goals.addEvidence", old_params),
        );
    }
    for (name, params, old_params) in [
        ("goals.list", json!({}), json!({})),
        ("goals.get", json!({"goalId":id}), json!({"goalId":old_id})),
        (
            "goals.update",
            json!({"goalId":id,"title":"Changed","priority":4,"status":"paused","reviewCadence":"monthly"}),
            json!({"goalId":old_id,"title":"Changed","priority":4,"status":"paused","reviewCadence":"monthly"}),
        ),
    ] {
        let result = run(&w, actor, name, params, true);
        let reply = if name == "goals.update" {
            without_receipt(result["body"].clone(), json!([
                {"label":"Title","before":"Fixture goal","after":"Changed"},
                {"label":"Status","before":"active","after":"paused"},
                {"label":"Priority","before":"5","after":"4"},
                {"label":"Review frequency","before":"daily","after":"monthly"}
            ]))
        } else {
            assert!(result["body"]["data"].get("changed").is_none());
            result["body"].clone()
        };
        compare(
            reply,
            replay::old_tool(old, name, old_params),
        );
        if name == "goals.get" {
            let evidence = result["body"]["data"]["evidence"].as_array().unwrap();
            assert_eq!(evidence.len(), 10);
            assert_eq!(evidence[0]["summary"], "Step 11");
            assert_eq!(evidence[9]["summary"], "Step 2");
            assert_eq!(evidence[0].as_object().unwrap().len(), 3);
        }
    }
    assert_eq!(
        w.call(actor, "GET", "/goals/today", Value::Null)["body"],
        json!([])
    );
    for state in ["active", "blocked", "completed", "archived"] {
        let update = json!({"goalId":id,"status":state});
        let changed = run(&w, actor, "goals.update", update, true);
        assert_eq!(changed["body"]["data"]["status"], state);
        let list = w.call(actor, "GET", "/goals", Value::Null)["body"].clone();
        let expected: Vec<_> = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|g| g["status"] == "active")
            .cloned()
            .collect();
        assert_eq!(
            w.call(actor, "GET", "/goals/today", Value::Null)["body"],
            json!(expected)
        );
    }
    println!("PASS all five installed Wasm tools match legacy data and share route writes; create, update and evidence receipts match exact saved values; newest ten summaries; Today matches the legacy active filter; approval is one-use");
}

#[test]
#[ignore = "Only through verify-gate"]
fn tools_and_today_keep_both_tables_private_and_activity_metadata_only() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let created = run(
        &w,
        a,
        "goals.create",
        json!({"title":MARK,"desiredOutcome":MARK}),
        true,
    );
    let id = created["body"]["data"]["id"].as_str().unwrap();
    run(
        &w,
        a,
        "goals.addEvidence",
        json!({"goalId":id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":MARK,"summary":MARK}),
        true,
    );
    for actor in [b, w.f.admin] {
        assert_eq!(
            run(&w, actor, "goals.list", json!({}), true)["body"],
            json!({"data":{"items":[]}})
        );
        assert_eq!(
            run(&w, actor, "goals.get", json!({"goalId":id}), true)["body"],
            json!({"data":{"error":"Goal not found"}})
        );
        assert_eq!(
            w.call(actor, "GET", "/goals/today", Value::Null)["body"],
            json!([])
        );
        let changed = run(
            &w,
            actor,
            "goals.update",
            json!({"goalId":id,"title":"Stolen"}),
            true,
        );
        assert!(!changed.to_string().contains(MARK));
        let evidence = run(
            &w,
            actor,
            "goals.addEvidence",
            json!({"goalId":id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Other","summary":"Other"}),
            true,
        );
        assert!(!evidence.to_string().contains(MARK));
    }
    // Negative controls run the same privacy observation with each owner rule weakened.
    for (table, policy, sql) in [
        (
            "app.moss_goals",
            "moss_goals_rw",
            "SELECT title FROM app.moss_goals",
        ),
        (
            "app.moss_goal_evidence",
            "moss_goal_evidence_rw",
            "SELECT summary FROM app.moss_goal_evidence",
        ),
    ] {
        assert!(rows_as(&w.f, b, sql).is_empty());
        w.f.rt.block_on(w.f.root.batch_execute(&format!("DROP POLICY {policy} ON {table}; CREATE POLICY {policy} ON {table} FOR ALL TO jarvis_app_runtime USING (true) WITH CHECK (true)"))).unwrap();
        let guarded_assertion = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(rows_as(&w.f, b, sql).is_empty())
        }));
        w.f.rt.block_on(w.f.root.batch_execute(&format!("DROP POLICY {policy} ON {table}; CREATE POLICY {policy} ON {table} FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id())"))).unwrap();
        assert!(
            guarded_assertion.is_err(),
            "privacy check must fail without {policy}"
        );
        assert!(rows_as(&w.f, b, sql).is_empty());
        println!("PASS part5 RLS negative control: {table} assertion failed when weakened and passed after restore");
    }
    let job_count: i64 =
        w.f.rt
            .block_on(w.f.root.query_one(
                "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
                &[&format!("%{MARK}%")],
            ))
            .unwrap()
            .get(0);
    assert_eq!(job_count, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(
            &w.app
                .services
                .activity("goals", &w.f.access(actor))
                .unwrap(),
        )
        .unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS part5 privacy: planted goal and evidence text absent from stored jobs and real host activity; other person and admin refused");
}
