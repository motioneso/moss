mod common;
use common::{Fake, A, B};
use moss_meals_module::md5::uuid_of;
use serde_json::{json, Value};

const PLAN: &str = "00000000-0000-4000-8000-00000000f001";
const DAY: &str = "00000000-0000-4000-8000-00000000f002";
const DAY2: &str = "00000000-0000-4000-8000-00000000f012";
const MEAL: &str = "00000000-0000-4000-8000-00000000f003";
const RECIPE: &str = "00000000-0000-4000-8000-00000000f004";
const KITCHEN: &str = "00000000-0000-4000-8000-00000000f005";
const MEALS: &str = "app.meals_planned_meals";
const EATERS: &str = "app.meals_planned_meal_eaters";

fn me(actor: &str) -> String {
    uuid_of(&format!("meals.self:{actor}"))
}

/// A ready dinner on two days for one person. The fake clock is in the middle of 2026-11-07.
fn dinner(f: &Fake, actor: &'static str, ids: [&str; 5]) {
    let [plan, day, meal, recipe, kitchen] = ids;
    f.as_actor(actor);
    f.ok("meals.kitchen.get", json!({}));
    f.seed("app.meals_plans", actor, json!({"plan_id":plan,"kitchen_id":kitchen,"start_date":"2026-11-09","pantry_mode":"ignore","state":"active","allow_repeats":false,"request_text":null}));
    f.seed("app.meals_plan_days", actor, json!({"day_id":day,"plan_id":plan,"day_date":"2026-11-09","status":"ready","generation":1,"cook_time_limit_minutes":null,"sharing_overrides":{}}));
    f.seed(MEALS, actor, json!({"kitchen_id":kitchen,"meal_id":meal,"day_id":day,"slot_position":0,"slot_name":"dinner","kind":"recipe","sharing":"shared","status":"ready","recipe_id":recipe,"servings_override":null,"cooked_at":null,"locked":false,"job_generation":0,"generation":1,"attempts":0,"one_off_for":null,"favourite_of":null,"plain_text":null,"failure_reason":null,"quick_max_minutes":null}));
    f.seed(EATERS, actor, json!({"kitchen_id":kitchen,"meal_id":meal,"member_id":me(actor),"portion":1,"estimated_kcal":null,"safety":"pass","safety_reason":null}));
    f.seed("app.meals_recipes", actor, json!({"recipe_id":recipe,"kitchen_id":kitchen,"title":"Rice and eggs","title_key":"rice and eggs","base_servings":2,"cook_minutes":30,"kcal_per_serving":null,"steps":["Cook it"]}));
    f.seed("app.meals_recipe_ingredients", actor, json!({"recipe_id":recipe,"position":0,"original_text":"rice","name":"rice","quantity":200,"unit":"g","store_section":"pantry","check_label":false}));
}

fn mine(f: &Fake) {
    dinner(f, A, [PLAN, DAY, MEAL, RECIPE, KITCHEN]);
}

fn meal_row(f: &Fake, id: &str) -> Value {
    f.rows(MEALS).into_iter().find(|m| m["meal_id"] == id).expect("meal row")
}

#[test]
fn a_meal_reads_as_a_recipe_and_only_for_its_owner() {
    let f = Fake::new();
    mine(&f);
    let got = f.ok("meals.meal.get", json!({"mealId":MEAL}));
    assert_eq!(got["meal"]["title"], "Rice and eggs");
    assert_eq!(got["recipeId"], RECIPE);
    f.as_actor(B);
    assert_eq!(f.refused("meals.meal.get", json!({"mealId":MEAL})).1, "No meal with that id");
}

#[test]
fn servings_change_in_halves_and_clear_with_null() {
    let f = Fake::new();
    mine(&f);
    assert_eq!(f.ok("meals.meal.servings", json!({"mealId":MEAL,"servings":3}))["servingsOverride"], 3);
    assert_eq!(meal_row(&f, MEAL)["servings_override"], 3);
    f.refused("meals.meal.servings", json!({"mealId":MEAL,"servings":2.3}));
    f.refused("meals.meal.servings", json!({"mealId":MEAL,"servings":25}));
    f.ok("meals.meal.servings", json!({"mealId":MEAL,"servings":null}));
    assert!(meal_row(&f, MEAL)["servings_override"].is_null());
    f.as_actor(B);
    f.refused("meals.meal.servings", json!({"mealId":MEAL,"servings":4}));
    f.as_actor(A);
    assert!(meal_row(&f, MEAL)["servings_override"].is_null());
}

