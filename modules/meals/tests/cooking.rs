mod common;
use common::{Fake, A, B};
use moss_meals_module::md5::uuid_of;
use serde_json::{json, Value};

const PLAN: &str = "00000000-0000-4000-8000-00000000f001";
const DAY: &str = "00000000-0000-4000-8000-00000000f002";
const MEAL: &str = "00000000-0000-4000-8000-00000000f003";
const RECIPE: &str = "00000000-0000-4000-8000-00000000f004";
const KITCHEN: &str = "00000000-0000-4000-8000-00000000f005";
const MEALS: &str = "app.meals_planned_meals";
const PANTRY: &str = "app.meals_pantry_items";
const UNDO: &str = "app.meals_undo_actions";
const RATINGS: &str = "app.meals_ratings";
const ITEMS: &str = "app.meals_shopping_list_items";
const ITEM_RICE: &str = "00000000-0000-4000-8000-00000000f101";
const ITEM_MILK: &str = "00000000-0000-4000-8000-00000000f102";
const ITEM_SALT: &str = "00000000-0000-4000-8000-00000000f103";
const ITEM_EGG: &str = "00000000-0000-4000-8000-00000000f104";

fn me() -> String {
    uuid_of(&format!("meals.self:{A}"))
}

/// A ready dinner for the signed-in person. The recipe serves 2 and needs 2 cups of milk,
/// 3 eggs, 200 g of rice and some salt.
fn dinner(f: &Fake) {
    f.ok("meals.kitchen.get", json!({}));
    f.ok("meals.kitchen.save", json!({"unitsSystem":"us"}));
    f.seed("app.meals_plans", A, json!({"plan_id":PLAN,"kitchen_id":KITCHEN,"start_date":"2026-11-09","pantry_mode":"prefer","state":"active"}));
    f.seed("app.meals_plan_days", A, json!({"day_id":DAY,"plan_id":PLAN,"day_date":"2026-11-09","status":"ready"}));
    f.seed(MEALS, A, json!({"meal_id":MEAL,"day_id":DAY,"slot_position":0,"slot_name":"dinner","kind":"recipe","status":"ready","recipe_id":RECIPE,"servings_override":null,"cooked_at":null}));
    f.seed("app.meals_planned_meal_eaters", A, json!({"meal_id":MEAL,"member_id":me(),"portion":1}));
    f.seed("app.meals_recipes", A, json!({"recipe_id":RECIPE,"title":"Rice and eggs","base_servings":2,"steps":["Cook it"]}));
    let lines = [("milk", Some(2), Some("cup")), ("egg", Some(3), None), ("rice", Some(200), Some("g")), ("salt", Some(1), Some("tsp"))];
    for (i, (name, q, unit)) in lines.iter().enumerate() {
        f.seed("app.meals_recipe_ingredients", A, json!({"recipe_id":RECIPE,"position":i,"original_text":name,"name":name,"quantity":q,"unit":unit,"store_section":"pantry","check_label":false}));
    }
}

fn stock(f: &Fake) {
    f.seed(PANTRY, A, json!({"kitchen_id":KITCHEN,"item_id":ITEM_RICE,"name":"Rice","name_key":"rice","quantity":1,"unit":"kg"}));
    f.seed(PANTRY, A, json!({"kitchen_id":KITCHEN,"item_id":ITEM_MILK,"name":"Milk","name_key":"milk","quantity":1,"unit":"cup"}));
    f.seed(PANTRY, A, json!({"kitchen_id":KITCHEN,"item_id":ITEM_SALT,"name":"Salt","name_key":"salt","quantity":null}));
    f.seed(PANTRY, A, json!({"kitchen_id":KITCHEN,"item_id":ITEM_EGG,"name":"Eggs","name_key":"eggs","quantity":2}));
}

/// A restored row keeps its fields but takes new change times.
fn without_times(mut rows: Vec<Value>) -> Vec<Value> {
    for row in &mut rows {
        row["updated_at"] = Value::Null;
        row["created_at"] = Value::Null;
    }
    rows
}

fn quantity(f: &Fake, id: &str) -> Value {
    f.rows(PANTRY).into_iter().find(|r| r["item_id"] == id).unwrap()["quantity"].clone()
}

