//! The shopping list: its rows, the build from a plan, and the five list tools. The host port
//! has no transactions, so every multi-row change is a series of writes ordered so a repeat
//! after a crash finishes the work without doubling it.
use crate::input::{self, invalid, Checked, Fields};
use crate::list::{
    build_list, ingredient_key, reconcile_list, sort_key, BuildPantry, Diff, Ingredient, MealInput,
    Purchase, Stored, SECTION_ORDER,
};
use crate::pantry::{Input as Pantry, Stock};
use crate::store::{self, asc, find, in_list, insert_ignore, num, select, text, update};
use crate::units::normalise_unit;
use crate::util::{context, epoch_ms, jnum, jopt, new_id, values, weekday};
use crate::{kitchen, md5};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const LISTS: &str = "app.meals_shopping_lists";
pub const ITEMS: &str = "app.meals_shopping_list_items";
pub const PANTRY_ITEMS: &str = "app.meals_pantry_items";
pub const STAPLES: &str = "app.meals_staples";
pub const UNDO: &str = "app.meals_undo_actions";

const MAX_BATCH: usize = 100;
const MAX_QUANTITY: f64 = 1_000_000.0;
const NO_LINE: &str = "There is no shopping list line with that id";
/// Bought lines stay a day so Undo can find them, then a rebuild sweeps them.
const BOUGHT_KEEP_MS: i64 = 86_400_000;
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

