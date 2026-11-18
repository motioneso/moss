//! Mark cooked and ratings. Cooking takes what a recipe used out of the Pantry and keeps an undo
//! record of what it changed. The port has no transactions, so the undo record is written first
//! and the meal update is guarded by the state it expects.
use crate::input::{self, invalid, Checked, Fields};
use crate::pantry::{is_staple, names_match, coverage, Coverage, Input as Pantry, Stock};
use crate::shopping::{self, PANTRY_ITEMS, UNDO};
use crate::store::{self, num, text};
use crate::units::{convert, normalise_unit};
use crate::util::{context, jnum, jopt, new_id, values};
use crate::view::{self, mark_key, Marks};
use crate::kitchen;
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

pub const RATINGS: &str = "app.meals_ratings";

const NO_MEAL: &str = "There is no meal with that id";
const NO_RECIPE: &str = "That meal has no recipe yet";

/// Every rating and favourite, for the views.
pub fn read_marks<H: Host + ?Sized>(host: &H) -> Result<Marks> {
    let mut marks = Marks::default();
    for row in store::select(host, RATINGS, Query::select(Filter::All))? {
        if let Some(stars) = row["stars"].as_i64() {
            marks
                .ratings
                .insert(mark_key(&text(&row, "member_id"), &text(&row, "recipe_id")), stars);
        }
    }
    for row in store::select(host, kitchen::FAVOURITES, Query::select(Filter::All))? {
        marks
            .favourites
            .insert(mark_key(&text(&row, "member_id"), &text(&row, "recipe_id")));
    }
    Ok(marks)
}