#[test]
fn a_meal_locks_unlocks_and_moves_to_another_day() {
    let f = Fake::new();
    mine(&f);
    f.seed("app.meals_plan_days", A, json!({"day_id":DAY2,"plan_id":PLAN,"day_date":"2026-11-10","status":"ready","generation":1,"cook_time_limit_minutes":null,"sharing_overrides":{}}));
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"lock"}));
    assert_eq!(meal_row(&f, MEAL)["locked"], true);
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"unlock"}));
    assert_eq!(meal_row(&f, MEAL)["locked"], false);
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"move","targetDayId":DAY2}));
    assert_eq!(meal_row(&f, MEAL)["day_id"], DAY2);
    f.as_actor(B);
    f.refused("meals.meal.edit", json!({"mealId":MEAL,"action":"lock"}));
    f.as_actor(A);
    assert_eq!(meal_row(&f, MEAL)["locked"], false);
}

#[test]
fn a_day_turns_a_slot_into_text_and_back_and_takes_a_cook_limit() {
    let f = Fake::new();
    mine(&f);
    f.ok("meals.day.edit", json!({"action":"set_text","mealId":MEAL,"text":"Eating out"}));
    let row = meal_row(&f, MEAL);
    assert_eq!((row["kind"].as_str(), row["plain_text"].as_str()), (Some("text"), Some("Eating out")));
    f.ok("meals.day.edit", json!({"action":"clear_text","mealId":MEAL}));
    assert_eq!(meal_row(&f, MEAL)["kind"], "recipe");
    f.ok("meals.day.edit", json!({"action":"set_cook_limit","dayId":DAY,"minutes":45}));
    let day = f.rows("app.meals_plan_days")[0].clone();
    assert_eq!(day["cook_time_limit_minutes"], 45);
    f.refused("meals.day.edit", json!({"action":"set_cook_limit","dayId":DAY,"minutes":2}));
}

#[test]
fn deleting_a_plan_removes_it_and_never_touches_another_persons_plan() {
    let f = Fake::new();
    mine(&f);
    let b_plan = "00000000-0000-4000-8000-00000000e001";
    dinner(&f, B, [b_plan, "00000000-0000-4000-8000-00000000e002", "00000000-0000-4000-8000-00000000e003", "00000000-0000-4000-8000-00000000e004", "00000000-0000-4000-8000-00000000e005"]);
    f.as_actor(A);
    assert_eq!(f.refused("meals.plan.delete", json!({"planId":b_plan})).1, "No plan with that id");
    assert_eq!(f.rows("app.meals_plans").len(), 2);
    assert_eq!(f.ok("meals.plan.delete", json!({"planId":PLAN}))["deleted"], true);
    assert_eq!(f.rows("app.meals_plans").len(), 1);
    assert_eq!(f.rows("app.meals_plans")[0]["plan_id"], b_plan);
}

#[test]
fn replan_resets_only_meals_still_to_come_and_raises_an_ignore_plan_to_prefer() {
    let f = Fake::new();
    mine(&f);
    let past = "00000000-0000-4000-8000-00000000f022";
    let past_meal = "00000000-0000-4000-8000-00000000f023";
    f.seed("app.meals_plan_days", A, json!({"day_id":past,"plan_id":PLAN,"day_date":"2026-11-01","status":"ready","generation":1,"cook_time_limit_minutes":null,"sharing_overrides":{}}));
    f.seed(MEALS, A, json!({"meal_id":past_meal,"day_id":past,"slot_position":0,"slot_name":"dinner","kind":"recipe","sharing":"shared","status":"ready","recipe_id":RECIPE,"servings_override":null,"cooked_at":null,"locked":false,"job_generation":0,"generation":1,"attempts":0,"one_off_for":null,"favourite_of":null,"plain_text":null,"failure_reason":null,"quick_max_minutes":null}));
    f.ok("meals.plan.control", json!({"planId":PLAN,"action":"replan"}));
    assert_eq!(meal_row(&f, MEAL)["status"], "pending");
    assert_eq!(meal_row(&f, past_meal)["status"], "ready");
    assert_eq!(f.rows("app.meals_plans")[0]["pantry_mode"], "prefer");
    assert_eq!(f.queued.borrow().len(), 1);
    // Nothing is left to replace now.
    assert_eq!(f.refused("meals.plan.control", json!({"planId":PLAN,"action":"replan"})).1, "There is nothing to re-plan");
    let bad = f.refused("meals.plan.control", json!({"planId":PLAN,"action":"nope"}));
    assert_eq!(bad.1, "action must be stop, resume, retry_day, regenerate or replan");
}

