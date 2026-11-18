//! Swap choices, quick swaps and Safety re-checks. The tools set a meal up and queue a job;
//! the job writes the recipes. A job carries the meal id, a generation and a mode. Every save
//! is guarded by that generation, so a job that runs after a newer request saves nothing.
use crate::arrange::{ne, recipe_screen};
use crate::draft::{check_safety, draft_safe_recipe, Ask, Outcome, Person};
use crate::input::{self, invalid, Checked, Fields};
use crate::jobs::{read_pantry, verdict_row, AiModel};
use crate::pantry::Input as PantryInput;
use crate::recipe::{Draft, Ingredient};
use crate::rules::{add_days, portion_for, title_key};
use crate::safety::Verdict;
use crate::store::{self, num, text, EaterRow, NewRecipe, EATERS, MEALS, SWAP_CHOICES};
use crate::util::{new_id, number};
use crate::{cooking, estimate, kitchen, md5, shopping, view};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MEAL_JOB_QUEUE: &str = "meals-meal-job";
const SWAP_CHOICE_COUNT: i64 = 3;
const NO_REPEAT_DAYS: i64 = 7;
const MAX_KCAL_PER_SERVING: f64 = 5000.0;

fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

fn in_status(statuses: &[&str]) -> Filter {
    Filter::In {
        column: "status".into(),
        values: statuses.iter().map(|s| json!(s)).collect(),
    }
}

fn uncooked() -> Filter {
    Filter::Null {
        column: "cooked_at".into(),
        not: false,
    }
}

// ---- job generation and queueing ----

fn job_key(meal_id: &str, mode: &str, generation: i64) -> String {
    md5::uuid_of(&format!("meals.meal-job:{meal_id}:{mode}:g{generation}"))
}

/// Raises the meal's job generation, guarded by the one it read, and returns the new number.
/// A quick swap also stores its time cap in the same write.
fn start_meal_job<H: Host + ?Sized>(host: &H, meal_id: &str, quick_max: Option<i64>) -> Result<Option<i64>> {
    for _ in 0..5 {
        let Some(meal) = store::find(host, MEALS, Filter::eq("meal_id", meal_id))? else {
            return Ok(None);
        };
        let current = meal["job_generation"].as_i64().unwrap_or(0);
        let mut set = vec![("job_generation", json!(current + 1))];
        if let Some(minutes) = quick_max {
            set.push(("quick_max_minutes", json!(minutes)));
        }
        let guard = and(vec![
            Filter::eq("meal_id", meal_id),
            Filter::eq("job_generation", current),
        ]);
        if store::update(host, MEALS, guard, set)? {
            return Ok(Some(current + 1));
        }
    }
    Err(Error::new("Meal job generation kept changing"))
}

/// Queues a meal job. False when the queue refuses it.
fn enqueue<H: Host + ?Sized>(host: &H, meal_id: &str, mode: &str, generation: i64) -> Result<bool> {
    Ok(host
        .call(
            "jobs",
            "enqueue-options",
            MEAL_JOB_QUEUE,
            json!({
                "params": {"meal-id": meal_id, "generation": generation, "mode": mode},
                "idempotencyKey": job_key(meal_id, mode, generation),
                "availableAt": crate::util::context(host)?.1
            }),
        )
        .is_ok())
}

/// Queues a Safety re-run for a meal whose eaters or recipe changed.
pub fn enqueue_safety_recheck<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<()> {
    let Some(generation) = start_meal_job(host, meal_id, None)? else {
        return Ok(());
    };
    enqueue(host, meal_id, "safety-recheck", generation)?;
    Ok(())
}

// ---- meal.edit set_eaters and sharing merge ----