/// One stored change to a Pantry row.
pub struct Change {
    pub item_id: String,
    pub name: String,
    pub unit: Option<String>,
    pub before: f64,
    pub after: f64,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// What a cooked meal takes out of the Pantry. Staples and lines with no amount are skipped. A
/// row with no amount is left alone, and no row goes below zero.
pub fn subtraction(
    lines: &[Value],
    scale: f64,
    stock: &[Value],
    staples: &Pantry,
) -> Vec<Change> {
    let mut remaining: Vec<(String, Option<f64>)> = stock
        .iter()
        .map(|row| (text(row, "item_id"), num(&row["quantity"])))
        .collect();
    let mut touched: Vec<Change> = vec![];
    for line in lines {
        let name = text(line, "name");
        let Some(quantity) = num(&line["quantity"]) else { continue };
        if is_staple(&name, staples) {
            continue;
        }
        let unit = line["unit"].as_str();
        let target = normalise_unit(unit);
        let mut need = quantity * scale;
        for (at, row) in stock.iter().enumerate() {
            if need <= 1e-9 {
                break;
            }
            let Some(have) = remaining[at].1.filter(|h| *h > 0.0) else { continue };
            if !names_match(&text(row, "name"), &name) {
                continue;
            }
            let row_unit = row["unit"].as_str();
            let from = normalise_unit(row_unit);
            let need_in_row = if from == target {
                Some(need)
            } else if let (Some(f), Some(t)) = (&from, &target) {
                convert(need, t, f)
            } else {
                None
            };
            let Some(need_in_row) = need_in_row else { continue };
            let used = have.min(need_in_row);
            let left = round3(have - used);
            remaining[at].1 = Some(left);
            need -= if from == target {
                used
            } else {
                convert(used, from.as_deref().unwrap_or_default(), target.as_deref().unwrap_or_default())
                    .unwrap_or(0.0)
            };
            let id = text(row, "item_id");
            match touched.iter_mut().find(|c| c.item_id == id) {
                Some(change) => change.after = left,
                None => touched.push(Change {
                    item_id: id,
                    name: text(row, "name"),
                    unit: row_unit.map(str::to_owned),
                    before: have,
                    after: left,
                }),
            }
        }
    }
    touched
}

fn pantry_of(items: &[Value], staples: &[Value]) -> (Vec<Stock>, Pantry) {
    let stock: Vec<Stock> = items
        .iter()
        .map(|i| Stock {
            name: text(i, "name"),
            quantity: num(&i["quantity"]),
            unit: i["unit"].as_str().map(str::to_owned),
        })
        .collect();
    let input = Pantry {
        only: false,
        stock: vec![],
        staples: staples.iter().map(|s| text(s, "name")).collect(),
    };
    (stock, input)
}

fn servings_of(meal: &Value, recipe: &Value) -> f64 {
    let eaten: f64 = meal["eaters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| num(&e["portion"]).unwrap_or(1.0))
        .sum();
    num(&meal["servings_override"])
        .unwrap_or(if eaten > 0.0 { eaten } else { num(&recipe["base_servings"]).unwrap_or(1.0) })
}

fn format_amount(quantity: f64, unit: Option<&str>) -> String {
    let rounded = (quantity * 100.0).round() / 100.0;
    let number = crate::util::number(rounded);
    match unit {
        Some(u) if !u.is_empty() => format!("{number} {u}"),
        _ => number,
    }
}

/// The meal and its recipe, when the meal is a ready recipe meal.
fn recipe_meal<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<Checked<(Value, Value)>> {
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    let Some(recipe_id) = meal["recipe_id"].as_str().filter(|_| meal["kind"] == "recipe" && meal["status"] == "ready")
    else {
        return Ok(invalid(NO_RECIPE));
    };
    let Some(recipe) = store::get_recipes(host, &[recipe_id.to_owned()])?.into_iter().next() else {
        return Ok(invalid(NO_RECIPE));
    };
    Ok(Ok((meal, recipe)))
}

/// The swap choices stored for a meal, shaped for the recipe screen. A choice shows its eaters
/// only once it is ready, because only then has it passed Safety.
fn swap_choice_views<H: Host + ?Sized>(
    host: &H,
    meal: &Value,
    members: &std::collections::HashMap<String, &Value>,
) -> Result<Vec<Value>> {
    let choices = store::list_swap_choices(host, &text(meal, "meal_id"))?;
    let ids: Vec<String> = choices.iter().filter_map(|c| c["recipe_id"].as_str().map(str::to_owned)).collect();
    let recipes = store::get_recipes(host, &ids)?;
    let slot = text(meal, "slot_name");
    let none = Marks::default();
    Ok(choices
        .iter()
        .map(|choice| {
            let recipe = choice["recipe_id"]
                .as_str()
                .and_then(|id| recipes.iter().find(|r| r["recipe_id"] == id));
            let ready = choice["status"] == "ready" && recipe.is_some();
            let eaters: Vec<Value> = match (ready, recipe) {
                (true, Some(recipe)) => view::choice_eaters(meal, recipe, members)
                    .iter()
                    .map(|e| view::eater_view(e, &slot, recipe["recipe_id"].as_str(), members, &none))
                    .collect(),
                _ => vec![],
            };
            json!({
                "choiceId": choice["choice_id"],
                "status": choice["status"],
                "title": recipe.map_or(Value::Null, |r| r["title"].clone()),
                "cookMinutes": recipe.map_or(Value::Null, |r| r["cook_minutes"].clone()),
                "eaters": eaters,
            })
        })
        .collect())
}

/// The recipe screen for a meal: the meal, scaled ingredients and which ones to buy. A text
/// slot or an unwritten meal has no recipe, so its ingredients and steps are empty.
pub fn recipe_view<H: Host + ?Sized>(host: &H, meal: &Value, recipe: Option<&Value>) -> Result<Value> {
    let kitchen = kitchen::view(host)?;
    let members = view::members_by_id(&kitchen);
    let marks = read_marks(host)?;
    let meal_json = view::meal_view(meal, recipe, &members, &marks);
    let base = recipe.map_or(Value::Null, |r| jopt(num(&r["base_servings"])));
    let base_n = base.as_f64().unwrap_or(1.0);
    let scale = if recipe.is_some() { meal_json["servings"].as_f64().unwrap_or(base_n) / base_n } else { 1.0 };
    let choices = swap_choice_views(host, meal, &members)?;
    let recipe_owned = recipe.cloned().unwrap_or(Value::Null);
    let recipe = &recipe_owned;
    let (items, staples) = shopping::read_pantry(host)?;
    let (stock, input) = pantry_of(&items, &staples);
    let lines = recipe["ingredients"].as_array().cloned().unwrap_or_default();
    let mut missing: Vec<String> = vec![];
    for line in &lines {
        let name = text(line, "name");
        if is_staple(&name, &input) {
            continue;
        }
        if coverage(&name, num(&line["quantity"]), line["unit"].as_str(), &stock) == Coverage::Covered {
            continue;
        }
        if !missing.contains(&name) {
            missing.push(name);
        }
    }
    let ingredients: Vec<Value> = lines
        .iter()
        .map(|line| {
            let quantity = num(&line["quantity"]);
            json!({
                "originalText": line["original_text"],
                "name": line["name"],
                "quantity": jopt(quantity),
                "unit": line["unit"],
                "display": quantity.map_or(Value::Null, |q| json!(format_amount(q * scale, line["unit"].as_str()))),
                "section": line["store_section"],
                "checkLabel": line["check_label"] == true,
                "missing": missing.contains(&text(line, "name")),
            })
        })
        .collect();
    Ok(json!({
        "meal": meal_json,
        "recipeId": recipe["recipe_id"],
        "baseServings": base,
        "servingsOverride": jopt(num(&meal["servings_override"])),
        "steps": if recipe.is_null() { json!([]) } else { recipe["steps"].clone() },
        "ingredients": ingredients,
        "swapChoices": choices,
    }))
}

fn reload_view<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<Value> {
    match recipe_meal(host, meal_id)? {
        Ok((meal, recipe)) => recipe_view(host, &meal, Some(&recipe)),
        Err(_) => Ok(Value::Null),
    }
}

/// A cooked meal keeps its status, so it still reads as a ready recipe meal.
pub fn cooked<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let meal_id = match (|| {
        input::no_unknown_keys(input, &["mealId"])?;
        Ok(input::uuid(input, "mealId", true)?.unwrap_or_default())
    })() {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    let (meal, recipe) = match recipe_meal(host, &meal_id)? {
        Ok(found) => found,
        Err(e) => return Ok(Err(e)),
    };
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("That meal is already marked cooked"));
    }
    let (items, staples) = shopping::read_pantry(host)?;
    let kitchen_id = kitchen::ensure(host)?;
    let base = num(&recipe["base_servings"]).unwrap_or(1.0);
    let scale = servings_of(&meal, &recipe) / base;
    let (_, staple_input) = pantry_of(&items, &staples);
    let lines = recipe["ingredients"].as_array().cloned().unwrap_or_default();
    let changes = subtraction(&lines, scale, &items, &staple_input);
    let (_, at) = context(host)?;
    let action_id = new_id(host)?;
    let record: Vec<Value> = changes
        .iter()
        .map(|c| {
            json!({
                "itemId": c.item_id,
                "name": c.name,
                "unit": c.unit,
                "before": jnum(c.before),
                "after": jnum(c.after),
            })
        })
        .collect();
    store::insert_ignore(
        host,
        UNDO,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("action_id", json!(action_id)),
            ("kind", json!("cooked")),
            ("before_state", json!({"mealId": meal_id, "at": at, "changes": record})),
        ],
    )?;
    let claimed = !Client(host)
        .query(
            store::MEALS,
            &Query::update(
                Filter::And {
                    filters: vec![
                        Filter::eq("meal_id", meal_id.as_str()),
                        Filter::eq("status", "ready"),
                        Filter::Null { column: "cooked_at".into(), not: false },
                    ],
                },
                values(vec![("cooked_at", json!(at)), ("updated_at", json!(at))]),
            ),
        )?
        .is_empty();
    if !claimed {
        Client(host).query(UNDO, &Query::delete(Filter::eq("action_id", action_id.as_str())))?;
        return Ok(invalid("That meal is already marked cooked"));
    }
    for change in &changes {
        Client(host).query(
            PANTRY_ITEMS,
            &Query::update(
                Filter::eq("item_id", change.item_id.as_str()),
                values(vec![("quantity", jnum(change.after)), ("updated_at", json!(at))]),
            ),
        )?;
    }
    if !changes.is_empty() {
        shopping::on_pantry_change(host)?;
    }
    let kitchen = kitchen::view(host)?;
    let self_id = kitchen["members"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["isSelf"] == true)
        .and_then(|m| m["memberId"].as_str());
    let portion = meal["eaters"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| e["member_id"].as_str() == self_id && self_id.is_some())
        .map(|e| num(&e["portion"]).unwrap_or(1.0));
    let after = store::get_meal(host, &meal_id)?.unwrap_or(meal);
    Ok(Ok(json!({
        "meal": recipe_view(host, &after, Some(&recipe))?["meal"],
        "pantryChanges": changes.iter().map(|c| json!({
            "name": c.name,
            "before": jnum(c.before),
            "after": jnum(c.after),
            "unit": c.unit,
        })).collect::<Vec<_>>(),
        "undo": {"actionId": action_id, "kind": "cooked", "count": changes.len()},
        "logOffer": portion.map_or(Value::Null, |p| json!({
            "description": recipe["title"],
            "servingNote": if p == 1.0 { "1 serving".to_owned() } else { format!("{} servings", crate::util::number(p)) },
        })),
    })))
}