fn passing(n: usize) -> String {
    let e: Vec<Value> = (1..=n).map(|i| json!({"eater":i,"verdict":"pass","reason":null})).collect();
    json!({"eaters":e}).to_string()
}

/// The model's calorie answer for a whole recipe.
fn estimate(kcal: i64) -> String {
    json!({"outcome":"estimated","items":[{"label":"Recipe","portionNote":null,"caloriesKcal":kcal,"proteinG":10,
        "carbohydratesG":20,"fatG":5,"fiberG":2,"sugarG":3,"sodiumMg":null}],"missingDetails":null,
        "clarificationQuestion":null}).to_string()
}

fn recipe(title: &str) -> String {
    json!({"title":title,"cookMinutes":20,"baseServings":2,"steps":["Cook"],
      "ingredients":[{"originalText":"lentils","name":"lentils","quantity":1,"unit":null,"section":"pantry","checkLabel":false}]})
    .to_string()
}

#[test]
fn favourites_add_remove_and_place_with_a_safety_check() {
    let f = Fake::new();
    mine(&f);
    let other = "00000000-0000-4000-8000-00000000f104";
    f.seed("app.meals_recipes", A, json!({"recipe_id":other,"kitchen_id":KITCHEN,"title":"Lentil soup","title_key":"lentil soup","base_servings":2,"cook_minutes":20,"kcal_per_serving":400,"steps":["Cook"]}));
    f.seed("app.meals_recipe_ingredients", A, json!({"recipe_id":other,"position":0,"original_text":"lentils","name":"lentils","quantity":1,"unit":null,"store_section":"pantry","check_label":false}));
    let who = me(A);
    f.ok("meals.favourites.edit", json!({"action":"add","memberId":who,"recipeId":other}));
    assert_eq!(f.rows("app.meals_favourites").len(), 1);
    f.model.borrow_mut().push_back(Ok(passing(1)));
    let placed = f.ok("meals.favourites.edit", json!({"action":"place","memberId":who,"recipeId":other,"mealId":MEAL}));
    assert_eq!(placed["meal"]["meal"]["title"], "Lentil soup");
    assert_eq!(meal_row(&f, MEAL)["recipe_id"], other);
    assert_eq!(meal_row(&f, MEAL)["favourite_of"], who.as_str());
    assert_eq!(f.rows(EATERS)[0]["estimated_kcal"], 400);
    f.ok("meals.favourites.edit", json!({"action":"remove","memberId":who,"recipeId":other}));
    assert!(f.rows("app.meals_favourites").is_empty());
    assert_eq!(
        f.refused("meals.favourites.edit", json!({"action":"place","memberId":who,"recipeId":other,"mealId":MEAL})).1,
        "That recipe is not one of this person's favourites"
    );
}

#[test]
fn placing_a_favourite_is_refused_for_a_locked_meal_and_when_the_check_cannot_run() {
    let f = Fake::new();
    mine(&f);
    let who = me(A);
    f.ok("meals.favourites.edit", json!({"action":"add","memberId":who,"recipeId":RECIPE}));
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"lock"}));
    let locked = f.refused("meals.favourites.edit", json!({"action":"place","memberId":who,"recipeId":RECIPE,"mealId":MEAL}));
    assert_eq!(locked.1, "That meal is locked. Unlock it to place a favourite");
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"unlock"}));
    let down = f.refused("meals.favourites.edit", json!({"action":"place","memberId":who,"recipeId":RECIPE,"mealId":MEAL}));
    assert_eq!(down.1, "The Safety check could not run, so nothing was placed");
}

