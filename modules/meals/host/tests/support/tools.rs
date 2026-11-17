//! Tool proofs through the installed Wasm component and its host approval transport.
use super::*;

pub(crate) fn run(w: &World, actor: uuid::Uuid, tool: &str, parameters: Value, approve: bool) -> Value {
    if approve {
        w.app
            .services
            .approve_tool(&w.f.access(actor), "meals", tool, &parameters)
            .unwrap();
    }
    w.call(
        actor,
        "POST",
        "/meals/tools/run",
        json!({"tool":tool,"parameters":parameters}),
    )
}
pub(crate) fn compare(mut a: Value, mut b: Value) {
    replay::mask(&mut a);
    replay::mask(&mut b);
    assert_eq!(a, b);
}
fn fill(params: &Value, member: &str, own: &str) -> Value {
    params
        .to_string()
        .replace("{member}", member)
        .replace("{self}", own)
        .parse()
        .unwrap()
}
fn self_id(view: &Value) -> String {
    view["data"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["isSelf"] == true)
        .unwrap()["memberId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_tools_match_the_old_handlers_step_for_step() {
    let w = World::new();
    let (new_actor, old_actor) = (w.f.a, w.add_user());
    let missing = "99999999-9999-4999-8999-999999999999";
    // Without approval a write is refused and changes nothing.
    let refused = run(
        &w,
        new_actor,
        "meals.kitchen.save",
        json!({"unitsSystem":"metric"}),
        false,
    );
    assert_eq!(refused["status"], 403, "{refused}");
    let steps: Vec<(&str, Value)> = vec![
        ("meals.kitchen.get", json!({})),
        ("meals.kitchen.get", json!({"extra":1})),
        (
            "meals.kitchen.save",
            json!({"unitsSystem":"metric","defaultPantryMode":"prefer","slotRules":[{"slotName":"Lunch","soloWeekdays":[1,2],"usualTime":"12:30"}]}),
        ),
        ("meals.kitchen.save", json!({"unitsSystem":"imperial"})),
        (
            "meals.kitchen.save",
            json!({"slotRules":[{"slotName":"Dinner","usualTime":"25:00"}]}),
        ),
        ("meals.kitchen.get", json!({})),
        (
            "meals.household.save",
            json!({"name":"Sam","linkedAccountEmail":"sam@example.test","calorieTarget":2000,"restrictions":["nuts"]}),
        ),
        ("meals.household.save", json!({"name":""})),
        (
            "meals.household.save",
            json!({"memberId":"{member}","name":"Samuel","calorieTarget":null}),
        ),
        (
            "meals.household.save",
            json!({"memberId":missing,"name":"Nobody"}),
        ),
        ("meals.kitchen.get", json!({})),
        ("meals.household.remove", json!({"memberId":"{self}"})),
        ("meals.household.remove", json!({"memberId":"{member}"})),
        ("meals.household.remove", json!({"memberId":"{member}"})),
        ("meals.kitchen.get", json!({})),
    ];
    let (mut new_member, mut old_member) = (String::new(), String::new());
    let (mut new_self, mut old_self) = (String::new(), String::new());
    for (n, (tool, params)) in steps.iter().enumerate() {
        let new = run(
            &w,
            new_actor,
            tool,
            fill(params, &new_member, &new_self),
            true,
        );
        assert_eq!(new["status"], 200, "step {n}: {new}");
        let old = replay::old_tool(
            old_actor,
            &role(),
            tool,
            fill(params, &old_member, &old_self),
        );
        if *tool == "meals.household.save"
            && params.get("memberId").is_none()
            && new["body"]["data"].get("memberId").is_some()
        {
            new_member = new["body"]["data"]["memberId"].as_str().unwrap().into();
            old_member = old["data"]["memberId"].as_str().unwrap().into();
        }
        if *tool == "meals.kitchen.get" && new_self.is_empty() {
            new_self = self_id(&new["body"]);
            old_self = self_id(&old);
        }
        compare(new["body"].clone(), old);
    }
    println!(
        "PASS parity: {} tool steps match the old handlers",
        steps.len()
    );
}

#[test]
#[ignore = "Only through verify-gate"]
fn tools_keep_both_tables_private_and_leave_no_text_behind() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    run(
        &w,
        a,
        "meals.kitchen.save",
        json!({"unitsSystem":"metric"}),
        true,
    );
    // replay::mask hides ids, so check the derived ids against the database's own md5 here.
    let kid = rows_as(&w.f, a, &format!("SELECT (kitchen_id = md5('meals.kitchen:' || '{a}')::uuid) AS ok FROM app.meals_kitchens WHERE owner_user_id = '{a}'"));
    assert_eq!(kid.len(), 1);
    assert!(
        kid[0].get::<_, bool>(0),
        "kitchen id must be md5('meals.kitchen:'||actor)"
    );
    let member = run(
        &w,
        a,
        "meals.household.save",
        json!({"name":MARK,"preferences":[MARK]}),
        true,
    );
    let id = member["body"]["data"]["memberId"]
        .as_str()
        .unwrap()
        .to_owned();
    for actor in [b, w.f.admin] {
        let view = run(&w, actor, "meals.kitchen.get", json!({}), true);
        assert!(!view.to_string().contains(MARK), "{view}");
        assert_eq!(view["body"]["data"]["members"].as_array().unwrap().len(), 1);
        let edit = run(
            &w,
            actor,
            "meals.household.save",
            json!({"memberId":id,"name":"Stolen"}),
            true,
        );
        assert_eq!(edit["body"]["data"]["code"], "member_not_found", "{edit}");
        let removed = run(
            &w,
            actor,
            "meals.household.remove",
            json!({"memberId":id}),
            true,
        );
        assert_eq!(removed["body"]["data"], json!({"removed":false}));
    }
    assert_eq!(
        rows_as(
            &w.f,
            a,
            "SELECT name FROM app.meals_household_members WHERE name = 'Stolen'"
        )
        .len(),
        0
    );
    // Negative control: with the owner rule weakened the same observation must fail.
    // The second person owns rows of their own, so the check asks only for the first person's rows.
    // Seed a slot rule, a recipe and a favourite for the first person so those tables have rows to protect.
    let seed = format!(
        "WITH k AS (SELECT kitchen_id FROM app.meals_kitchens WHERE owner_user_id = '{a}'),
         s AS (INSERT INTO app.meals_meal_slot_rules(owner_user_id, kitchen_id, slot_name) SELECT '{a}', kitchen_id, 'dinner' FROM k),
         r AS (INSERT INTO app.meals_recipes(owner_user_id, kitchen_id, recipe_id, title, title_key, steps, cook_minutes, base_servings, source)
               SELECT '{a}', kitchen_id, md5('recipe:{a}')::uuid, 'Soup', 'soup', '[\"stir\"]'::jsonb, 10, 2, 'generated' FROM k)
         INSERT INTO app.meals_favourites(owner_user_id, kitchen_id, member_id, recipe_id)
         SELECT '{a}', k.kitchen_id, '{id}', md5('recipe:{a}')::uuid FROM k"
    );
    w.f.rt.block_on(w.f.root.batch_execute(&seed)).unwrap();
    let kitchens = format!("SELECT kitchen_id FROM app.meals_kitchens WHERE owner_user_id = '{a}'");
    let members = format!("SELECT name FROM app.meals_household_members WHERE name = '{MARK}'");
    let slots =
        format!("SELECT slot_name FROM app.meals_meal_slot_rules WHERE owner_user_id = '{a}'");
    let favourites =
        format!("SELECT recipe_id FROM app.meals_favourites WHERE owner_user_id = '{a}'");
    for (table, sql) in [
        ("app.meals_kitchens", kitchens.as_str()),
        ("app.meals_household_members", members.as_str()),
        ("app.meals_meal_slot_rules", slots.as_str()),
        ("app.meals_favourites", favourites.as_str()),
    ] {
        assert!(rows_as(&w.f, b, sql).is_empty());
        let weaken = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (true)");
        let restore = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id())");
        w.f.rt.block_on(w.f.root.batch_execute(&weaken)).unwrap();
        let weakened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(rows_as(&w.f, b, sql).is_empty())
        }));
        w.f.rt.block_on(w.f.root.batch_execute(&restore)).unwrap();
        assert!(
            weakened.is_err(),
            "privacy check must fail without the rule on {table}"
        );
        assert!(rows_as(&w.f, b, sql).is_empty());
        println!("PASS rls negative control: {table} check failed when weakened and passed after restore");
    }
    let jobs: i64 =
        w.f.rt
            .block_on(w.f.root.query_one(
                "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
                &[&format!("%{MARK}%")],
            ))
            .unwrap()
            .get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(
            &w.app
                .services
                .activity("meals", &w.f.access(actor))
                .unwrap(),
        )
        .unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS privacy: planted household name and preference absent from jobs and host activity; other person and admin refused");
}

