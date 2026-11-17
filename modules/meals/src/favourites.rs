//! The favourites tool. Add and remove mark a recipe for one person. Place puts a favourite
//! into an unlocked, uncooked meal after a Safety check for everyone who eats it.
use crate::arrange::recipe_screen;
use crate::draft::check_safety;
use crate::input::{self, invalid, Checked, Fields};
use crate::jobs::AiModel;
use crate::safety::Verdict;
use crate::store::{self, text, EATERS, MEALS};
use crate::{kitchen, shopping, swap, view};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const NO_MEAL: &str = "No meal with that id";
const LOCKED: &str = "That meal is locked. Unlock it to place a favourite";
const NOT_RUN: &str = "The Safety check could not run, so nothing was placed";

fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

pub fn edit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        input::no_unknown_keys(input, &["action", "memberId", "recipeId", "mealId"])?;
        let action = input::choice(input, "action", &["add", "remove", "place"])?;
        let Some(action) = action else {
            return invalid("action must be add, remove or place");
        };
        let member = input::uuid(input, "memberId", true)?.unwrap_or_default();
        let recipe = input::uuid(input, "recipeId", true)?.unwrap_or_default();
        Ok((action, member, recipe))
    })();
    let (action, member, recipe_id) = match parsed {
        Ok(p) => p,
        Err(e) => return Ok(Err(e)),
    };
    let kitchen_id = kitchen::ensure(host)?;
    let kitchen_view = kitchen::view(host)?;
    let people = view::members_by_id(&kitchen_view);
    if !people.contains_key(&member) {
        return Ok(invalid("There is no household member with that id"));
    }
    let Some(recipe) = store::get_recipes(host, &[recipe_id.clone()])?.into_iter().next() else {
        return Ok(invalid("There is no recipe with that id"));
    };
    let client = Client(host);
    let pair = and(vec![
        Filter::eq("member_id", member.as_str()),
        Filter::eq("recipe_id", recipe_id.as_str()),
    ]);
    if action != "place" {
        if action == "add" {
            store::insert_ignore(
                host,
                kitchen::FAVOURITES,
                vec![
                    ("kitchen_id", json!(kitchen_id)),
                    ("member_id", json!(member)),
                    ("recipe_id", json!(recipe_id)),
                ],
            )?;
        } else {
            client.query(kitchen::FAVOURITES, &Query::delete(pair))?;
        }
        return Ok(Ok(json!({"kitchen": kitchen::view(host)?, "meal": Value::Null})));
    }
    let meal_id = match input::uuid(input, "mealId", true) {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => return Ok(Err(e)),
    };
    if store::find(host, kitchen::FAVOURITES, pair)?.is_none() {
        return Ok(invalid("That recipe is not one of this person's favourites"));
    }
    let Some(meal) = store::get_meal(host, &meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    if meal["locked"] == true {
        return Ok(invalid(LOCKED));
    }
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("That meal is already cooked"));
    }
    let eaters = meal["eaters"].as_array().cloned().unwrap_or_default();
    if !eaters.iter().any(|e| e["member_id"] == member.as_str()) {
        return Ok(invalid("That person does not eat this meal"));
    }
    let restrictions: Vec<Vec<String>> = eaters
        .iter()
        .map(|e| {
            e["member_id"]
                .as_str()
                .and_then(|id| people.get(id))
                .map(|m| {
                    m["restrictions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let Ok(verdicts) = check_safety(&mut AiModel(host), &swap::draft_of(&recipe), &restrictions) else {
        return Ok(invalid(NOT_RUN));
    };
    for (i, verdict) in verdicts.iter().enumerate() {
        if let Verdict::Fail(reason) = verdict {
            let name = eaters[i]["member_id"]
                .as_str()
                .and_then(|id| people.get(id))
                .and_then(|m| m["name"].as_str())
                .unwrap_or("Someone");
            return Ok(invalid(format!("Not placed. {name}: {reason}")));
        }
    }
    // The meal flips last, under the lock guard, so a concurrent lock keeps the old recipe.
    let kcal = recipe["kcal_per_serving"].as_f64();
    let placed = store::update(
        host,
        MEALS,
        and(vec![Filter::eq("meal_id", meal_id.as_str()), Filter::eq("locked", false)]),
        vec![
            ("recipe_id", json!(recipe_id)),
            ("kind", json!("recipe")),
            ("status", json!("ready")),
            ("failure_reason", Value::Null),
            ("plain_text", Value::Null),
            ("favourite_of", json!(member)),
            ("servings_override", Value::Null),
            ("cooked_at", Value::Null),
        ],
    )?;
    if !placed {
        return Ok(invalid(LOCKED));
    }
    for eater in &eaters {
        let portion = store::num(&eater["portion"]).unwrap_or(1.0);
        store::update(
            host,
            EATERS,
            and(vec![
                Filter::eq("meal_id", meal_id.as_str()),
                Filter::eq("member_id", text(eater, "member_id").as_str()),
            ]),
            vec![
                ("safety", json!("pass")),
                ("safety_reason", Value::Null),
                ("estimated_kcal", kcal.map_or(Value::Null, |k| json!((k * portion).round() as i64))),
            ],
        )?;
    }
    if let Some(plan_id) = crate::arrange::plan_of_day(host, &text(&meal, "day_id"))? {
        shopping::on_plan_change(host, &plan_id)?;
    }
    let screen = match recipe_screen(host, &meal_id)? {
        Ok(v) => v,
        Err(e) => return Ok(Err(e)),
    };
    Ok(Ok(json!({"kitchen": kitchen::view(host)?, "meal": screen})))
}
