//! Cooking, ratings and undo proofs through the installed Wasm component and the old handlers.
use super::lists::seed_plan;
use super::tools::run;
use super::*;
use std::collections::HashMap;

const MISSING: &str = "99999999-9999-4999-8999-999999999999";

/// Remembers the ids a reply names so later steps can use them, keeping the first one seen for items and lines.
fn learn(state: &mut HashMap<String, String>, body: &Value) {
    let data = &body["data"];
    if let Some(id) = data["undo"]["actionId"].as_str() {
        state.insert("act".into(), id.into());
    }
    if let Some(me) = data["members"].as_array().and_then(|m| m.iter().find(|m| m["isSelf"] == true)) {
        state.insert("me".into(), me["memberId"].as_str().unwrap().into());
    }
    let pantry = if data["pantry"].is_object() { &data["pantry"] } else { data };
    if let Some(item) = pantry["items"].as_array().and_then(|a| a.first()) {
        state.entry("item".into()).or_insert_with(|| item["itemId"].as_str().unwrap().into());
    }
    let list = if data["list"].is_object() { &data["list"] } else { data };
    for (n, line) in list["lines"].as_array().into_iter().flatten().take(2).enumerate() {
        state.entry(format!("l{n}")).or_insert_with(|| line["lineId"].as_str().unwrap().into());
    }
}