#[test]
fn cooking_takes_the_scaled_amounts_out_of_the_pantry_and_never_below_zero() {
    let f = Fake::new();
    dinner(&f);
    stock(&f);
    let done = f.ok("meals.meal.cooked", json!({"mealId":MEAL}));
    // One serving of a two-serving recipe: half of each line.
    assert_eq!(quantity(&f, ITEM_RICE), json!(0.9));
    assert_eq!(quantity(&f, ITEM_MILK), json!(0));
    assert_eq!(quantity(&f, ITEM_EGG), json!(0.5));
    assert!(quantity(&f, ITEM_SALT).is_null());
    let changes = done["pantryChanges"].as_array().unwrap();
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[0], json!({"name":"Milk","before":1,"after":0,"unit":"cup"}));
    assert_eq!(changes[1], json!({"name":"Eggs","before":2,"after":0.5,"unit":null}));
    assert_eq!(done["undo"]["kind"], "cooked");
    assert_eq!(done["undo"]["count"], 3);
    assert_eq!(done["logOffer"], json!({"description":"Rice and eggs","servingNote":"1 serving"}));
    assert!(done["meal"]["cookedAt"].is_string());
    assert_eq!(f.rows(UNDO).len(), 1);
    let again = f.refused("meals.meal.cooked", json!({"mealId":MEAL}));
    assert_eq!(again.1, "That meal is already marked cooked");
    assert_eq!(f.rows(UNDO).len(), 1);
}

#[test]
fn staples_and_lines_with_no_amount_are_left_alone() {
    let f = Fake::new();
    dinner(&f);
    stock(&f);
    f.ok("meals.pantry.edit", json!({"target":"staple","action":"add","name":"Eggs"}));
    let done = f.ok("meals.meal.cooked", json!({"mealId":MEAL}));
    assert_eq!(quantity(&f, ITEM_EGG), json!(2));
    let names: Vec<&str> = done["pantryChanges"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Milk", "Rice"]);
}

#[test]
fn cooking_is_refused_for_a_missing_meal_or_one_with_no_recipe() {
    let f = Fake::new();
    dinner(&f);
    assert_eq!(f.refused("meals.meal.cooked", json!({"mealId":RECIPE})).1, "There is no meal with that id");
    assert_eq!(f.refused("meals.meal.cooked", json!({})).1, "mealId is required");
    assert_eq!(f.refused("meals.meal.cooked", json!({"mealId":MEAL,"x":1})).1, "unknown key: x");
    f.seed(MEALS, A, json!({"meal_id":RECIPE,"day_id":DAY,"slot_position":1,"slot_name":"lunch","kind":"recipe","status":"pending","recipe_id":null}));
    assert_eq!(f.refused("meals.meal.cooked", json!({"mealId":RECIPE})).1, "That meal has no recipe yet");
}

#[test]
fn undoing_a_cooked_meal_puts_back_the_meal_and_the_pantry() {
    let f = Fake::new();
    dinner(&f);
    stock(&f);
    let before = f.rows(PANTRY);
    let done = f.ok("meals.meal.cooked", json!({"mealId":MEAL}));
    let action = done["undo"]["actionId"].clone();
    let undone = f.ok("meals.undo", json!({"actionId":action}));
    assert_eq!(undone, json!({"restored":3,"skipped":0}));
    let quantities = |rows: Vec<Value>| rows.iter().map(|r| r["quantity"].clone()).collect::<Vec<_>>();
    assert_eq!(quantities(f.rows(PANTRY)), quantities(before));
    assert!(f.rows(MEALS).iter().find(|m| m["meal_id"] == MEAL).unwrap()["cooked_at"].is_null());
    assert!(f.rows(UNDO)[0]["undone_at"].is_string());
    assert_eq!(f.refused("meals.undo", json!({"actionId":action})).1, "There is nothing to undo");
    // The meal can be cooked again.
    f.ok("meals.meal.cooked", json!({"mealId":MEAL}));
}

#[test]
fn undoing_a_bought_list_removes_the_pantry_row_and_reopens_the_line() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Flour","quantity":1,"unit":"kg"}));
    let id = added["list"]["lines"][0]["lineId"].as_str().unwrap().to_owned();
    f.ok("meals.list.edit", json!({"action":"tick","lineId":id}));
    let bought = f.ok("meals.list.bought", json!({}));
    assert_eq!(f.rows(PANTRY).len(), 1);
    let undone = f.ok("meals.undo", json!({"actionId":bought["undo"]["actionId"]}));
    assert_eq!(undone, json!({"restored":1,"skipped":0}));
    assert!(f.rows(PANTRY).is_empty());
    assert!(f.rows(ITEMS)[0]["bought_at"].is_null());
}