pub struct StoredList {
    pub list_id: String,
    pub exists: bool,
    pub plan_id: Option<String>,
    pub lines: Vec<Stored>,
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

fn opt_text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

fn line_from_row(row: &Value) -> Stored {
    Stored {
        line_id: text(row, "line_id"),
        line_key: opt_text(row, "line_key"),
        manual: row["manual"] == true,
        name: text(row, "name"),
        quantity: num(&row["quantity"]),
        unit: opt_text(row, "unit"),
        purchase: num(&row["purchase_quantity"]).map(|quantity| Purchase {
            quantity,
            unit: opt_text(row, "purchase_unit").unwrap_or_default(),
        }),
        section: text(row, "store_section"),
        covered: row["covered_by_pantry"] == true,
        not_in_plan: row["not_in_plan"] == true,
        converted_from: strings(&row["converted_from"]),
        source_meal_ids: strings(&row["source_meal_ids"]),
        checked_at: opt_text(row, "checked_at"),
        bought_at: opt_text(row, "bought_at"),
        version: text(row, "updated_at"),
    }
}

/// Reads the list. A read never writes, so before the first write this is an empty list with the
/// id the first write will store.
pub fn read_list<H: Host + ?Sized>(host: &H) -> Result<StoredList> {
    let Some(head) = select(host, LISTS, Query::select(Filter::All))?.into_iter().next() else {
        let (actor, _) = context(host)?;
        return Ok(StoredList {
            list_id: md5::uuid_of(&format!("meals.list:{actor}")),
            exists: false,
            plan_id: None,
            lines: vec![],
        });
    };
    let list_id = text(&head, "list_id");
    let mut query = Query::select(Filter::eq("list_id", list_id.as_str()));
    query.order = vec![asc("created_at"), asc("line_id")];
    Ok(StoredList {
        exists: true,
        plan_id: opt_text(&head, "plan_id"),
        lines: select(host, ITEMS, query)?.iter().map(line_from_row).collect(),
        list_id,
    })
}

pub(crate) fn ensure_list<H: Host + ?Sized>(host: &H, kitchen_id: &str, plan_id: Option<&str>) -> Result<String> {
    let (actor, _) = context(host)?;
    let list_id = md5::uuid_of(&format!("meals.list:{actor}"));
    insert_ignore(
        host,
        LISTS,
        vec![("kitchen_id", json!(kitchen_id)), ("list_id", json!(list_id))],
    )?;
    if let Some(plan) = plan_id {
        update(host, LISTS, Filter::eq("list_id", list_id.as_str()), vec![("plan_id", json!(plan))])?;
    }
    find(host, LISTS, Filter::All)?
        .map(|head| text(&head, "list_id"))
        .ok_or_else(|| moss_module_sdk::Error::new("Shopping list not visible after insert"))
}

// ---- the plan behind a list ----

struct PlanContext {
    pantry_mode: Option<String>,
    labels: HashMap<String, String>,
    meals: Vec<MealInput>,
}

fn meal_label(date: &str, slot: &str) -> String {
    format!("{} {slot}", WEEKDAYS[weekday(date).unwrap_or(0)])
}

/// The plan's ready meals as list input, with a label for each meal. Empty when no plan.
fn plan_context<H: Host + ?Sized>(host: &H, plan_id: Option<&str>) -> Result<PlanContext> {
    let empty = PlanContext { pantry_mode: None, labels: HashMap::new(), meals: vec![] };
    let Some(plan_id) = plan_id else { return Ok(empty) };
    let Some(plan) = store::get_plan(host, plan_id)? else { return Ok(empty) };
    let days = store::list_days(host, plan_id)?;
    let day_ids: Vec<String> = days.iter().map(|d| text(d, "day_id")).collect();
    let date_of: HashMap<String, String> =
        days.iter().map(|d| (text(d, "day_id"), text(d, "day_date"))).collect();
    let mut meals = store::meals_of_days(host, &day_ids)?;
    meals.sort_by_key(|m| (date_of.get(&text(m, "day_id")).cloned(), m["slot_position"].as_i64()));
    let recipe_ids: Vec<String> = {
        let mut ids: Vec<String> = vec![];
        for id in meals.iter().filter_map(|m| m["recipe_id"].as_str()) {
            if !ids.iter().any(|i| i == id) {
                ids.push(id.to_owned());
            }
        }
        ids
    };
    let recipes = store::get_recipes(host, &recipe_ids)?;
    let start = text(&plan, "start_date");
    let mut labels = HashMap::new();
    let mut inputs = vec![];
    for meal in &meals {
        let date = date_of.get(&text(meal, "day_id")).unwrap_or(&start);
        labels.insert(text(meal, "meal_id"), meal_label(date, &text(meal, "slot_name")));
        let recipe = meal["recipe_id"].as_str().and_then(|id| recipes.iter().find(|r| r["recipe_id"] == id));
        let Some(recipe) = recipe.filter(|_| meal["status"] == "ready") else { continue };
        let base = num(&recipe["base_servings"]).unwrap_or(1.0);
        let eaten: f64 = meal["eaters"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| num(&e["portion"]).unwrap_or(0.0))
            .sum();
        inputs.push(MealInput {
            meal_id: text(meal, "meal_id"),
            servings: num(&meal["servings_override"]).unwrap_or(if eaten > 0.0 { eaten } else { base }),
            base_servings: base,
            ingredients: recipe["ingredients"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| Ingredient {
                    name: text(i, "name"),
                    quantity: num(&i["quantity"]),
                    unit: opt_text(i, "unit"),
                    section: text(i, "store_section"),
                })
                .collect(),
        });
    }
    Ok(PlanContext { pantry_mode: opt_text(&plan, "pantry_mode"), labels, meals: inputs })
}

pub fn read_pantry<H: Host + ?Sized>(host: &H) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut items = Query::select(Filter::All);
    items.order = vec![asc("name_key"), asc("created_at"), asc("item_id")];
    let mut staples = Query::select(Filter::All);
    staples.order = vec![asc("name_key")];
    Ok((select(host, PANTRY_ITEMS, items)?, select(host, STAPLES, staples)?))
}

fn pantry_input<H: Host + ?Sized>(host: &H) -> Result<Pantry> {
    let (items, staples) = read_pantry(host)?;
    Ok(Pantry {
        only: false,
        stock: items
            .iter()
            .map(|i| Stock { name: text(i, "name"), quantity: num(&i["quantity"]), unit: opt_text(i, "unit") })
            .collect(),
        staples: staples.iter().map(|s| text(s, "name")).collect(),
    })
}

fn default_mode<H: Host + ?Sized>(host: &H) -> Result<String> {
    Ok(kitchen::view(host)?["defaultPantryMode"].as_str().unwrap_or("prefer").to_owned())
}

// ---- views ----