#[test]
#[ignore = "Only through verify-gate"]
fn plans_are_private_and_their_jobs_carry_ids_only() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let created = run(
        &w,
        a,
        "meals.plan.create",
        json!({"startDate":"2026-11-20","days":2,"idempotencyKey":"plan-proof-1","requestText":MARK}),
        true,
    );
    let plan = created["body"]["data"].clone();
    assert!(plan["planId"].is_string(), "{created}");
    assert_eq!(plan["days"].as_array().unwrap().len(), 2, "{created}");
    let id = plan["planId"].as_str().unwrap().to_owned();
    // The same key returns the same plan.
    let again = run(
        &w,
        a,
        "meals.plan.create",
        json!({"startDate":"2026-11-20","days":2,"idempotencyKey":"plan-proof-1","requestText":MARK}),
        true,
    );
    assert_eq!(again["body"]["data"]["planId"], json!(id), "{again}");
    let count = |actor: uuid::Uuid| {
        rows_as(&w.f, actor, "SELECT plan_id FROM app.meals_plans").len()
    };
    assert_eq!(count(a), 1);
    // The second person and the admin cannot read or change it.
    for actor in [b, w.f.admin] {
        assert_eq!(count(actor), 0);
        let got = run(&w, actor, "meals.plan.get", json!({"planId":id}), true);
        assert!(!got.to_string().contains(MARK), "{got}");
        assert_eq!(got["body"]["data"]["code"], "invalid_input", "{got}");
        let stop = run(
            &w,
            actor,
            "meals.plan.control",
            json!({"planId":id,"action":"stop"}),
            true,
        );
        assert_eq!(stop["body"]["data"]["code"], "invalid_input", "{stop}");
    }
    let mine = run(&w, a, "meals.plan.get", json!({"planId":id}), true);
    assert_eq!(mine["body"]["data"]["planId"], json!(id), "{mine}");
    // Negative control: without the owner rule the second person sees the plan.
    for table in ["app.meals_plans", "app.meals_plan_days"] {
        let weaken = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (true)");
        let restore = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id())");
        let sql = format!("SELECT 1 FROM {table}");
        assert!(rows_as(&w.f, b, &sql).is_empty());
        w.f.rt.block_on(w.f.root.batch_execute(&weaken)).unwrap();
        let seen = rows_as(&w.f, b, &sql).len();
        w.f.rt.block_on(w.f.root.batch_execute(&restore)).unwrap();
        assert!(seen > 0, "second person must see {table} without the rule");
        assert!(rows_as(&w.f, b, &sql).is_empty());
    }
    // Jobs carry ids and counts only.
    let payloads: Vec<String> = w
        .f
        .rt
        .block_on(w.f.root.query(
            "SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%meals-plan-day'",
            &[],
        ))
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(!payloads.is_empty(), "creating a plan queues a day job");
    for p in &payloads {
        assert!(!p.contains(MARK), "{p}");
    }
    let everywhere: i64 = w
        .f
        .rt
        .block_on(w.f.root.query_one(
            "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
            &[&format!("%{MARK}%")],
        ))
        .unwrap()
        .get(0);
    assert_eq!(everywhere, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS plans: owner-only with negative control, same key gives one plan, job payloads carry ids only");
}