fn eater_ids(input: &Fields) -> Checked<Vec<String>> {
    let msg = "eaterIds must name at least one person";
    let Some(items) = input.get("eaterIds").and_then(Value::as_array).filter(|a| !a.is_empty() && a.len() <= 40) else {
        return invalid(msg);
    };
    let mut ids: Vec<String> = vec![];
    for item in items {
        let Some(id) = item.as_str() else { return invalid(msg) };
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

/// Replaces who eats a written meal. Each new eater starts with Safety pending, and the
/// re-check job fills in the verdicts. Eaters who stay keep their row.
pub fn set_eaters<H: Host + ?Sized>(host: &H, meal: &Value, plan_id: &str, input: &Fields) -> Result<Checked<()>> {
    let Some(recipe_id) = meal["recipe_id"].as_str().filter(|_| meal["kind"] == "recipe") else {
        return Ok(invalid("Only a recipe meal has eaters to change"));
    };
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("A cooked meal's eaters cannot change"));
    }
    if !matches!(meal["status"].as_str(), Some("ready" | "failed")) {
        return Ok(invalid("Wait for this meal to finish writing before changing its eaters"));
    }
    let ids = match eater_ids(input) {
        Ok(ids) => ids,
        Err(e) => return Ok(Err(e)),
    };
    let kitchen_view = kitchen::view(host)?;
    let members = view::members_by_id(&kitchen_view);
    if ids.iter().any(|id| !members.contains_key(id)) {
        return Ok(invalid("That person is not in the household"));
    }
    let Some(recipe) = store::get_recipes(host, &[recipe_id.to_owned()])?.into_iter().next() else {
        return Ok(invalid("That meal has no recipe yet"));
    };
    let meal_id = text(meal, "meal_id");
    let slot = text(meal, "slot_name");
    let kcal = recipe["kcal_per_serving"].as_f64();
    let guard = and(vec![
        Filter::eq("meal_id", meal_id.as_str()),
        Filter::eq("kind", "recipe"),
        uncooked(),
        in_status(&["ready", "failed"]),
    ]);
    if !store::update(host, MEALS, guard, vec![("servings_override", Value::Null)])? {
        return Ok(invalid("That meal's eaters cannot change"));
    }
    let kitchen_id = text(meal, "kitchen_id");
    for id in &ids {
        let portion = portion_for(members.get(id).and_then(|m| view::share_kcal(m, &slot)), kcal);
        store::insert_ignore(
            host,
            EATERS,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("meal_id", json!(meal_id)),
                ("member_id", json!(id)),
            ],
        )?;
        store::write_eaters(
            host,
            &meal_id,
            &[EaterRow {
                member_id: id.clone(),
                portion,
                estimated_kcal: kcal.map(|k| (k * portion).round() as i64),
                safety: "pending".into(),
                safety_reason: None,
            }],
        )?;
    }
    for old in meal["eaters"].as_array().into_iter().flatten() {
        let member = text(old, "member_id");
        if !ids.contains(&member) {
            Client(host).query(
                EATERS,
                &Query::delete(and(vec![
                    Filter::eq("meal_id", meal_id.as_str()),
                    Filter::eq("member_id", member.as_str()),
                ])),
            )?;
        }
    }
    enqueue_safety_recheck(host, &meal_id)?;
    shopping::on_plan_change(host, plan_id)?;
    Ok(Ok(()))
}

/// Joins the ordinary meals of a slot into the first one. A One-off meal is one person's own
/// dinner and stays. Every verdict goes back to pending because the kept meal has a different
/// recipe from the ones those verdicts judged, and Safety runs again for it.
pub fn merge_slot<H: Host + ?Sized>(host: &H, _day_id: &str, meals: &[Value]) -> Result<Checked<()>> {
    let mergeable: Vec<&Value> = meals.iter().filter(|m| m["one_off_for"].is_null()).collect();
    let Some(keeper) = mergeable.first() else {
        return Ok(Ok(()));
    };
    if mergeable.len() < 2 {
        return Ok(Ok(()));
    }
    let keeper_id = text(keeper, "meal_id");
    let kitchen_id = text(keeper, "kitchen_id");
    let mut union: Vec<&Value> = vec![];
    for meal in &mergeable {
        for eater in meal["eaters"].as_array().into_iter().flatten() {
            if !union.iter().any(|e| e["member_id"] == eater["member_id"]) {
                union.push(eater);
            }
        }
    }
    let guard = and(vec![
        Filter::eq("meal_id", keeper_id.as_str()),
        ne("status", "writing"),
        uncooked(),
    ]);
    if !store::update(host, MEALS, guard, vec![("sharing", json!("shared")), ("servings_override", Value::Null)])? {
        return Ok(invalid("That slot's sharing cannot change"));
    }
    for eater in &union {
        let rows = [EaterRow {
            member_id: text(eater, "member_id"),
            portion: num(&eater["portion"]).unwrap_or(1.0),
            estimated_kcal: eater["estimated_kcal"].as_i64(),
            safety: "pending".into(),
            safety_reason: None,
        }];
        store::insert_ignore(
            host,
            EATERS,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("meal_id", json!(keeper_id)),
                ("member_id", json!(rows[0].member_id)),
            ],
        )?;
        store::write_eaters(host, &keeper_id, &rows)?;
    }
    for meal in mergeable.iter().skip(1) {
        Client(host).query(MEALS, &Query::delete(Filter::eq("meal_id", text(meal, "meal_id"))))?;
    }
    enqueue_safety_recheck(host, &keeper_id)?;
    Ok(Ok(()))
}