fn line_view(line: &Stored, labels: &HashMap<String, String>) -> Value {
    json!({
        "lineId": line.line_id,
        "name": line.name,
        "quantity": jopt(line.quantity),
        "unit": line.unit,
        "purchase": line.purchase.as_ref().map_or(Value::Null, |p| json!({"quantity": jnum(p.quantity), "unit": p.unit})),
        "section": line.section,
        "manual": line.manual,
        "coveredByPantry": line.covered,
        "notInPlan": line.not_in_plan,
        "convertedFrom": line.converted_from,
        "sources": line.source_meal_ids.iter().filter_map(|id| labels.get(id).map(|l| json!({"mealId": id, "label": l}))).collect::<Vec<_>>(),
        "checkedAt": line.checked_at,
        "boughtAt": line.bought_at,
    })
}

fn list_view<H: Host + ?Sized>(host: &H, stored: &StoredList) -> Result<Value> {
    let context = plan_context(host, stored.plan_id.as_deref())?;
    let mode = match &context.pantry_mode {
        Some(mode) => mode.clone(),
        None => default_mode(host)?,
    };
    let mut lines: Vec<&Stored> = stored.lines.iter().collect();
    lines.sort_by(|a, b| sort_key(&a.section, &a.name, &b.section, &b.name));
    Ok(json!({
        "listId": stored.list_id,
        "planId": stored.plan_id,
        "pantryMode": mode,
        "lines": lines.iter().map(|l| line_view(l, &context.labels)).collect::<Vec<_>>(),
    }))
}

pub(crate) fn token(action_id: &str, kind: &str, count: usize) -> Value {
    json!({"actionId": action_id, "kind": kind, "count": count})
}

// ---- writes ----

