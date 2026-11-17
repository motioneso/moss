//! Arrangement tools (edit, swap, delete, account data) through the installed component with two people.
use super::lists::seed_plan;
use super::tools::run;
use super::*;

#[test]
#[ignore = "Only through verify-gate"]
fn arrangement_tools_are_private_and_keep_text_out_of_jobs_and_activity() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    for who in [a, b] {
        run(&w, who, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    }
    let [plan, day, _, meal] = seed_plan(&w, a, "arrange");
    let set = run(&w, a, "meals.day.edit", json!({"action":"set_text","mealId":meal,"text":MARK}), true);
    assert_eq!(set["status"], 200, "{set}");
    run(&w, a, "meals.meal.edit", json!({"mealId":meal,"action":"lock"}), true);
    run(&w, a, "meals.meal.edit", json!({"mealId":meal,"action":"unlock"}), true);
    run(&w, a, "meals.day.edit", json!({"action":"clear_text","mealId":meal}), true);
    let swap = run(&w, a, "meals.meal.swap", json!({"mealId":meal,"action":"request_choices"}), true);
    assert_eq!(swap["status"], 200, "{swap}");
    run(&w, a, "meals.day.edit", json!({"action":"set_text","mealId":meal,"text":MARK}), true);
    // The second person and the admin cannot read, change or delete the first person's plan.
    for actor in [b, w.f.admin] {
        let refused = [
            run(&w, actor, "meals.meal.get", json!({"mealId":meal}), true),
            run(&w, actor, "meals.meal.edit", json!({"mealId":meal,"action":"lock"}), true),
            run(&w, actor, "meals.meal.swap", json!({"mealId":meal,"action":"request_choices"}), true),
            run(&w, actor, "meals.day.edit", json!({"action":"set_cook_limit","dayId":day,"minutes":45}), true),
            run(&w, actor, "meals.plan.delete", json!({"planId":plan}), true),
        ];
        for r in refused {
            assert_eq!(r["body"]["data"]["code"], "invalid_input", "{r}");
            assert!(!r.to_string().contains(MARK), "{r}");
        }
    }
    for table in ["app.meals_planned_meals", "app.meals_plans"] {
        assert!(rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).is_empty());
        assert!(!rows_as(&w.f, a, &format!("SELECT 1 FROM {table}")).is_empty(), "{table} needs rows to protect");
        let weaken = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (true)");
        let restore = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id())");
        w.f.rt.block_on(w.f.root.batch_execute(&weaken)).unwrap();
        let seen = rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).len();
        w.f.rt.block_on(w.f.root.batch_execute(&restore)).unwrap();
        assert!(seen > 0, "second person must see {table} without the rule");
        assert!(rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).is_empty());
        println!("PASS rls negative control: {table} check failed when weakened and passed after restore");
    }
    // The plan still stands, so the refused delete changed nothing.
    assert_eq!(rows_as(&w.f, a, "SELECT 1 FROM app.meals_plans").len(), 1);
    let kept: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.meals_planned_meals WHERE owner_user_id = $1 AND plain_text = $2", &[&a, &MARK])).unwrap().get(0);
    assert_eq!(kept, 1, "the private text must be stored so the checks above protect something");
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")])).unwrap().get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    // Deleting the plan removes it for its owner only.
    let gone = run(&w, a, "meals.plan.delete", json!({"planId":plan}), true);
    assert_eq!(gone["status"], 200, "{gone}");
    assert!(rows_as(&w.f, a, "SELECT 1 FROM app.meals_plans").is_empty());
    println!("PASS arrange: tools owner-only with negative control, marker absent from jobs and activity");
}