// ---- meal.swap ----

fn require_swappable(meal: &Value) -> Checked<()> {
    if meal["kind"] != "recipe" {
        return invalid("Only a recipe meal can be swapped");
    }
    if !meal["cooked_at"].is_null() {
        return invalid("A cooked meal cannot be swapped");
    }
    if !matches!(meal["status"].as_str(), Some("ready" | "failed")) {
        return invalid("Wait for this meal to finish writing before swapping it");
    }
    Ok(())
}

fn fail_choice<H: Host + ?Sized>(host: &H, choice_id: &str, generation: i64) -> Result<bool> {
    store::update(
        host,
        SWAP_CHOICES,
        and(vec![
            Filter::eq("choice_id", choice_id),
            Filter::eq("generation", generation),
            Filter::In {
                column: "status".into(),
                values: vec![json!("pending"), json!("writing")],
            },
        ]),
        vec![("status", json!("failed"))],
    )
}

fn request_choices<H: Host + ?Sized>(host: &H, meal: &Value, plan_id: &str) -> Result<Checked<()>> {
    let meal_id = text(meal, "meal_id");
    let Some(plan) = store::get_plan(host, plan_id)? else {
        return Ok(invalid("No plan with that id"));
    };
    let Some(generation) = start_meal_job(host, &meal_id, None)? else {
        return Ok(invalid("No meal with that id"));
    };
    Client(host).query(SWAP_CHOICES, &Query::delete(Filter::eq("meal_id", meal_id.as_str())))?;
    let mut ids = vec![];
    for position in 1..=SWAP_CHOICE_COUNT {
        let choice_id = new_id(host)?;
        store::insert_ignore(
            host,
            SWAP_CHOICES,
            vec![
                ("kitchen_id", json!(text(&plan, "kitchen_id"))),
                ("meal_id", json!(meal_id)),
                ("choice_id", json!(choice_id)),
                ("position", json!(position)),
                ("generation", json!(generation)),
            ],
        )?;
        ids.push(choice_id);
    }
    if !enqueue(host, &meal_id, "swap-choices", generation)? {
        for id in &ids {
            fail_choice(host, id, generation)?;
        }
        return Ok(invalid("Swapping is paused. Try again later."));
    }
    Ok(Ok(()))
}

fn choose<H: Host + ?Sized>(host: &H, meal: &Value, plan_id: &str, choice_id: &str) -> Result<Checked<()>> {
    let meal_id = text(meal, "meal_id");
    let not_ready = || invalid("That choice is not ready");
    let choices = store::list_swap_choices(host, &meal_id)?;
    let Some(choice) = choices.iter().find(|c| c["choice_id"] == choice_id) else {
        return Ok(not_ready());
    };
    let Some(recipe_id) = choice["recipe_id"].as_str().filter(|_| choice["status"] == "ready") else {
        return Ok(not_ready());
    };
    let Some(recipe) = store::get_recipes(host, &[recipe_id.to_owned()])?.into_iter().next() else {
        return Ok(not_ready());
    };
    let kitchen_view = kitchen::view(host)?;
    let rows: Vec<EaterRow> = view::choice_eaters(meal, &recipe, &view::members_by_id(&kitchen_view))
        .iter()
        .map(|e| EaterRow {
            member_id: text(e, "member_id"),
            portion: num(&e["portion"]).unwrap_or(1.0),
            estimated_kcal: e["estimated_kcal"].as_i64(),
            safety: "pass".into(),
            safety_reason: None,
        })
        .collect();
    let guard = and(vec![
        Filter::eq("meal_id", meal_id.as_str()),
        Filter::eq("kind", "recipe"),
        uncooked(),
        in_status(&["ready", "failed"]),
    ]);
    let set = vec![
        ("recipe_id", json!(recipe_id)),
        ("status", json!("ready")),
        ("failure_reason", Value::Null),
        ("attempts", json!(0)),
    ];
    if !store::update(host, MEALS, guard, set)? {
        return Ok(invalid("That choice can no longer be used"));
    }
    store::write_eaters(host, &meal_id, &rows)?;
    Client(host).query(SWAP_CHOICES, &Query::delete(Filter::eq("meal_id", meal_id.as_str())))?;
    shopping::on_plan_change(host, plan_id)?;
    Ok(Ok(()))
}