fn purchase_fields(purchase: &Option<Purchase>) -> [(&'static str, Value); 2] {
    [
        ("purchase_quantity", purchase.as_ref().map_or(Value::Null, |p| jnum(p.quantity))),
        ("purchase_unit", purchase.as_ref().filter(|p| !p.unit.is_empty()).map_or(Value::Null, |p| json!(p.unit))),
    ]
}

fn apply_diff<H: Host + ?Sized>(host: &H, list_id: &str, kitchen_id: &str, diff: &Diff) -> Result<()> {
    let client = Client(host);
    for line in &diff.insert {
        let mut fields = vec![
            ("kitchen_id", json!(kitchen_id)),
            ("list_id", json!(list_id)),
            ("line_id", json!(new_id(host)?)),
            ("line_key", json!(line.line_key)),
            ("name", json!(line.name)),
            ("quantity", jopt(line.quantity)),
            ("unit", json!(line.unit)),
            ("store_section", json!(line.section)),
            ("covered_by_pantry", json!(line.covered)),
            ("not_in_plan", json!(false)),
            ("converted_from", json!(line.converted_from)),
            ("source_meal_ids", json!(line.source_meal_ids)),
        ];
        fields.extend(purchase_fields(&line.purchase));
        insert_ignore(host, ITEMS, fields)?;
    }
    for line in &diff.update {
        let mut set = vec![
            ("name", json!(line.name)),
            ("quantity", jopt(line.quantity)),
            ("unit", json!(line.unit)),
            ("store_section", json!(line.section)),
            ("covered_by_pantry", json!(line.covered)),
            ("not_in_plan", json!(line.not_in_plan)),
            ("converted_from", json!(line.converted_from)),
            ("source_meal_ids", json!(line.source_meal_ids)),
        ];
        set.extend(purchase_fields(&line.purchase));
        update(host, ITEMS, Filter::And { filters: vec![Filter::eq("line_id", line.line_id.as_str()), Filter::eq("list_id", list_id)] }, set)?;
    }
    if !diff.remove.is_empty() {
        client.query(ITEMS, &Query::delete(Filter::And { filters: vec![Filter::eq("list_id", list_id), in_list("line_id", &diff.remove)] }))?;
    }
    update(host, LISTS, Filter::eq("list_id", list_id), vec![])?;
    Ok(())
}

/// Rebuilds the stored list from its plan. `empty` rebuilds as if the plan had no meals.
fn rebuild<H: Host + ?Sized>(host: &H, stored: &StoredList, kitchen_id: &str, empty: bool) -> Result<()> {
    let context = plan_context(host, if empty { None } else { stored.plan_id.as_deref() })?;
    let pantry = if context.meals.is_empty() { None } else { Some(pantry_input(host)?) };
    let mode = match (&context.pantry_mode, pantry.is_some()) {
        (Some(mode), _) => mode.clone(),
        (None, true) => default_mode(host)?,
        (None, false) => String::new(),
    };
    let generated = build_list(
        &context.meals,
        pantry.as_ref().map(|input| BuildPantry { cover: mode != "ignore", input }).as_ref(),
    );
    let mut diff = reconcile_list(&stored.lines, &generated);
    let now = context_now(host)?;
    if let Some(cutoff) = epoch_ms(&now).map(|n| n - BOUGHT_KEEP_MS) {
        for line in &stored.lines {
            if line.bought_at.as_deref().and_then(epoch_ms).is_some_and(|at| at < cutoff) {
                diff.remove.push(line.line_id.clone());
            }
        }
    }
    if diff.insert.len() + diff.update.len() + diff.remove.len() == 0 {
        return Ok(());
    }
    apply_diff(host, &stored.list_id, kitchen_id, &diff)
}

fn context_now<H: Host + ?Sized>(host: &H) -> Result<String> {
    Ok(context(host)?.1)
}

/// Plan hook. Rebuilds the list tied to the plan, if there is one.
pub fn on_plan_change<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<()> {
    let stored = read_list(host)?;
    if !stored.exists || stored.plan_id.as_deref() != Some(plan_id) {
        return Ok(());
    }
    let kitchen_id = kitchen::view(host)?["kitchenId"].as_str().unwrap_or_default().to_owned();
    rebuild(host, &stored, &kitchen_id, false)
}

/// Plan-deleted hook. Empties a list tied to the deleted plan.
pub fn on_plan_deleted<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<()> {
    let stored = read_list(host)?;
    if !stored.exists || stored.plan_id.as_deref() != Some(plan_id) {
        return Ok(());
    }
    let kitchen_id = kitchen::view(host)?["kitchenId"].as_str().unwrap_or_default().to_owned();
    rebuild(host, &stored, &kitchen_id, true)
}

/// Pantry hook. Rebuilds a list tied to a plan, so its covered lines follow the Pantry.
pub fn on_pantry_change<H: Host + ?Sized>(host: &H) -> Result<()> {
    let stored = read_list(host)?;
    if !stored.exists || stored.plan_id.is_none() {
        return Ok(());
    }
    let kitchen_id = kitchen::view(host)?["kitchenId"].as_str().unwrap_or_default().to_owned();
    rebuild(host, &stored, &kitchen_id, false)
}

// ---- input ----

/// `None` when absent, `Some(None)` for an explicit null.
pub fn read_quantity(input: &Fields, key: &str, message: &str) -> Checked<Option<Option<f64>>> {
    match input.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Number(n)) => match n.as_f64().filter(|v| *v > 0.0 && *v <= MAX_QUANTITY) {
            Some(v) => Ok(Some(Some((v * 1000.0).round() / 1000.0))),
            None => invalid(message),
        },
        Some(_) => invalid(message),
    }
}

/// `None` when absent, `Some(None)` for null or a unit that normalises to nothing.
pub fn read_unit(input: &Fields, key: &str) -> Checked<Option<Option<String>>> {
    if input.get(key) == Some(&Value::Null) {
        return Ok(Some(None));
    }
    Ok(input::text(input, key, false, 24)?.map(|t| normalise_unit(Some(&t))))
}

fn quantity_message(key: &str) -> String {
    format!("{key} must be a number above 0")
}

fn id_list(input: &Fields, key: &str) -> Checked<Vec<String>> {
    let Some(items) = input.get(key).and_then(Value::as_array).filter(|a| !a.is_empty() && a.len() <= MAX_BATCH) else {
        return invalid(format!("{key} must hold 1 to {MAX_BATCH} line ids"));
    };
    items
        .iter()
        .map(|item| {
            let mut one = Fields::new();
            one.insert("id".into(), item.clone());
            Ok(input::uuid(&one, "id", true)?.unwrap_or_default())
        })
        .collect()
}