const STARS: &str = "stars must be a whole number from 1 to 5, or null to clear";

pub fn rate<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        input::no_unknown_keys(input, &["mealId", "ratings"])?;
        let meal_id = input::uuid(input, "mealId", true)?.unwrap_or_default();
        let Some(list) = input.get("ratings").and_then(|v| v.as_array()).filter(|a| !a.is_empty() && a.len() <= 20) else {
            return invalid("ratings must list 1 to 20 people with their stars");
        };
        Ok((meal_id, list.clone()))
    })();
    let (meal_id, list) = match parsed {
        Ok(p) => p,
        Err(e) => return Ok(Err(e)),
    };
    let (_, recipe) = match recipe_meal(host, &meal_id)? {
        Ok(found) => found,
        Err(e) => return Ok(Err(e)),
    };
    let kitchen_id = kitchen::ensure(host)?;
    let kitchen = kitchen::view(host)?;
    let people = view::members_by_id(&kitchen);
    let mut entries: Vec<(String, Option<i64>)> = vec![];
    for entry in &list {
        let empty = Fields::new();
        let fields = entry.as_object().unwrap_or(&empty);
        let member = match input::uuid(fields, "memberId", true) {
            Ok(m) => m.unwrap_or_default(),
            Err(e) => return Ok(Err(e)),
        };
        let stars = match fields.get("stars") {
            Some(Value::Null) => None,
            Some(v) => match v.as_f64().filter(|n| n.fract() == 0.0 && (1.0..=5.0).contains(n)) {
                Some(n) => Some(n as i64),
                None => return Ok(invalid(STARS)),
            },
            None => return Ok(invalid(STARS)),
        };
        if !people.contains_key(&member) {
            return Ok(invalid("There is no household member with that id"));
        }
        entries.push((member, stars));
    }
    let recipe_id = text(&recipe, "recipe_id");
    let (_, now) = context(host)?;
    for (member, stars) in &entries {
        match stars {
            None => {
                Client(host).query(
                    RATINGS,
                    &Query::delete(Filter::And {
                        filters: vec![
                            Filter::eq("member_id", member.as_str()),
                            Filter::eq("recipe_id", recipe_id.as_str()),
                        ],
                    }),
                )?;
            }
            Some(n) => {
                let mut query = Query::insert(values(vec![
                    ("kitchen_id", json!(kitchen_id)),
                    ("member_id", json!(member)),
                    ("recipe_id", json!(recipe_id)),
                    ("stars", json!(n)),
                    ("rated_at", json!(now)),
                ]));
                query.conflict = Conflict::Update {
                    columns: vec!["owner_user_id".into(), "member_id".into(), "recipe_id".into()],
                    values: values(vec![("stars", json!(n)), ("rated_at", json!(now))]),
                };
                Client(host).query(RATINGS, &query)?;
            }
        }
    }
    Ok(Ok(reload_view(host, &meal_id)?))
}