fn quick<H: Host + ?Sized>(host: &H, meal_id: &str, input: &Fields) -> Result<Checked<()>> {
    let Some(minutes) = input.get("maxMinutes").and_then(Value::as_i64).filter(|m| (5..=240).contains(m)) else {
        return Ok(invalid("maxMinutes must be a whole number from 5 to 240"));
    };
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(invalid("No meal with that id"));
    };
    if let Err(e) = require_swappable(&meal) {
        return Ok(Err(e));
    }
    let Some(generation) = start_meal_job(host, meal_id, Some(minutes))? else {
        return Ok(invalid("No meal with that id"));
    };
    if !enqueue(host, meal_id, "quick-swap", generation)? {
        return Ok(invalid("Quick swapping is paused. Try again later."));
    }
    Ok(Ok(()))
}

pub fn meal_swap<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let meal_id = match input::text(input, "mealId", true, 64) {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => return Ok(Err(e)),
    };
    let action = input.get("action").and_then(Value::as_str).unwrap_or_default();
    if !["request_choices", "choose", "quick"].contains(&action) {
        return Ok(invalid("action must be request_choices, choose or quick"));
    }
    let done = if action == "quick" {
        quick(host, &meal_id, input)?
    } else {
        let Some(meal) = store::get_meal(host, &meal_id)? else {
            return Ok(invalid("No meal with that id"));
        };
        if let Err(e) = require_swappable(&meal) {
            return Ok(Err(e));
        }
        let plan_id = store::get_day(host, &text(&meal, "day_id"))?.map(|d| text(&d, "plan_id")).unwrap_or_default();
        if action == "request_choices" {
            request_choices(host, &meal, &plan_id)?
        } else {
            match input::text(input, "choiceId", true, 64) {
                Ok(choice) => choose(host, &meal, &plan_id, &choice.unwrap_or_default())?,
                Err(e) => Err(e),
            }
        }
    };
    if let Err(e) = done {
        return Ok(Err(e));
    }
    recipe_screen(host, &meal_id)
}

// ---- the job ----

#[derive(Debug, PartialEq)]
pub enum MealJobOutcome {
    Stale,
    Missing,
    Done,
}

