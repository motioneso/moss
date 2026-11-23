mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const PLAN: &str = "00000000-0000-4000-8000-00000000f001";
const DAY: &str = "00000000-0000-4000-8000-00000000f002";
const MEAL: &str = "00000000-0000-4000-8000-00000000f003";
const RECIPE: &str = "00000000-0000-4000-8000-00000000f004";
const KITCHEN: &str = "00000000-0000-4000-8000-00000000f005";
const LISTS: &str = "app.meals_shopping_lists";
const ITEMS: &str = "app.meals_shopping_list_items";
const PANTRY: &str = "app.meals_pantry_items";
const STAPLES: &str = "app.meals_staples";
const UNDO: &str = "app.meals_undo_actions";

/// A plan with one ready Monday dinner whose recipe needs 2 cups of milk and 3 eggs.
fn planned(f: &Fake) {
    f.seed("app.meals_plans", A, json!({"plan_id":PLAN,"kitchen_id":KITCHEN,"start_date":"2026-11-09","pantry_mode":"prefer","state":"active"}));
    f.seed("app.meals_plan_days", A, json!({"day_id":DAY,"plan_id":PLAN,"day_date":"2026-11-09","status":"ready"}));
    f.seed("app.meals_planned_meals", A, json!({"meal_id":MEAL,"day_id":DAY,"slot_position":0,"slot_name":"dinner","status":"ready","recipe_id":RECIPE,"servings_override":null}));
    f.seed("app.meals_recipes", A, json!({"recipe_id":RECIPE,"base_servings":2}));
    for (i, (name, q, unit, section)) in [("milk", 2, "cup", "dairy_eggs"), ("egg", 3, "", "dairy_eggs")].iter().enumerate() {
        f.seed("app.meals_recipe_ingredients", A, json!({"recipe_id":RECIPE,"position":i,"name":name,"quantity":q,"unit":if unit.is_empty() {Value::Null} else {json!(unit)},"store_section":section}));
    }
}

fn lines(list: &Value) -> Vec<Value> {
    list["lines"].as_array().cloned().unwrap_or_default()
}

#[test]
fn a_new_account_reads_an_empty_list_without_writing() {
    let f = Fake::new();
    let list = f.ok("meals.list.get", json!({}));
    assert_eq!(lines(&list).len(), 0);
    assert!(f.rows(LISTS).is_empty());
    let pantry = f.ok("meals.pantry.get", json!({}));
    assert_eq!(pantry, json!({"items":[],"staples":[]}));
    assert!(f.rows(PANTRY).is_empty());
}

#[test]
fn manual_lines_add_update_tick_untick_and_remove_with_undo() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Bread","quantity":2.0004,"unit":"loaves"}));
    let line = lines(&added["list"])[0].clone();
    assert_eq!(line["manual"], true);
    assert_eq!(line["quantity"], 2);
    let id = line["lineId"].as_str().unwrap();
    let updated = f.ok("meals.list.edit", json!({"action":"update","lineId":id,"name":"Rye bread","quantity":3}));
    assert_eq!(lines(&updated["list"])[0]["name"], "Rye bread");
    assert_eq!(lines(&updated["list"])[0]["quantity"], 3);
    let ticked = f.ok("meals.list.edit", json!({"action":"tick","lineIds":[id]}));
    assert!(lines(&ticked["list"])[0]["checkedAt"].is_string());
    let unticked = f.ok("meals.list.edit", json!({"action":"untick","lineId":id}));
    assert!(lines(&unticked["list"])[0]["checkedAt"].is_null());
    let removed = f.ok("meals.list.edit", json!({"action":"remove","lineId":id}));
    assert_eq!(lines(&removed["list"]).len(), 0);
    assert_eq!(removed["undo"]["kind"], "removed");
    let undo = f.rows(UNDO);
    assert_eq!(undo.len(), 1);
    assert_eq!(undo[0]["before_state"]["lines"][0]["name"], "Rye bread");
    let (_, message) = f.refused("meals.list.edit", json!({"action":"update","lineId":id,"name":"x"}));
    assert_eq!(message, "There is no shopping list line with that id");
}