fn fill_all(params: &Value, state: &HashMap<String, String>) -> Value {
    let mut text = params.to_string();
    for (key, value) in state {
        text = text.replace(&format!("{{{key}}}"), value);
    }
    text.parse().unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_cooking_rating_and_undo_match_the_old_handlers_step_for_step() {
    let w = World::new();
    let (new_actor, old_actor) = (w.f.a, w.add_user());
    let setup = json!({"unitsSystem":"metric"});
    run(&w, new_actor, "meals.kitchen.save", setup.clone(), true);
    replay::old_tool(old_actor, &role(), "meals.kitchen.save", setup);
    let new_ids = seed_plan(&w, new_actor, "new");
    let old_ids = seed_plan(&w, old_actor, "old");
    let mut new_state = HashMap::from([("plan".to_owned(), new_ids[0].clone()), ("meal".to_owned(), new_ids[3].clone())]);
    let mut old_state = HashMap::from([("plan".to_owned(), old_ids[0].clone()), ("meal".to_owned(), old_ids[3].clone())]);
    let steps: Vec<(&str, Value)> = vec![
        ("meals.kitchen.get", json!({})),
        ("meals.pantry.edit", json!({"action":"add","name":"Milk","quantity":5,"unit":"cup"})),
        ("meals.pantry.edit", json!({"action":"add","name":"Eggs","quantity":2})),
        ("meals.pantry.edit", json!({"action":"add","name":"Flour","quantity":1000,"unit":"g"})),
        ("meals.pantry.edit", json!({"action":"add","name":"Rice"})),
        ("meals.pantry.get", json!({})),
        // Ratings.
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":"{me}","stars":5}]})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":"{me}","stars":6}]})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":"{me}","stars":2.5}]})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":MISSING,"stars":3}]})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[]})),
        ("meals.meal.rate", json!({"mealId":MISSING,"ratings":[{"memberId":"{me}","stars":3}]})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":"{me}","stars":1}]})),
        ("meals.plan.get", json!({"planId":"{plan}"})),
        ("meals.meal.rate", json!({"mealId":"{meal}","ratings":[{"memberId":"{me}","stars":null}]})),
        ("meals.plan.get", json!({"planId":"{plan}"})),
        // Cooking and its undo.
        ("meals.meal.cooked", json!({"mealId":MISSING})),
        ("meals.meal.cooked", json!({"mealId":"{meal}","extra":1})),
        ("meals.meal.cooked", json!({"mealId":"{meal}"})),
        ("meals.meal.cooked", json!({"mealId":"{meal}"})),
        ("meals.pantry.get", json!({})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.undo", json!({"actionId":MISSING})),
        ("meals.undo", json!({"actionId":"{act}","extra":1})),
        ("meals.pantry.get", json!({})),
        // Cook again, edit the Pantry afterwards, then undo: the edited amounts are skipped.
        ("meals.meal.cooked", json!({"mealId":"{meal}"})),
        ("meals.pantry.edit", json!({"action":"update","itemId":"{item}","quantity":9})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.pantry.get", json!({})),
        // Removing a Pantry item, then undo.
        ("meals.pantry.edit", json!({"action":"remove","itemId":"{item}"})),
        ("meals.pantry.get", json!({})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.pantry.get", json!({})),
        // Removing a shopping line, then undo.
        ("meals.list.build", json!({"planId":"{plan}"})),
        ("meals.list.edit", json!({"action":"remove","lineId":"{l0}"})),
        ("meals.list.get", json!({})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.list.get", json!({})),
        // Bought, then undo, then Bought again with a Pantry edit in between.
        ("meals.list.edit", json!({"action":"tick","lineIds":["{l0}","{l1}"]})),
        ("meals.list.bought", json!({})),
        ("meals.pantry.get", json!({})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.pantry.get", json!({})),
        ("meals.list.get", json!({})),
        ("meals.list.bought", json!({})),
        ("meals.pantry.edit", json!({"action":"update","itemId":"{item}","quantity":7})),
        ("meals.undo", json!({"actionId":"{act}"})),
        ("meals.pantry.get", json!({})),
        ("meals.list.get", json!({})),
    ];
    for (n, (tool, params)) in steps.iter().enumerate() {
        let new = run(&w, new_actor, tool, fill_all(params, &new_state), true);
        assert_eq!(new["status"], 200, "step {n} {tool}: {new}");
        let old = replay::old_tool(old_actor, &role(), tool, fill_all(params, &old_state));
        learn(&mut new_state, &new["body"]);
        learn(&mut old_state, &old);
        let (mut a, mut b) = (receipts::legacy_reply(new["body"].clone()), old.clone());
        replay::mask(&mut a);
        replay::mask(&mut b);
        assert_eq!(a, b, "step {n} {tool} {params}");
    }
    println!("PASS parity: {} cooking, rating and undo steps match the old handlers", steps.len());
}

/// The Pantry and list lines as a person sees them, without ids or times.
fn state_of(w: &World, actor: uuid::Uuid) -> Vec<String> {
    let sql = format!(
        "SELECT 'p|'||name||'|'||coalesce(quantity::text,'')||'|'||coalesce(unit,'') FROM app.meals_pantry_items WHERE owner_user_id='{actor}'
         UNION ALL SELECT 'l|'||name||'|'||coalesce(quantity::text,'')||'|'||coalesce(bought_at::text,'-') FROM app.meals_shopping_list_items WHERE owner_user_id='{actor}'
         UNION ALL SELECT 'm|'||(cooked_at IS NOT NULL)::text FROM app.meals_planned_meals WHERE owner_user_id='{actor}'
         ORDER BY 1"
    );
    w.f.rt.block_on(w.f.root.query(&sql, &[])).unwrap().iter().map(|r| r.get(0)).collect()
}

#[test]
#[ignore = "Only through verify-gate"]
fn undo_restores_the_record_before_the_write_for_each_write_kind() {
    let w = World::new();
    let a = w.f.a;
    run(&w, a, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    let [plan, _, _, meal] = seed_plan(&w, a, "kinds");
    for item in [json!({"name":"Milk","quantity":5,"unit":"cup"}), json!({"name":"Eggs","quantity":2}), json!({"name":"Flour","quantity":1000,"unit":"g"})] {
        let mut p = json!({"action":"add"});
        p.as_object_mut().unwrap().extend(item.as_object().unwrap().clone());
        run(&w, a, "meals.pantry.edit", p, true);
    }
    let built = run(&w, a, "meals.list.build", json!({"planId":plan}), true);
    let lines: Vec<String> = built["body"]["data"]["lines"].as_array().unwrap().iter().map(|l| l["lineId"].as_str().unwrap().to_owned()).collect();
    let pantry = run(&w, a, "meals.pantry.get", json!({}), true);
    let item = pantry["body"]["data"]["items"][0]["itemId"].as_str().unwrap().to_owned();
    let undo = |reply: &Value| reply["body"]["data"]["undo"]["actionId"].as_str().unwrap().to_owned();
    // Each write kind: remember the state, write, check it changed, undo, check it is back.
    let writes: Vec<(&str, Value)> = vec![
        ("removed item", json!(["meals.pantry.edit", {"action":"remove","itemId":item}])),
        ("removed line", json!(["meals.list.edit", {"action":"remove","lineId":lines[0]}])),
        ("cooked", json!(["meals.meal.cooked", {"mealId":meal}])),
        ("bought", json!(["meals.list.bought", {"lines":[{"lineId":lines[1]},{"lineId":lines[2]}]}])),
    ];
    run(&w, a, "meals.list.edit", json!({"action":"tick","lineIds":[lines[1], lines[2]]}), true);
    for (kind, write) in writes {
        let before = state_of(&w, a);
        let reply = run(&w, a, write[0].as_str().unwrap(), write[1].clone(), true);
        assert_eq!(reply["status"], 200, "{kind}: {reply}");
        assert_ne!(before, state_of(&w, a), "{kind} must change something");
        let undone = run(&w, a, "meals.undo", json!({"actionId":undo(&reply)}), true);
        assert_eq!(undone["body"]["data"]["skipped"], 0, "{kind}: {undone}");
        assert_eq!(before, state_of(&w, a), "{kind}: undo must restore the state before the write");
        println!("PASS undo {kind}: state after undo equals state before the write");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn ratings_and_undo_records_are_private_and_keep_text_out_of_jobs_and_activity() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    run(&w, a, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    let [_, _, _, meal] = seed_plan(&w, a, "owner");
    let kitchen = run(&w, a, "meals.kitchen.get", json!({}), true);
    let me = kitchen["body"]["data"]["members"].as_array().unwrap().iter().find(|m| m["isSelf"] == true).unwrap()["memberId"].as_str().unwrap().to_owned();
    run(&w, a, "meals.pantry.edit", json!({"action":"add","name":MARK,"quantity":3,"unit":"cup"}), true);
    run(&w, a, "meals.pantry.edit", json!({"action":"add","name":"Milk","quantity":5,"unit":"cup"}), true);
    let rated = run(&w, a, "meals.meal.rate", json!({"mealId":meal,"ratings":[{"memberId":me,"stars":4}]}), true);
    assert_eq!(rated["status"], 200, "{rated}");
    let cooked = run(&w, a, "meals.meal.cooked", json!({"mealId":meal}), true);
    let act = cooked["body"]["data"]["undo"]["actionId"].as_str().unwrap().to_owned();
    let pantry = run(&w, a, "meals.pantry.get", json!({}), true);
    let marked = pantry["body"]["data"]["items"].as_array().unwrap().iter().find(|i| i["name"] == MARK).unwrap()["itemId"].as_str().unwrap().to_owned();
    let removed = run(&w, a, "meals.pantry.edit", json!({"action":"remove","itemId":marked}), true);
    assert_eq!(removed["status"], 200, "{removed}");
    // The second person and the admin cannot rate, cook or undo someone else's records.
    for actor in [b, w.f.admin] {
        let refused = [
            run(&w, actor, "meals.undo", json!({"actionId":act}), true),
            run(&w, actor, "meals.undo", json!({"actionId":removed["body"]["data"]["undo"]["actionId"]}), true),
            run(&w, actor, "meals.meal.cooked", json!({"mealId":meal}), true),
            run(&w, actor, "meals.meal.rate", json!({"mealId":meal,"ratings":[{"memberId":me,"stars":1}]}), true),
        ];
        for r in refused {
            assert_eq!(r["body"]["data"]["code"], "invalid_input", "{r}");
        }
        let seen = run(&w, actor, "meals.pantry.get", json!({}), true);
        assert!(!seen.to_string().contains(MARK), "{seen}");
    }
    for table in ["app.meals_ratings", "app.meals_undo_actions"] {
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
    // The undo record does hold the private name, so the table check above has something to protect.
    let kept: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.meals_undo_actions WHERE owner_user_id = $1 AND before_state::text LIKE $2", &[&a, &format!("%{MARK}%")])).unwrap().get(0);
    assert_eq!(kept, 1);
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")])).unwrap().get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS cooking: ratings and undo records owner-only with negative control, marker absent from jobs and activity");
}