pub(crate) fn draft_of(recipe: &Value) -> Draft {
    Draft {
        title: text(recipe, "title"),
        steps: recipe["steps"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect(),
        cook_minutes: recipe["cook_minutes"].as_i64().unwrap_or(0),
        base_servings: num(&recipe["base_servings"]).unwrap_or(1.0),
        ingredients: recipe["ingredients"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|i| Ingredient {
                original_text: text(i, "original_text"),
                name: text(i, "name"),
                quantity: num(&i["quantity"]),
                unit: i["unit"].as_str().map(str::to_owned),
                section: text(i, "store_section"),
                check_label: i["check_label"] == true,
            })
            .collect(),
    }
}

/// Calories per serving of a written recipe, through the meal estimator. None when the
/// estimate fails or is out of range, so calorie fit reads as unknown rather than wrong.
pub(crate) fn kcal_per_serving<H: Host + ?Sized>(host: &H, draft: &Draft) -> Option<i64> {
    let lines: Vec<&str> = draft.ingredients.iter().map(|i| i.original_text.as_str()).collect();
    let description = format!("{}. Ingredients: {}", draft.title, lines.join("; "));
    let note = format!("The whole recipe, which makes {} servings", number(draft.base_servings));
    let estimate::Outcome::Estimated { totals, .. } = estimate::estimate(&mut AiModel(host), &description, Some(&note)) else {
        return None;
    };
    let per = (totals[0]? / draft.base_servings).round();
    (0.0..=MAX_KCAL_PER_SERVING).contains(&per).then_some(per as i64)
}

fn new_recipe<H: Host + ?Sized>(host: &H, draft: &Draft, key: &str, kcal: Option<i64>) -> Result<NewRecipe> {
    Ok(NewRecipe {
        recipe_id: new_id(host)?,
        title: draft.title.clone(),
        title_key: key.to_owned(),
        steps: draft.steps.clone(),
        cook_minutes: draft.cook_minutes,
        base_servings: draft.base_servings,
        kcal_per_serving: kcal,
        ingredients: draft.ingredients.clone(),
    })
}

/// The one-star rule the day job applies. A dish that anyone eating this meal rated one star
/// is not offered, unless the plan's own request names it.
pub(crate) fn vetoes<H: Host + ?Sized>(host: &H, meal: &Value, plan: &Value) -> Result<Vec<(String, String)>> {
    let eaters: Vec<&str> = meal["eaters"].as_array().into_iter().flatten().filter_map(|e| e["member_id"].as_str()).collect();
    let rated = store::select(host, cooking::RATINGS, Query::select(Filter::eq("stars", 1)))?;
    let ids: Vec<String> = rated
        .iter()
        .filter(|r| eaters.contains(&r["member_id"].as_str().unwrap_or_default()))
        .filter_map(|r| r["recipe_id"].as_str().map(str::to_owned))
        .collect();
    let asked = format!(" {} ", title_key(plan["request_text"].as_str().unwrap_or_default()));
    Ok(store::get_recipes(host, &ids)?
        .iter()
        .map(|r| (text(r, "title"), text(r, "title_key")))
        .filter(|(_, key)| key.is_empty() || !asked.contains(&format!(" {key} ")))
        .collect())
}

struct Work {
    plan: Value,
    day: Value,
    kitchen: Value,
    people: Vec<Option<Person>>,
    vetoed: HashSet<String>,
    avoid: Vec<(String, String)>,
}

fn person_of(member: &Value, slot: &str) -> Person {
    let list = |key: &str| -> Vec<String> {
        member[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    };
    Person {
        restrictions: list("restrictions"),
        preferences: list("preferences"),
        share_kcal: view::share_kcal(member, slot),
    }
}

fn prepare<H: Host + ?Sized>(host: &H, meal: &Value) -> Result<Option<Work>> {
    let day = store::get_day(host, &text(meal, "day_id"))?;
    let plan = match &day {
        Some(d) => store::get_plan(host, &text(d, "plan_id"))?,
        None => None,
    };
    let (Some(day), Some(plan)) = (day, plan) else {
        return Ok(None);
    };
    let kitchen_view = kitchen::view(host)?;
    let slot = text(meal, "slot_name");
    let members = view::members_by_id(&kitchen_view);
    let people = meal["eaters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| e["member_id"].as_str().and_then(|id| members.get(id)).map(|m| person_of(m, &slot)))
        .collect();
    let veto_list = vetoes(host, meal, &plan)?;
    let date = text(&day, "day_date");
    let recent = if plan["allow_repeats"] == true {
        vec![]
    } else {
        store::recent_titles(host, &add_days(&date, -NO_REPEAT_DAYS).unwrap_or(date.clone()), &date)?
    };
    let current = match meal["recipe_id"].as_str() {
        Some(id) => store::get_recipes(host, &[id.to_owned()])?
            .iter()
            .map(|r| (text(r, "title"), text(r, "title_key")))
            .collect(),
        None => vec![],
    };
    let vetoed = veto_list.iter().map(|v| v.1.clone()).collect();
    let avoid = recent.into_iter().chain(current).chain(veto_list).collect();
    drop(members);
    Ok(Some(Work { plan, day, kitchen: kitchen_view, people, vetoed, avoid }))
}

fn pantry_for<H: Host + ?Sized>(host: &H, mode: &str) -> Result<Option<PantryInput>> {
    if mode == "ignore" {
        return Ok(None);
    }
    Ok(Some(read_pantry(host, mode)?))
}

fn draft_for<H: Host + ?Sized>(
    host: &H,
    work: &Work,
    meal: &Value,
    cap: Option<i64>,
    pantry: Option<&PantryInput>,
    avoid_titles: &[String],
    recent_keys: &HashSet<String>,
) -> Outcome {
    let slot = text(meal, "slot_name");
    let date = text(&work.day, "day_date");
    let ask = Ask {
        slot_name: &slot,
        date: &date,
        people: &work.people,
        cook_time_limit: cap,
        request_text: work.plan["request_text"].as_str(),
        avoid_titles,
        recent_keys,
        vetoed_keys: &work.vetoed,
        allow_repeats: work.plan["allow_repeats"] == true,
        metric: work.kitchen["unitsSystem"] == "metric",
        pantry,
    };
    draft_safe_recipe(&mut AiModel(host), &ask)
}

fn swap_choices<H: Host + ?Sized>(host: &H, meal_id: &str, generation: i64) -> Result<MealJobOutcome> {
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(MealJobOutcome::Missing);
    };
    let Some(work) = prepare(host, &meal)? else {
        return Ok(MealJobOutcome::Missing);
    };
    let choices = store::list_swap_choices(host, meal_id)?;
    if !choices.iter().any(|c| c["generation"].as_i64() == Some(generation)) {
        return Ok(MealJobOutcome::Stale);
    }
    let mut avoid_titles: Vec<String> = work.avoid.iter().map(|a| a.0.clone()).collect();
    let mut recent_keys: HashSet<String> = work.avoid.iter().map(|a| a.1.clone()).collect();
    let mode = text(&work.plan, "pantry_mode");
    let pantry = pantry_for(host, &mode)?;
    let kitchen_id = text(&work.plan, "kitchen_id");
    for choice in choices.iter().filter(|c| c["generation"].as_i64() == Some(generation)) {
        let choice_id = text(choice, "choice_id");
        let claimed = store::update(
            host,
            SWAP_CHOICES,
            and(vec![
                Filter::eq("choice_id", choice_id.as_str()),
                Filter::eq("generation", generation),
                Filter::eq("status", "pending"),
            ]),
            vec![("status", json!("writing"))],
        )?;
        if !claimed {
            continue;
        }
        let cap = work.day["cook_time_limit_minutes"].as_i64();
        let Outcome::Ready { draft, key, .. } =
            draft_for(host, &work, &meal, cap, pantry.as_ref(), &avoid_titles, &recent_keys)
        else {
            fail_choice(host, &choice_id, generation)?;
            continue;
        };
        let recipe = new_recipe(host, &draft, &key, kcal_per_serving(host, &draft))?;
        store::store_recipe(host, &kitchen_id, &recipe)?;
        let saved = store::update(
            host,
            SWAP_CHOICES,
            and(vec![
                Filter::eq("choice_id", choice_id.as_str()),
                Filter::eq("generation", generation),
                Filter::eq("status", "writing"),
            ]),
            vec![("status", json!("ready")), ("recipe_id", json!(recipe.recipe_id))],
        )?;
        if !saved {
            Client(host).query(store::RECIPES, &Query::delete(Filter::eq("recipe_id", recipe.recipe_id.as_str())))?;
            return Ok(MealJobOutcome::Stale);
        }
        avoid_titles.push(draft.title);
        recent_keys.insert(key);
    }
    Ok(MealJobOutcome::Done)
}

fn safety_recheck<H: Host + ?Sized>(host: &H, meal_id: &str, generation: i64) -> Result<MealJobOutcome> {
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(MealJobOutcome::Missing);
    };
    let Some(recipe_id) = meal["recipe_id"].as_str().map(str::to_owned) else {
        return Ok(MealJobOutcome::Missing);
    };
    let Some(recipe) = store::get_recipes(host, &[recipe_id.clone()])?.into_iter().next() else {
        return Ok(MealJobOutcome::Missing);
    };
    let kitchen_view = kitchen::view(host)?;
    let members = view::members_by_id(&kitchen_view);
    let eaters = meal["eaters"].as_array().cloned().unwrap_or_default();
    let restrictions: Vec<Vec<String>> = eaters
        .iter()
        .map(|e| {
            e["member_id"]
                .as_str()
                .and_then(|id| members.get(id))
                .map(|m| m["restrictions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default()
        })
        .collect();
    let verdicts: Vec<Verdict> = check_safety(&mut AiModel(host), &draft_of(&recipe), &restrictions)
        .map_err(|reason| Error::new(format!("meal-job: safety check failed ({reason})")))?;
    let rows: Vec<EaterRow> = eaters.iter().enumerate().map(|(i, e)| verdict_row(e, verdicts.get(i))).collect();
    // A re-check queued before a newer job, or before the recipe was replaced, must not
    // overwrite newer verdicts. Touching the meal under both guards is the check.
    let current = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id),
            Filter::eq("job_generation", generation),
            Filter::eq("recipe_id", recipe_id.as_str()),
        ]),
        vec![],
    )?;
    if !current {
        return Ok(MealJobOutcome::Stale);
    }
    store::write_eaters(host, meal_id, &rows)?;
    Ok(MealJobOutcome::Done)
}