#[test]
fn list_inputs_are_checked_with_the_old_messages() {
    let f = Fake::new();
    let refuse = |input: Value| f.refused("meals.list.edit", input).1;
    assert_eq!(refuse(json!({})), "action is required");
    assert_eq!(refuse(json!({"action":"add","name":"x","quantity":0})), "quantity must be a number above 0");
    assert_eq!(refuse(json!({"action":"add","name":"x","bogus":1})), "unknown key: bogus");
    assert_eq!(refuse(json!({"action":"tick","lineIds":[]})), "lineIds must hold 1 to 100 line ids");
    assert_eq!(f.refused("meals.list.bought", json!({})).1, "Tick the lines you bought first");
    assert_eq!(f.refused("meals.list.bought", json!({"lines":"x"})).1, "lines must hold 1 to 100 entries");
    assert_eq!(f.refused("meals.list.build", json!({"planId":PLAN})).1, "No plan with that id");
    assert_eq!(f.refused("meals.list.clear", json!({"listId":PLAN})).1, "No shopping list with that id");
}

#[test]
fn building_from_a_plan_makes_lines_with_meal_labels_and_follows_the_pantry() {
    let f = Fake::new();
    planned(&f);
    let mut built = f.ok("meals.list.build", json!({"planId":PLAN}));
    let changes = built.as_object_mut().unwrap().remove("changed").unwrap();
    let item_changes: Vec<_> = changes.as_array().unwrap().iter()
        .filter(|field| field["label"] == "Shopping item").collect();
    assert_eq!(item_changes.len(), 2);
    for item in f.rows(ITEMS) {
        assert!(item_changes.contains(&&json!({
            "label":"Shopping item","before":"[]","after":json!([item]).to_string()
        })));
    }
    assert_eq!(built["planId"], PLAN);
    let all = lines(&built);
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|l| l["sources"][0]["label"] == "Mon dinner"));
    assert!(all.iter().all(|l| l["coveredByPantry"] == false));
    // A repeat build changes nothing.
    let again = f.ok("meals.list.build", json!({"planId":PLAN}));
    assert_eq!(again, built);
    assert_eq!(f.rows(ITEMS).len(), 2);
    // Stocking eggs makes that line covered, through the pantry hook.
    let pantry = f.ok("meals.pantry.edit", json!({"action":"add","name":"Eggs","quantity":12}));
    assert_eq!(pantry["pantry"]["items"].as_array().unwrap().len(), 1);
    let list = f.ok("meals.list.get", json!({}));
    let egg = lines(&list).into_iter().find(|l| l["name"].as_str().unwrap().to_lowercase().contains("egg")).unwrap();
    assert_eq!(egg["coveredByPantry"], true);
}

#[test]
fn bought_lines_move_to_the_pantry_once_and_record_an_undo() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Flour","quantity":1,"unit":"kg"}));
    let id = lines(&added["list"])[0]["lineId"].as_str().unwrap().to_owned();
    f.ok("meals.list.edit", json!({"action":"tick","lineId":id}));
    let done = f.ok("meals.list.bought", json!({}));
    assert_eq!(done["pantryAdded"], 1);
    assert_eq!(done["undo"]["kind"], "bought");
    assert!(lines(&done["list"])[0]["boughtAt"].is_string());
    let items = f.rows(PANTRY);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["source"], "bought");
    assert_eq!(items[0]["name"], "Flour");
    assert_eq!(f.rows(UNDO)[0]["before_state"]["lineIds"][0], id);
    // The same lines cannot be bought twice.
    assert_eq!(f.refused("meals.list.bought", json!({})).1, "Tick the lines you bought first");
    assert_eq!(f.rows(PANTRY).len(), 1);
    // A bought line keeps its tick, because ticks only change open lines.
    f.ok("meals.list.edit", json!({"action":"untick","lineId":id}));
    assert!(f.rows(ITEMS)[0]["checked_at"].is_string());
}