fn find_line<'a>(stored: &'a StoredList, id: &str) -> Checked<&'a Stored> {
    match stored.lines.iter().find(|l| l.line_id == id) {
        Some(line) => Ok(line),
        None => invalid(NO_LINE),
    }
}

// ---- tools ----

pub fn list_get<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    if let Err(e) = input::no_unknown_keys(input, &[]) {
        return Ok(Err(e));
    }
    Ok(Ok(list_view(host, &read_list(host)?)?))
}

pub fn list_build<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let plan_id = match (|| {
        input::no_unknown_keys(input, &["planId"])?;
        Ok(input::uuid(input, "planId", true)?.unwrap_or_default())
    })() {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    if store::get_plan(host, &plan_id)?.is_none() {
        return Ok(invalid("No plan with that id"));
    }
    let kitchen_id = kitchen::ensure(host)?;
    ensure_list(host, &kitchen_id, Some(&plan_id))?;
    rebuild(host, &read_list(host)?, &kitchen_id, false)?;
    Ok(Ok(list_view(host, &read_list(host)?)?))
}

pub fn list_edit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let action = match (|| {
        input::no_unknown_keys(input, &["action", "lineId", "lineIds", "name", "quantity", "unit", "section"])?;
        input::required_choice(input, "action", &["add", "update", "remove", "tick", "untick"])
    })() {
        Ok(a) => a,
        Err(e) => return Ok(Err(e)),
    };
    let mut undo = Value::Null;
    match action.as_str() {
        "add" => {
            let parsed = (|| {
                let name = input::text(input, "name", true, 80)?.unwrap_or_default();
                let quantity = read_quantity(input, "quantity", &quantity_message("quantity"))?.flatten();
                let unit = read_unit(input, "unit")?.flatten();
                let section = input::choice(input, "section", &SECTION_ORDER)?.unwrap_or_else(|| "other".into());
                Ok((name, quantity, unit, section))
            })();
            let (name, quantity, unit, section) = match parsed {
                Ok(p) => p,
                Err(e) => return Ok(Err(e)),
            };
            let kitchen_id = kitchen::ensure(host)?;
            let list_id = ensure_list(host, &kitchen_id, None)?;
            let fields = vec![
                ("kitchen_id", json!(kitchen_id)),
                ("list_id", json!(list_id)),
                ("line_id", json!(new_id(host)?)),
                ("name", json!(name)),
                ("quantity", jopt(quantity)),
                ("unit", json!(unit)),
                ("store_section", json!(section)),
                ("manual", json!(true)),
            ];
            Client(host).query(ITEMS, &Query::insert(values(fields)))?;
        }
        "update" => {
            let stored = read_list(host)?;
            let line = match (|| {
                let id = input::uuid(input, "lineId", true)?.unwrap_or_default();
                find_line(&stored, &id)
            })() {
                Ok(line) => line,
                Err(e) => return Ok(Err(e)),
            };
            let parsed = (|| {
                let quantity = read_quantity(input, "quantity", &quantity_message("quantity"))?;
                let unit = read_unit(input, "unit")?;
                let name = input::text(input, "name", false, 80)?;
                let section = input::choice(input, "section", &SECTION_ORDER)?;
                Ok((quantity, unit, name, section))
            })();
            let (quantity, unit, name, section) = match parsed {
                Ok(p) => p,
                Err(e) => return Ok(Err(e)),
            };
            let mut set: Vec<(&str, Value)> = vec![];
            if let Some(name) = name {
                set.push(("name", json!(name)));
            }
            if let Some(section) = section {
                set.push(("store_section", json!(section)));
            }
            if line.manual {
                if let Some(q) = quantity {
                    set.push(("quantity", jopt(q)));
                }
                if let Some(u) = &unit {
                    set.push(("unit", json!(u)));
                }
            } else if quantity.is_some() || unit.is_some() {
                // A built line keeps what the recipes need; the shopper edits the amount to buy.
                let amount = quantity.flatten().or(line.purchase.as_ref().map(|p| p.quantity)).or(line.quantity);
                let Some(amount) = amount else { return Ok(invalid("quantity is required for this line")) };
                let unit = unit
                    .flatten()
                    .or_else(|| line.purchase.as_ref().map(|p| p.unit.clone()))
                    .or_else(|| normalise_unit(line.unit.as_deref()))
                    .unwrap_or_default();
                set.extend(purchase_fields(&Some(Purchase { quantity: amount, unit })));
            }
            if !update(host, ITEMS, Filter::eq("line_id", line.line_id.as_str()), set)? {
                return Ok(invalid(NO_LINE));
            }
        }
        "remove" => {
            let stored = read_list(host)?;
            let line = match (|| {
                let id = input::uuid(input, "lineId", true)?.unwrap_or_default();
                find_line(&stored, &id)
            })() {
                Ok(line) => line,
                Err(e) => return Ok(Err(e)),
            };
            let kitchen_id = kitchen::view(host)?["kitchenId"].as_str().unwrap_or_default().to_owned();
            let action_id = new_id(host)?;
            // The undo record goes first, so a crash between the two writes leaves a record
            // for lines that still exist and loses nothing.
            insert_ignore(
                host,
                UNDO,
                vec![
                    ("kitchen_id", json!(kitchen_id)),
                    ("action_id", json!(action_id)),
                    ("kind", json!("removed")),
                    ("before_state", json!({"lines": [line_record(line)]})),
                ],
            )?;
            Client(host).query(ITEMS, &Query::delete(Filter::eq("line_id", line.line_id.as_str())))?;
            undo = token(&action_id, "removed", 1);
        }
        _ => {
            let ids = match (|| {
                if input.contains_key("lineIds") && input["lineIds"] != Value::Null {
                    id_list(input, "lineIds")
                } else {
                    Ok(vec![input::uuid(input, "lineId", true)?.unwrap_or_default()])
                }
            })() {
                Ok(ids) => ids,
                Err(e) => return Ok(Err(e)),
            };
            let mut filters = vec![in_list("line_id", &ids), Filter::Null { column: "bought_at".into(), not: false }];
            let set = if action == "tick" {
                filters.push(Filter::Null { column: "checked_at".into(), not: false });
                json!(context_now(host)?)
            } else {
                Value::Null
            };
            update(host, ITEMS, Filter::And { filters }, vec![("checked_at", set)])?;
        }
    }
    Ok(Ok(json!({"list": list_view(host, &read_list(host)?)?, "undo": undo})))
}

