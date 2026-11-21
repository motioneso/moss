//! List and pantry proofs through the installed Wasm component and the old handlers.
use super::tools::run;
use super::*;
use std::collections::HashMap;

const INGREDIENTS: [(&str, &str, &str, &str, &str); 5] = [
    ("2 cups milk", "milk", "2", "'cup'", "dairy_eggs"),
    ("3 eggs", "eggs", "3", "NULL", "dairy_eggs"),
    ("1 lb chicken breast", "chicken breast", "1", "'lb'", "meat_fish"),
    ("salt", "salt", "NULL", "NULL", "spices"),
    ("500 g flour", "flour", "500", "'g'", "pantry"),
];

/// One ready Monday dinner for a person, with ids that differ per person so runs can be paired.
pub(super) fn seed_plan(w: &World, actor: uuid::Uuid, salt: &str) -> [String; 4] {
    // Valid version-4 ids, because the job queue refuses any other shape.
    let id = |n: &str| format!("overlay(overlay(md5('{salt}-{n}') placing '4' from 13) placing '8' from 17)::uuid");
    let mut sql = format!(
        "INSERT INTO app.meals_plans(owner_user_id,kitchen_id,plan_id,start_date,day_count,pantry_mode,idempotency_key)
           SELECT '{actor}',kitchen_id,{plan},DATE '2026-11-09',1,'prefer','{salt}' FROM app.meals_kitchens WHERE owner_user_id='{actor}';
         INSERT INTO app.meals_plan_days(owner_user_id,kitchen_id,plan_id,day_id,day_date,status)
           SELECT '{actor}',kitchen_id,{plan},{day},DATE '2026-11-09','ready' FROM app.meals_kitchens WHERE owner_user_id='{actor}';
         INSERT INTO app.meals_recipes(owner_user_id,kitchen_id,recipe_id,title,title_key,steps,cook_minutes,base_servings,source)
           SELECT '{actor}',kitchen_id,{recipe},'Fixture','fixture','[\"stir\"]'::jsonb,10,2,'generated' FROM app.meals_kitchens WHERE owner_user_id='{actor}';
         INSERT INTO app.meals_planned_meals(owner_user_id,kitchen_id,day_id,meal_id,slot_name,slot_position,kind,sharing,status,recipe_id)
           SELECT '{actor}',kitchen_id,{day},{meal},'dinner',0,'recipe','shared','ready',{recipe} FROM app.meals_kitchens WHERE owner_user_id='{actor}';
         INSERT INTO app.meals_planned_meal_eaters(owner_user_id,kitchen_id,meal_id,member_id,portion)
           SELECT '{actor}',kitchen_id,{meal},member_id,1.5 FROM app.meals_household_members WHERE owner_user_id='{actor}' AND is_self;",
        plan = id("plan"), day = id("day"), recipe = id("recipe"), meal = id("meal"),
    );
    for (n, (text, name, quantity, unit, section)) in INGREDIENTS.iter().enumerate() {
        sql += &format!(
            "INSERT INTO app.meals_recipe_ingredients(owner_user_id,kitchen_id,recipe_id,position,original_text,name,name_key,quantity,unit,store_section)
               SELECT '{actor}',kitchen_id,{recipe},{n},'{text}','{name}','{name}',{quantity},{unit},'{section}' FROM app.meals_kitchens WHERE owner_user_id='{actor}';",
            recipe = id("recipe")
        );
    }
    w.f.rt.block_on(w.f.root.batch_execute(&sql)).unwrap();
    let uuid = |n: &str| -> String {
        w.f.rt.block_on(w.f.root.query_one(&format!("SELECT {}::text", id(n)), &[])).unwrap().get(0)
    };
    [uuid("plan"), uuid("day"), uuid("recipe"), uuid("meal")]
}