#[test]
fn clearing_a_list_removes_only_its_lines() {
    let f = Fake::new();
    planned(&f);
    let built = f.ok("meals.list.build", json!({"planId":PLAN}));
    f.ok("meals.pantry.edit", json!({"action":"add","name":"Rice","quantity":1,"unit":"kg"}));
    f.ok("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Salt"}));
    f.ok("meals.list.edit", json!({"action":"add","name":"Soap"}));
    let before = |table: &str| f.rows(table);
    let (plans, days, meals, recipes, ingredients) = (
        before("app.meals_plans"), before("app.meals_plan_days"), before("app.meals_planned_meals"),
        before("app.meals_recipes"), before("app.meals_recipe_ingredients"),
    );
    let (pantry, staples, undo, kitchens, heads) =
        (before(PANTRY), before(STAPLES), before(UNDO), before("app.meals_kitchens"), before(LISTS));
    let items = f.rows(ITEMS);
    assert!(!items.is_empty());
    let mut cleared = f.ok("meals.list.clear", json!({"listId":built["listId"]}));
    assert_eq!(cleared.as_object_mut().unwrap().remove("changed").unwrap(), json!([
        {"label":"Shopping item","before":json!(items).to_string(),"after":"[]"}
    ]));
    assert_eq!(cleared, json!({"cleared":true}));
    assert!(f.rows(ITEMS).is_empty());
    assert_eq!(f.rows(LISTS), heads);
    assert_eq!(f.rows("app.meals_plans"), plans);
    assert_eq!(f.rows("app.meals_plan_days"), days);
    assert_eq!(f.rows("app.meals_planned_meals"), meals);
    assert_eq!(f.rows("app.meals_recipes"), recipes);
    assert_eq!(f.rows("app.meals_recipe_ingredients"), ingredients);
    assert_eq!(f.rows(PANTRY), pantry);
    assert_eq!(f.rows(STAPLES), staples);
    assert_eq!(f.rows(UNDO), undo);
    assert_eq!(f.rows("app.meals_kitchens"), kitchens);
}

#[test]
fn pantry_items_and_staples_edit_with_the_old_rules() {
    let f = Fake::new();
    let added = f.ok("meals.pantry.edit", json!({"action":"add","name":"Rice","quantity":2,"unit":"Kilograms"}));
    let item = added["pantry"]["items"][0].clone();
    assert_eq!(item["unit"], "kg");
    assert_eq!(item["source"], "manual");
    let id = item["itemId"].as_str().unwrap();
    let changed = f.ok("meals.pantry.edit", json!({"action":"update","itemId":id,"quantity":null}));
    assert!(changed["pantry"]["items"][0]["quantity"].is_null());
    assert_eq!(f.refused("meals.pantry.edit", json!({"action":"add","name":"x","quantity":-1})).1, "quantity must be a number above 0, or null for no amount");
    let gone = f.ok("meals.pantry.edit", json!({"action":"remove","itemId":id}));
    assert_eq!(gone["undo"]["kind"], "removed");
    assert_eq!(f.rows(UNDO)[0]["before_state"]["item"]["name"], "Rice");
    assert_eq!(f.refused("meals.pantry.edit", json!({"action":"remove","itemId":id})).1, "There is no Pantry item with that id");
    let salt = f.ok("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Salt"}));
    f.ok("meals.pantry.edit", json!({"target":"staple","action":"add","name":"salt"}));
    assert_eq!(f.rows(STAPLES).len(), 1);
    let salt_id = salt["pantry"]["staples"][0]["stapleId"].as_str().unwrap();
    let pepper = f.ok("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Pepper"}));
    let pepper_id = pepper["pantry"]["staples"].as_array().unwrap().iter().find(|s| s["name"] == "Pepper").unwrap()["stapleId"].as_str().unwrap().to_owned();
    assert_eq!(f.refused("meals.pantry.edit", json!({"target":"staple","action":"update","stapleId":pepper_id,"name":"SALT"})).1, "That Staple is already on the list");
    f.ok("meals.pantry.edit", json!({"target":"staple","action":"update","stapleId":salt_id,"name":"Sea salt"}));
    f.ok("meals.pantry.edit", json!({"target":"staple","action":"remove","stapleId":salt_id}));
    assert_eq!(f.refused("meals.pantry.edit", json!({"target":"staple","action":"remove","stapleId":salt_id})).1, "There is no Staple with that id");
}

#[test]
fn one_person_never_sees_or_changes_another_persons_list() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Secret snack"}));
    let id = lines(&added["list"])[0]["lineId"].as_str().unwrap().to_owned();
    f.ok("meals.pantry.edit", json!({"action":"add","name":"Secret rice"}));
    f.as_actor(B);
    assert_eq!(lines(&f.ok("meals.list.get", json!({}))).len(), 0);
    assert_eq!(f.ok("meals.pantry.get", json!({}))["items"].as_array().unwrap().len(), 0);
    assert_eq!(f.refused("meals.list.edit", json!({"action":"remove","lineId":id})).1, "There is no shopping list line with that id");
    f.ok("meals.list.edit", json!({"action":"tick","lineId":id}));
    f.as_actor(A);
    assert!(lines(&f.ok("meals.list.get", json!({})))[0]["checkedAt"].is_null());
}