fn quick_swap<H: Host + ?Sized>(host: &H, meal_id: &str, generation: i64) -> Result<MealJobOutcome> {
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(MealJobOutcome::Missing);
    };
    let Some(max) = meal["quick_max_minutes"].as_i64() else {
        return Err(Error::new("meal-job: quick_swap has no time cap"));
    };
    let claimed = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id),
            Filter::eq("job_generation", generation),
            Filter::eq("kind", "recipe"),
            uncooked(),
            in_status(&["ready", "failed"]),
        ]),
        vec![("status", json!("writing")), ("failure_reason", Value::Null)],
    )?;
    if !claimed {
        return Ok(MealJobOutcome::Stale);
    }
    let Some(work) = prepare(host, &meal)? else {
        return Ok(MealJobOutcome::Missing);
    };
    let cap = work.day["cook_time_limit_minutes"].as_i64().map_or(max, |d| d.min(max));
    // The Pantry is read in prefer mode even when the plan ignores it.
    let pantry = read_pantry(host, "prefer")?;
    let avoid_titles: Vec<String> = work.avoid.iter().map(|a| a.0.clone()).collect();
    let recent_keys: HashSet<String> = work.avoid.iter().map(|a| a.1.clone()).collect();
    let eaters = meal["eaters"].as_array().cloned().unwrap_or_default();
    let guard = and(vec![
        Filter::eq("meal_id", meal_id),
        Filter::eq("job_generation", generation),
        Filter::eq("status", "writing"),
    ]);
    match draft_for(host, &work, &meal, Some(cap), Some(&pantry), &avoid_titles, &recent_keys) {
        Outcome::Failed { reason, attempts, verdicts } => {
            let rows: Option<Vec<EaterRow>> =
                verdicts.map(|v| eaters.iter().enumerate().map(|(i, e)| verdict_row(e, v.get(i))).collect());
            let failed = store::update(
                host,
                MEALS,
                guard,
                vec![("status", json!("failed")), ("failure_reason", json!(reason)), ("attempts", json!(attempts))],
            )?;
            if let (true, Some(rows)) = (failed, rows) {
                store::write_eaters(host, meal_id, &rows)?;
            }
            Ok(MealJobOutcome::Done)
        }
        Outcome::Ready { draft, key, verdicts, attempts } => {
            let kcal = kcal_per_serving(host, &draft);
            let recipe = new_recipe(host, &draft, &key, kcal)?;
            let rows: Vec<EaterRow> = eaters
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let share = work.people.get(i).and_then(Option::as_ref).and_then(|p| p.share_kcal);
                    let portion = portion_for(share, kcal.map(|k| k as f64));
                    EaterRow {
                        portion,
                        estimated_kcal: kcal.map(|k| (k as f64 * portion).round() as i64),
                        ..verdict_row(e, verdicts.get(i))
                    }
                })
                .collect();
            store::store_recipe(host, &text(&work.plan, "kitchen_id"), &recipe)?;
            let saved = store::update(
                host,
                MEALS,
                guard,
                vec![
                    ("status", json!("ready")),
                    ("failure_reason", Value::Null),
                    ("recipe_id", json!(recipe.recipe_id)),
                    ("attempts", json!(attempts)),
                ],
            )?;
            if !saved {
                Client(host).query(store::RECIPES, &Query::delete(Filter::eq("recipe_id", recipe.recipe_id.as_str())))?;
                return Ok(MealJobOutcome::Stale);
            }
            store::write_eaters(host, meal_id, &rows)?;
            shopping::on_plan_change(host, &text(&work.plan, "plan_id"))?;
            Ok(MealJobOutcome::Done)
        }
    }
}

pub fn run_meal_job<H: Host + ?Sized>(host: &H, params: &Value) -> Result<MealJobOutcome> {
    let Some(meal_id) = params["meal-id"].as_str().filter(|s| input::is_uuid(s)) else {
        return Err(Error::new("meal-job: bad meal id"));
    };
    let Some(generation) = params["generation"].as_i64().filter(|g| (1..=100_000).contains(g)) else {
        return Err(Error::new("meal-job: bad generation"));
    };
    match params["mode"].as_str() {
        Some("swap-choices") => swap_choices(host, meal_id, generation),
        Some("quick-swap") => quick_swap(host, meal_id, generation),
        Some("safety-recheck") => safety_recheck(host, meal_id, generation),
        _ => Err(Error::new("meal-job: bad mode")),
    }
}