#[test]
fn undoing_a_removed_line_or_pantry_item_brings_it_back_once() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Bread","quantity":2}));
    let id = added["list"]["lines"][0]["lineId"].as_str().unwrap().to_owned();
    let before = f.rows(ITEMS);
    let removed = f.ok("meals.list.edit", json!({"action":"remove","lineId":id}));
    assert!(f.rows(ITEMS).is_empty());
    let undone = f.ok("meals.undo", json!({"actionId":removed["undo"]["actionId"]}));
    assert_eq!(undone, json!({"restored":1,"skipped":0}));
    assert_eq!(without_times(f.rows(ITEMS)), without_times(before));

    let item = f.ok("meals.pantry.edit", json!({"action":"add","name":"Rice","quantity":2,"unit":"kg"}));
    let item_id = item["pantry"]["items"][0]["itemId"].as_str().unwrap().to_owned();
    let pantry_before = f.rows(PANTRY);
    let gone = f.ok("meals.pantry.edit", json!({"action":"remove","itemId":item_id}));
    assert!(f.rows(PANTRY).is_empty());
    let back = f.ok("meals.undo", json!({"actionId":gone["undo"]["actionId"]}));
    assert_eq!(back, json!({"restored":1,"skipped":0}));
    assert_eq!(without_times(f.rows(PANTRY)), without_times(pantry_before));
}

#[test]
fn undo_refuses_unknown_records_and_other_peoples_records() {
    let f = Fake::new();
    let added = f.ok("meals.list.edit", json!({"action":"add","name":"Bread"}));
    let id = added["list"]["lines"][0]["lineId"].as_str().unwrap().to_owned();
    let removed = f.ok("meals.list.edit", json!({"action":"remove","lineId":id}));
    let action = removed["undo"]["actionId"].clone();
    assert_eq!(f.refused("meals.undo", json!({"actionId":RECIPE})).1, "There is nothing to undo");
    assert_eq!(f.refused("meals.undo", json!({})).1, "actionId is required");
    f.as_actor(B);
    assert_eq!(f.refused("meals.undo", json!({"actionId":action})).1, "There is nothing to undo");
    f.as_actor(A);
    f.ok("meals.undo", json!({"actionId":action}));
}

#[test]
fn ratings_set_replace_and_clear_and_show_on_the_meal() {
    let f = Fake::new();
    dinner(&f);
    let rate = |stars: Value| f.ok("meals.meal.rate", json!({"mealId":MEAL,"ratings":[{"memberId":me(),"stars":stars}]}));
    let seen = rate(json!(4));
    assert_eq!(seen["meal"]["eaters"][0]["rating"], 4);
    assert_eq!(seen["recipeId"], RECIPE);
    assert_eq!(seen["baseServings"], 2);
    assert_eq!(seen["ingredients"][0]["display"], "1 cup");
    assert_eq!(rate(json!(2))["meal"]["eaters"][0]["rating"], 2);
    assert_eq!(f.rows(RATINGS).len(), 1);
    assert!(rate(Value::Null)["meal"]["eaters"][0]["rating"].is_null());
    assert!(f.rows(RATINGS).is_empty());
}

#[test]
fn rating_inputs_are_checked_before_anything_is_written() {
    let f = Fake::new();
    dinner(&f);
    let refuse = |input: Value| f.refused("meals.meal.rate", input).1;
    let stars = "stars must be a whole number from 1 to 5, or null to clear";
    assert_eq!(refuse(json!({"mealId":MEAL})), "ratings must list 1 to 20 people with their stars");
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[]})), "ratings must list 1 to 20 people with their stars");
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[{"memberId":me(),"stars":6}]})), stars);
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[{"memberId":me(),"stars":2.5}]})), stars);
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[{"memberId":me()}]})), stars);
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[{"memberId":RECIPE,"stars":3}]})), "There is no household member with that id");
    assert_eq!(refuse(json!({"mealId":MEAL,"ratings":[{"memberId":me(),"stars":3},{"memberId":RECIPE,"stars":3}]})), "There is no household member with that id");
    assert!(f.rows(RATINGS).is_empty());
    assert_eq!(refuse(json!({"mealId":RECIPE,"ratings":[{"memberId":me(),"stars":3}]})), "There is no meal with that id");
}