fn learn(state: &mut HashMap<String, String>, body: &Value) {
    let data = &body["data"];
    let list = if data["list"].is_object() { &data["list"] } else { data };
    if let Some(id) = list["listId"].as_str() {
        state.insert("list".into(), id.into());
    }
    for (n, line) in list["lines"].as_array().into_iter().flatten().take(3).enumerate() {
        state.insert(format!("l{n}"), line["lineId"].as_str().unwrap().into());
    }
    let pantry = if data["pantry"].is_object() { &data["pantry"] } else { data };
    if let Some(item) = pantry["items"].as_array().and_then(|a| a.first()) {
        state.insert("item".into(), item["itemId"].as_str().unwrap().into());
    }
    for (n, key) in ["staple", "staple2"].iter().enumerate() {
        if let Some(s) = pantry["staples"].as_array().and_then(|a| a.get(n)) {
            state.insert((*key).into(), s["stapleId"].as_str().unwrap().into());
        }
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
fn installed_list_and_pantry_tools_match_the_old_handlers_step_for_step() {
    let w = World::new();
    let (new_actor, old_actor) = (w.f.a, w.add_user());
    let setup = json!({"unitsSystem":"metric"});
    run(&w, new_actor, "meals.kitchen.save", setup.clone(), true);
    replay::old_tool(old_actor, &role(), "meals.kitchen.save", setup);
    let new_ids = seed_plan(&w, new_actor, "new");
    let old_ids = seed_plan(&w, old_actor, "old");
    let mut new_state = HashMap::from([("plan".to_owned(), new_ids[0].clone())]);
    let mut old_state = HashMap::from([("plan".to_owned(), old_ids[0].clone())]);
    let missing = "99999999-9999-4999-8999-999999999999";
    let steps: Vec<(&str, Value)> = vec![
        ("meals.list.get", json!({})),
        ("meals.list.get", json!({"extra":1})),
        ("meals.pantry.get", json!({})),
        ("meals.list.edit", json!({"action":"add","name":"Bread","quantity":2.0004,"unit":"Loaves","section":"bakery"})),
        ("meals.list.edit", json!({"action":"add","name":"Bread","quantity":0})),
        ("meals.list.edit", json!({"action":"add"})),
        ("meals.list.edit", json!({"action":"fly"})),
        ("meals.list.build", json!({"planId":missing})),
        ("meals.list.build", json!({"planId":"{plan}"})),
        ("meals.list.build", json!({"planId":"{plan}"})),
        ("meals.list.get", json!({})),
        ("meals.list.edit", json!({"action":"tick","lineIds":["{l0}","{l1}"]})),
        ("meals.list.edit", json!({"action":"tick","lineIds":[missing]})),
        ("meals.list.edit", json!({"action":"tick","lineIds":["nope"]})),
        ("meals.list.edit", json!({"action":"update","lineId":"{l2}","quantity":5,"unit":"Cups"})),
        ("meals.list.edit", json!({"action":"update","lineId":"{l0}","name":"Renamed"})),
        ("meals.list.edit", json!({"action":"update","lineId":missing,"name":"x"})),
        ("meals.list.edit", json!({"action":"untick","lineId":"{l1}"})),
        ("meals.list.bought", json!({"lines":[{"lineId":"{l0}","quantity":3,"unit":"kg"}]})),
        ("meals.list.bought", json!({"lines":[{"lineId":"{l0}"}]})),
        ("meals.list.bought", json!({})),
        ("meals.list.get", json!({})),
        ("meals.pantry.edit", json!({"action":"add","name":"Eggs","quantity":12})),
        ("meals.pantry.edit", json!({"action":"add","name":"Rice","quantity":null,"unit":"Kilograms"})),
        ("meals.pantry.edit", json!({"action":"add","name":"Beans","quantity":-1})),
        ("meals.list.get", json!({})),
        ("meals.pantry.edit", json!({"action":"update","itemId":"{item}","name":"Brown rice","quantity":2})),
        ("meals.pantry.edit", json!({"action":"update","itemId":missing,"name":"x"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Salt"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"add","name":"salt"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Pepper"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"update","stapleId":"{staple2}","name":"PEPPER"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"update","stapleId":"{staple}","name":"Sea salt"})),
        ("meals.pantry.edit", json!({"target":"staple","action":"remove","stapleId":missing})),
        ("meals.pantry.edit", json!({"action":"remove","itemId":"{item}"})),
        ("meals.pantry.edit", json!({"action":"remove","itemId":"{item}"})),
        ("meals.list.edit", json!({"action":"remove","lineId":"{l1}"})),
        ("meals.list.edit", json!({"action":"remove","lineId":"{l1}"})),
        ("meals.list.get", json!({})),
        ("meals.list.clear", json!({"listId":missing})),
        ("meals.list.clear", json!({"listId":"{list}"})),
        ("meals.list.clear", json!({"listId":"{list}"})),
        ("meals.list.get", json!({})),
        ("meals.pantry.get", json!({})),
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
    println!("PASS parity: {} list and pantry steps match the old handlers", steps.len());
}

fn digest(w: &World, table: &str, owner: uuid::Uuid) -> String {
    w.f.rt
        .block_on(w.f.root.query_one(
            &format!("SELECT coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)),'') FROM {table} t WHERE owner_user_id = '{owner}'"),
            &[],
        ))
        .unwrap()
        .get(0)
}

const LIST_TABLES: [&str; 5] = [
    "app.meals_shopping_lists",
    "app.meals_shopping_list_items",
    "app.meals_pantry_items",
    "app.meals_staples",
    "app.meals_undo_actions",
];

#[test]
#[ignore = "Only through verify-gate"]
fn lists_and_pantry_are_private_and_clearing_a_list_touches_nothing_else() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    run(&w, a, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    let [plan, ..] = seed_plan(&w, a, "owner");
    let built = run(&w, a, "meals.list.build", json!({"planId":plan}), true);
    assert_eq!(built["status"], 200, "{built}");
    let list_id = built["body"]["data"]["listId"].as_str().unwrap().to_owned();
    assert_eq!(built["body"]["data"]["lines"].as_array().unwrap().len(), 5, "{built}");
    let marked = run(&w, a, "meals.list.edit", json!({"action":"add","name":MARK,"quantity":1,"unit":MARK}), true);
    let line = marked["body"]["data"]["list"]["lines"].as_array().unwrap().iter().find(|l| l["name"] == MARK).unwrap()["lineId"].as_str().unwrap().to_owned();
    run(&w, a, "meals.list.edit", json!({"action":"tick","lineId":line}), true);
    let bought = run(&w, a, "meals.list.bought", json!({}), true);
    assert_eq!(bought["body"]["data"]["pantryAdded"], 1, "{bought}");
    run(&w, a, "meals.pantry.edit", json!({"action":"add","name":format!("{MARK} rice")}), true);
    run(&w, a, "meals.pantry.edit", json!({"target":"staple","action":"add","name":format!("{MARK} salt")}), true);
    // The second person and the admin see nothing and can change nothing.
    for actor in [b, w.f.admin] {
        for tool in ["meals.list.get", "meals.pantry.get"] {
            let view = run(&w, actor, tool, json!({}), true);
            assert!(!view.to_string().contains(MARK), "{view}");
        }
        let got = run(&w, actor, "meals.list.get", json!({}), true);
        assert_eq!(got["body"]["data"]["lines"].as_array().unwrap().len(), 0, "{got}");
        for params in [json!({"action":"remove","lineId":line}), json!({"action":"tick","lineId":line}), json!({"action":"update","lineId":line,"name":"Stolen"})] {
            let refused = run(&w, actor, "meals.list.edit", params.clone(), true);
            if params["action"] == "tick" {
                assert_eq!(refused["body"]["data"]["list"]["lines"].as_array().unwrap().len(), 0, "{refused}");
            } else {
                assert_eq!(refused["body"]["data"]["code"], "invalid_input", "{refused}");
            }
        }
        let cleared = run(&w, actor, "meals.list.clear", json!({"listId":list_id}), true);
        assert_eq!(cleared["body"]["data"]["code"], "invalid_input", "{cleared}");
    }
    for table in LIST_TABLES {
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
    // Clearing touches the list's lines and nothing else, and not the second person's rows.
    run(&w, b, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    run(&w, b, "meals.list.edit", json!({"action":"add","name":"Other person's soap"}), true);
    let others = [
        "app.meals_plans", "app.meals_plan_days", "app.meals_planned_meals", "app.meals_planned_meal_eaters",
        "app.meals_recipes", "app.meals_recipe_ingredients", "app.meals_kitchens", "app.meals_household_members",
        "app.meals_shopping_lists", "app.meals_pantry_items", "app.meals_staples", "app.meals_undo_actions",
    ];
    let snapshot = |w: &World| -> Vec<String> {
        others.iter().map(|t| digest(w, t, a)).chain(LIST_TABLES.iter().map(|t| digest(w, t, b))).collect()
    };
    let before = snapshot(&w);
    let lines_before = digest(&w, "app.meals_shopping_list_items", a);
    let cleared = run(&w, a, "meals.list.clear", json!({"listId":list_id}), true);
    assert_eq!(receipts::legacy_reply(cleared["body"].clone())["data"], json!({"cleared":true}), "{cleared}");
    assert_ne!(lines_before, digest(&w, "app.meals_shopping_list_items", a));
    let left: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM app.meals_shopping_list_items WHERE owner_user_id = '{a}'"), &[])).unwrap().get(0);
    assert_eq!(left, 0);
    assert_eq!(before, snapshot(&w), "clearing changed a table other than the lines");
    // Private text stays out of jobs and host activity.
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")])).unwrap().get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS lists: owner-only with negative control on 5 tables, clear touched only the lines, marker absent from jobs and activity");
}