fn run_job(f: &Fake, queue: &str, params: Value) -> String {
    let payload = json!({"queue":queue,"parameters":params}).to_string();
    moss_meals_module::handle(f, "job", &payload).expect("job runs")
}

#[test]
fn swap_choices_queue_a_job_with_ids_only_and_the_job_fills_three_choices() {
    let f = Fake::new();
    mine(&f);
    let shown = f.ok("meals.meal.swap", json!({"mealId":MEAL,"action":"request_choices"}));
    assert_eq!(shown["swapChoices"].as_array().unwrap().len(), 3);
    let queued = f.queued.borrow().clone();
    assert_eq!(queued.len(), 1);
    let (queue, params, _) = &queued[0];
    assert_eq!(queue, "meals-meal-job");
    let mut keys: Vec<&String> = params.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["generation", "meal-id", "mode"]);
    for title in ["Lentil soup", "Bean chili", "Veg curry"] {
        f.model.borrow_mut().push_back(Ok(recipe(title)));
        f.model.borrow_mut().push_back(Ok(passing(1)));
        f.model.borrow_mut().push_back(Ok(estimate(400)));
    }
    run_job(&f, queue, params.clone());
    let again = f.ok("meals.meal.get", json!({"mealId":MEAL}));
    let ready: Vec<&Value> = again["swapChoices"].as_array().unwrap().iter().filter(|c| c["status"] == "ready").collect();
    assert_eq!(ready.len(), 3);
    // The recipe makes two servings, so 400 kcal for the whole recipe is 200 for each.
    let saved: Vec<Value> = f.rows("app.meals_recipes").into_iter().filter(|r| r["recipe_id"] != RECIPE).collect();
    assert!(saved.iter().all(|r| r["kcal_per_serving"] == 200), "{saved:?}");
    let choice = ready[0]["choiceId"].as_str().unwrap().to_owned();
    f.ok("meals.meal.swap", json!({"mealId":MEAL,"action":"choose","choiceId":choice}));
    assert_ne!(meal_row(&f, MEAL)["recipe_id"], RECIPE);
}

#[test]
fn a_stale_swap_job_saves_nothing() {
    let f = Fake::new();
    mine(&f);
    f.ok("meals.meal.swap", json!({"mealId":MEAL,"action":"request_choices"}));
    let (queue, params, _) = f.queued.borrow()[0].clone();
    // A newer request bumps the generation, so the first job no longer owns the meal.
    f.ok("meals.meal.swap", json!({"mealId":MEAL,"action":"request_choices"}));
    let recipes_before = f.rows("app.meals_recipes").len();
    run_job(&f, &queue, params);
    assert_eq!(f.rows("app.meals_recipes").len(), recipes_before);
}

#[test]
fn the_account_export_and_delete_cover_every_table_for_the_caller_only() {
    let f = Fake::new();
    mine(&f);
    let b_ids = ["00000000-0000-4000-8000-00000000e001", "00000000-0000-4000-8000-00000000e002", "00000000-0000-4000-8000-00000000e003", "00000000-0000-4000-8000-00000000e004", "00000000-0000-4000-8000-00000000e005"];
    dinner(&f, B, b_ids);
    f.as_actor(A);
    let call = |name: &str| -> Value {
        let payload = json!({"name":name,"parameters":{}}).to_string();
        serde_json::from_str(&moss_meals_module::handle(&f, "api", &payload).expect("api")).unwrap()
    };
    let export = call("collectMealsExportSection");
    assert_eq!(export["plans"].as_array().unwrap().len(), 1);
    assert_eq!(export["plans"][0]["plan_id"], PLAN);
    assert_eq!(export["planned_meals"][0]["meal_id"], MEAL);
    let deleted = call("deleteMealsAccountData");
    assert!(deleted["deleted"].as_i64().unwrap() >= 5);
    assert_eq!(call("collectMealsExportSection")["plans"].as_array().unwrap().len(), 0);
    f.as_actor(B);
    assert_eq!(f.rows("app.meals_plans").len(), 1);
    assert_eq!(f.rows(MEALS).iter().filter(|m| m["owner_user_id"] == B).count(), 1);
    assert_eq!(f.rows("app.meals_recipes").iter().filter(|m| m["owner_user_id"] == B).count(), 1);
}