/// A stored line as the snake_case record an undo keeps.
pub(crate) fn line_record(line: &Stored) -> Value {
    json!({
        "line_id": line.line_id,
        "line_key": line.line_key,
        "name": line.name,
        "quantity": jopt(line.quantity),
        "unit": line.unit,
        "purchase_quantity": line.purchase.as_ref().map_or(Value::Null, |p| jnum(p.quantity)),
        "purchase_unit": line.purchase.as_ref().filter(|p| !p.unit.is_empty()).map_or(Value::Null, |p| json!(p.unit)),
        "store_section": line.section,
        "manual": line.manual,
        "covered_by_pantry": line.covered,
        "not_in_plan": line.not_in_plan,
        "converted_from": line.converted_from,
        "source_meal_ids": line.source_meal_ids,
        "checked_at": line.checked_at,
        "bought_at": line.bought_at,
    })
}

struct Pick<'a> {
    line: &'a Stored,
    quantity: Option<Option<f64>>,
    unit: Option<Option<String>>,
}

pub fn list_bought<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    if let Err(e) = input::no_unknown_keys(input, &["lines"]) {
        return Ok(Err(e));
    }
    let stored = read_list(host)?;
    let open: Vec<&Stored> = stored.lines.iter().filter(|l| l.bought_at.is_none()).collect();
    let mut picks: Vec<Pick> = vec![];
    match input.get("lines") {
        None => picks.extend(open.iter().filter(|l| l.checked_at.is_some()).map(|line| Pick { line, quantity: None, unit: None })),
        Some(raw) => {
            let Some(entries) = raw.as_array().filter(|a| !a.is_empty() && a.len() <= MAX_BATCH) else {
                return Ok(invalid(format!("lines must hold 1 to {MAX_BATCH} entries")));
            };
            for entry in entries {
                let Some(fields) = entry.as_object() else { return Ok(invalid("lines entries must be objects")) };
                let picked = (|| {
                    input::no_unknown_keys(fields, &["lineId", "quantity", "unit"])?;
                    let id = input::uuid(fields, "lineId", true)?.unwrap_or_default();
                    let Some(line) = open.iter().find(|l| l.line_id == id) else { return invalid(NO_LINE) };
                    let quantity = read_quantity(fields, "quantity", &quantity_message("quantity"))?;
                    let unit = read_unit(fields, "unit")?;
                    Ok(Pick { line, quantity, unit })
                })();
                match picked {
                    Ok(p) => picks.push(p),
                    Err(e) => return Ok(Err(e)),
                }
            }
        }
    }
    if picks.is_empty() {
        return Ok(invalid("Tick the lines you bought first"));
    }
    let kitchen_id = kitchen::ensure(host)?;
    let (_, at) = context(host)?;
    // Each Pantry row gets an id derived from its line and the line's last change, so a repeat
    // after a crash adds nothing twice.
    let rows: Vec<(&Pick, String, Option<f64>, Option<String>)> = picks
        .iter()
        .map(|p| {
            let fallback = p.line.purchase.clone().unwrap_or(Purchase {
                quantity: p.line.quantity.unwrap_or(0.0),
                unit: p.line.unit.clone().unwrap_or_default(),
            });
            let fallback_quantity = if p.line.purchase.is_some() || p.line.quantity.is_some() { Some(fallback.quantity) } else { None };
            let quantity = match p.quantity { Some(q) => q, None => fallback_quantity };
            let unit = match &p.unit { Some(u) => u.clone().unwrap_or_default(), None => fallback.unit.clone() };
            let item_id = md5::uuid_of(&format!("meals.bought:{}:{}", p.line.line_id, p.line.version));
            (p, item_id, quantity, Some(unit).filter(|u| !u.is_empty()))
        })
        .collect();
    for (p, item_id, quantity, unit) in &rows {
        insert_ignore(
            host,
            PANTRY_ITEMS,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("item_id", json!(item_id)),
                ("name", json!(p.line.name)),
                ("name_key", json!(ingredient_key(&p.line.name))),
                ("quantity", jopt(*quantity)),
                ("unit", json!(unit)),
                ("source", json!("bought")),
                ("created_at", json!(at)),
                ("updated_at", json!(at)),
            ],
        )?;
    }
    let line_ids: Vec<String> = rows.iter().map(|r| r.0.line.line_id.clone()).collect();
    let bought = Client(host).query(
        ITEMS,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("list_id", stored.list_id.as_str()),
                    in_list("line_id", &line_ids),
                    Filter::Null { column: "bought_at".into(), not: false },
                ],
            },
            values(vec![("bought_at", json!(at)), ("updated_at", json!(at))]),
        ),
    )?;
    let action_id = new_id(host)?;
    insert_ignore(
        host,
        UNDO,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("action_id", json!(action_id)),
            ("kind", json!("bought")),
            ("before_state", json!({"at": at, "lineIds": line_ids, "itemIds": rows.iter().map(|r| r.1.clone()).collect::<Vec<_>>()})),
        ],
    )?;
    Ok(Ok(json!({
        "list": list_view(host, &read_list(host)?)?,
        "pantryAdded": bought.len(),
        "undo": token(&action_id, "bought", bought.len()),
    })))
}

pub fn list_clear<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let list_id = match (|| {
        input::no_unknown_keys(input, &["listId"])?;
        Ok(input::uuid(input, "listId", true)?.unwrap_or_default())
    })() {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    let stored = read_list(host)?;
    if !stored.exists || stored.list_id != list_id {
        return Ok(invalid("No shopping list with that id"));
    }
    Client(host).query(ITEMS, &Query::delete(Filter::eq("list_id", list_id.as_str())))?;
    Ok(Ok(json!({"cleared": true})))
}
