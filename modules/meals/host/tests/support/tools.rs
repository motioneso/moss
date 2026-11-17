//! Tool proofs through the installed Wasm component and its host approval transport.
use super::*;

fn run(w: &World, actor: uuid::Uuid, tool: &str, parameters: Value, approve: bool) -> Value {
    if approve {
        w.app
            .services
            .approve_tool(&w.f.access(actor), "meals", tool, &parameters)
            .unwrap();
    }
    w.call(actor, "POST", "/meals/tools/run", json!({"tool":tool,"parameters":parameters}))
}
fn compare(mut a: Value, mut b: Value) {
    replay::mask(&mut a);
    replay::mask(&mut b);
    assert_eq!(a, b);
}
fn fill(params: &Value, member: &str, own: &str) -> Value {
    params.to_string().replace("{member}", member).replace("{self}", own).parse().unwrap()
}
fn self_id(view: &Value) -> String {
    view["data"]["members"].as_array().unwrap().iter()
        .find(|m| m["isSelf"] == true).unwrap()["memberId"].as_str().unwrap().to_owned()
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_tools_match_the_old_handlers_step_for_step() {
    let w = World::new();
    let (new_actor, old_actor) = (w.f.a, w.add_user());
    let missing = "99999999-9999-4999-8999-999999999999";
    // Without approval a write is refused and changes nothing.
    let refused = run(&w, new_actor, "meals.kitchen.save", json!({"unitsSystem":"metric"}), false);
    assert_eq!(refused["status"], 403, "{refused}");
    let steps: Vec<(&str, Value)> = vec![
        ("meals.kitchen.get", json!({})),
        ("meals.kitchen.get", json!({"extra":1})),
        ("meals.kitchen.save", json!({"unitsSystem":"metric","defaultPantryMode":"prefer","slotRules":[{"slotName":"Lunch","soloWeekdays":[1,2],"usualTime":"12:30"}]})),
        ("meals.kitchen.save", json!({"unitsSystem":"imperial"})),
        ("meals.kitchen.save", json!({"slotRules":[{"slotName":"Dinner","usualTime":"25:00"}]})),
        ("meals.kitchen.get", json!({})),
        ("meals.household.save", json!({"name":"Sam","linkedAccountEmail":"sam@example.test","calorieTarget":2000,"restrictions":["nuts"]})),
        ("meals.household.save", json!({"name":""})),
        ("meals.household.save", json!({"memberId":"{member}","name":"Samuel","calorieTarget":null})),
        ("meals.household.save", json!({"memberId":missing,"name":"Nobody"})),
        ("meals.kitchen.get", json!({})),
        ("meals.household.remove", json!({"memberId":"{self}"})),
        ("meals.household.remove", json!({"memberId":"{member}"})),
        ("meals.household.remove", json!({"memberId":"{member}"})),
        ("meals.kitchen.get", json!({})),
    ];
    let (mut new_member, mut old_member) = (String::new(), String::new());
    let (mut new_self, mut old_self) = (String::new(), String::new());
    for (n, (tool, params)) in steps.iter().enumerate() {
        let new = run(&w, new_actor, tool, fill(params, &new_member, &new_self), true);
        assert_eq!(new["status"], 200, "step {n}: {new}");
        let old = replay::old_tool(old_actor, &role(), tool, fill(params, &old_member, &old_self));
        if *tool == "meals.household.save" && params.get("memberId").is_none() && new["body"]["data"].get("memberId").is_some() {
            new_member = new["body"]["data"]["memberId"].as_str().unwrap().into();
            old_member = old["data"]["memberId"].as_str().unwrap().into();
        }
        if *tool == "meals.kitchen.get" && new_self.is_empty() {
            new_self = self_id(&new["body"]);
            old_self = self_id(&old);
        }
        compare(new["body"].clone(), old);
    }
    println!("PASS parity: {} tool steps match the old handlers", steps.len());
}

#[test]
#[ignore = "Only through verify-gate"]
fn tools_keep_both_tables_private_and_leave_no_text_behind() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    run(&w, a, "meals.kitchen.save", json!({"unitsSystem":"metric"}), true);
    let member = run(&w, a, "meals.household.save", json!({"name":MARK,"preferences":[MARK]}), true);
    let id = member["body"]["data"]["memberId"].as_str().unwrap().to_owned();
    for actor in [b, w.f.admin] {
        let view = run(&w, actor, "meals.kitchen.get", json!({}), true);
        assert!(!view.to_string().contains(MARK), "{view}");
        assert_eq!(view["body"]["data"]["members"].as_array().unwrap().len(), 1);
        let edit = run(&w, actor, "meals.household.save", json!({"memberId":id,"name":"Stolen"}), true);
        assert_eq!(edit["body"]["data"]["code"], "member_not_found", "{edit}");
        let removed = run(&w, actor, "meals.household.remove", json!({"memberId":id}), true);
        assert_eq!(removed["body"]["data"], json!({"removed":false}));
    }
    assert_eq!(rows_as(&w.f, a, "SELECT name FROM app.meals_household_members WHERE name = 'Stolen'").len(), 0);
    // Negative control: with the owner rule weakened the same observation must fail.
    // The second person owns rows of their own, so the check asks only for the first person's rows.
    let kitchens = format!("SELECT kitchen_id FROM app.meals_kitchens WHERE owner_user_id = '{a}'");
    let members = format!("SELECT name FROM app.meals_household_members WHERE name = '{MARK}'");
    for (table, sql) in [("app.meals_kitchens", kitchens.as_str()), ("app.meals_household_members", members.as_str())] {
        assert!(rows_as(&w.f, b, sql).is_empty());
        let weaken = format!("DROP POLICY moss_module_select ON {table}; CREATE POLICY moss_module_select ON {table} FOR SELECT TO {} USING (true)", role());
        let restore = format!("DROP POLICY moss_module_select ON {table}; CREATE POLICY moss_module_select ON {table} FOR SELECT TO {} USING (owner_user_id=app.current_actor_user_id())", role());
        w.f.rt.block_on(w.f.root.batch_execute(&weaken)).unwrap();
        let weakened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(rows_as(&w.f, b, sql).is_empty())
        }));
        w.f.rt.block_on(w.f.root.batch_execute(&restore)).unwrap();
        assert!(weakened.is_err(), "privacy check must fail without the rule on {table}");
        assert!(rows_as(&w.f, b, sql).is_empty());
        println!("PASS rls negative control: {table} check failed when weakened and passed after restore");
    }
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
        &[&format!("%{MARK}%")],
    )).unwrap().get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS privacy: planted household name and preference absent from jobs and host activity; other person and admin refused");
}