fn add_member(f: &Fake, name: &str) -> String {
    let saved = f.ok("meals.household.save", json!({"name":name}));
    saved["members"].as_array().unwrap_or(&vec![]).iter().find(|m| m["name"] == name).map(|m| m["memberId"].as_str().unwrap().to_owned())
        .or_else(|| saved["memberId"].as_str().map(str::to_owned))
        .expect("the new member")
}

fn eaters_of(f: &Fake, meal: &str) -> Vec<Value> {
    f.rows(EATERS).into_iter().filter(|e| e["meal_id"] == meal).collect()
}

#[test]
fn changing_eaters_sets_safety_to_pending_and_the_recheck_job_settles_it() {
    let f = Fake::new();
    mine(&f);
    let sam = add_member(&f, "Sam");
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":[me(A), sam]}));
    let rows = eaters_of(&f, MEAL);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|e| e["safety"] == "pending"));
    let (queue, params, _) = f.queued.borrow().last().cloned().unwrap();
    assert_eq!(params["mode"], "safety-recheck");
    f.model.borrow_mut().push_back(Ok(passing(2)));
    run_job(&f, &queue, params);
    assert!(eaters_of(&f, MEAL).iter().all(|e| e["safety"] == "pass"));
    // Dropping a person removes only that person.
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":[sam]}));
    assert_eq!(eaters_of(&f, MEAL).len(), 1);
    f.refused("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":["00000000-0000-4000-8000-0000000000ff"]}));
}

#[test]
fn a_safety_recheck_queued_before_a_newer_change_saves_nothing() {
    let f = Fake::new();
    mine(&f);
    let sam = add_member(&f, "Sam");
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":[me(A), sam]}));
    let (queue, old, _) = f.queued.borrow().last().cloned().unwrap();
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":[me(A), sam]}));
    f.model.borrow_mut().push_back(Ok(passing(2)));
    run_job(&f, &queue, old);
    assert!(eaters_of(&f, MEAL).iter().all(|e| e["safety"] == "pending"));
}

#[test]
fn a_quick_swap_replaces_the_recipe_inside_the_time_limit() {
    let f = Fake::new();
    mine(&f);
    f.ok("meals.meal.swap", json!({"mealId":MEAL,"action":"quick","maxMinutes":30}));
    assert_eq!(meal_row(&f, MEAL)["quick_max_minutes"], 30);
    let (queue, params, _) = f.queued.borrow().last().cloned().unwrap();
    assert_eq!(params["mode"], "quick-swap");
    f.model.borrow_mut().push_back(Ok(recipe("Lentil soup")));
    f.model.borrow_mut().push_back(Ok(passing(1)));
    f.model.borrow_mut().push_back(Ok(estimate(400)));
    run_job(&f, &queue, params);
    let row = meal_row(&f, MEAL);
    assert_ne!(row["recipe_id"], RECIPE);
    assert_eq!(row["status"], "ready");
    f.refused("meals.meal.swap", json!({"mealId":MEAL,"action":"quick","maxMinutes":3}));
}

#[test]
fn a_solo_slot_splits_into_one_meal_per_eater_and_a_shared_slot_joins_them_again() {
    let f = Fake::new();
    mine(&f);
    let sam = add_member(&f, "Sam");
    f.ok("meals.meal.edit", json!({"mealId":MEAL,"action":"set_eaters","eaterIds":[me(A), sam]}));
    f.ok("meals.day.edit", json!({"action":"set_sharing","dayId":DAY,"slotName":"dinner","sharing":"solo"}));
    let dinners: Vec<Value> = f.rows(MEALS).into_iter().filter(|m| m["day_id"] == DAY).collect();
    assert_eq!(dinners.len(), 2);
    assert!(dinners.iter().all(|m| eaters_of(&f, m["meal_id"].as_str().unwrap()).len() == 1));
    f.ok("meals.day.edit", json!({"action":"set_sharing","dayId":DAY,"slotName":"dinner","sharing":"shared"}));
    let joined: Vec<Value> = f.rows(MEALS).into_iter().filter(|m| m["day_id"] == DAY).collect();
    assert_eq!(joined.len(), 1);
    assert_eq!(eaters_of(&f, joined[0]["meal_id"].as_str().unwrap()).len(), 2);
}
