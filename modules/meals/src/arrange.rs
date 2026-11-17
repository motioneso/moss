//! The tools that arrange a plan after it is written: delete a plan, read one meal, change its
//! servings, lock or move it, and edit a day. The port has no transactions, so a change that
//! touches several rows writes the harmless rows first and flips the guarded row last.
use crate::input::{self, invalid, Checked, Fields};
use crate::store::{self, text, DAYS, EATERS, MEALS};
use crate::util::{jopt, new_id};
use crate::{cooking, kitchen, plans, shopping};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const NO_MEAL: &str = "No meal with that id";
const NO_PLAN: &str = "No plan with that id";

fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

pub(crate) fn ne(column: &str, value: &str) -> Filter {
    Filter::Compare {
        column: column.into(),
        op: moss_module_sdk::query::Compare::Ne,
        value: json!(value),
    }
}

fn is_null(column: &str) -> Filter {
    Filter::Null {
        column: column.into(),
        not: false,
    }
}

fn id_field(input: &Fields, key: &str) -> Checked<String> {
    Ok(input::text(input, key, true, 64)?.unwrap_or_default())
}

/// The plan a day belongs to.
pub(crate) fn plan_of_day<H: Host + ?Sized>(host: &H, day_id: &str) -> Result<Option<String>> {
    Ok(store::get_day(host, day_id)?.map(|d| text(&d, "plan_id")))
}

// ---- plan.delete ----

pub fn plan_delete<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let plan_id = match id_field(input, "planId") {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    if store::get_plan(host, &plan_id)?.is_some() {
        shopping::on_plan_deleted(host, &plan_id)?;
    }
    if !store::delete_plan(host, &plan_id)? {
        return Ok(invalid(NO_PLAN));
    }
    Ok(Ok(json!({"deleted": true})))
}

// ---- meal.get ----

/// The recipe screen for a meal of any kind or status.
pub fn recipe_screen<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<Checked<Value>> {
    let Some(meal) = store::get_meal(host, meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    let recipe = match meal["recipe_id"].as_str() {
        Some(id) => store::get_recipes(host, &[id.to_owned()])?.into_iter().next(),
        None => None,
    };
    Ok(Ok(cooking::recipe_view(host, &meal, recipe.as_ref())?))
}

pub fn meal_get<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    match id_field(input, "mealId") {
        Ok(id) => recipe_screen(host, &id),
        Err(e) => Ok(Err(e)),
    }
}

// ---- meal.servings ----

fn valid_servings(n: f64) -> bool {
    (0.5..=24.0).contains(&n) && (n * 2.0).fract() == 0.0
}

pub fn meal_servings<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        input::no_unknown_keys(input, &["mealId", "servings"])?;
        let meal_id = input::uuid(input, "mealId", true)?.unwrap_or_default();
        let servings = match input.get("servings") {
            Some(Value::Null) => None,
            Some(Value::Number(n)) if n.as_f64().is_some_and(valid_servings) => n.as_f64(),
            _ => return invalid("servings must be a multiple of 0.5 from 0.5 to 24, or null to reset"),
        };
        Ok((meal_id, servings))
    })();
    let (meal_id, servings) = match parsed {
        Ok(parts) => parts,
        Err(e) => return Ok(Err(e)),
    };
    let Some(meal) = store::get_meal(host, &meal_id)? else {
        return Ok(invalid("There is no meal with that id"));
    };
    if meal["kind"] != "recipe" || meal["status"] != "ready" || meal["recipe_id"].is_null() {
        return Ok(invalid("That meal has no recipe yet"));
    }
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("That meal is already cooked"));
    }
    store::update(
        host,
        MEALS,
        Filter::eq("meal_id", meal_id.as_str()),
        vec![("servings_override", jopt(servings))],
    )?;
    if let Some(plan_id) = plan_of_day(host, &text(&meal, "day_id"))? {
        shopping::on_plan_change(host, &plan_id)?;
    }
    recipe_screen(host, &meal_id)
}

// ---- meal.edit ----

/// The slot position a meal takes on a day: the slot's own position, or one past the last.
fn slot_position(meals: &[Value], slot: &str) -> i64 {
    meals
        .iter()
        .find(|m| m["slot_name"] == slot)
        .and_then(|m| m["slot_position"].as_i64())
        .unwrap_or_else(|| meals.iter().filter_map(|m| m["slot_position"].as_i64()).max().map_or(0, |m| m + 1))
}

fn target_slot(input: &Fields) -> Checked<Option<String>> {
    match input.get("targetSlotName") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => input::text(input, "targetSlotName", true, 40),
    }
}

fn move_meal<H: Host + ?Sized>(host: &H, meal: &Value, plan_id: &str, input: &Fields) -> Result<Checked<()>> {
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("A cooked meal cannot be moved"));
    }
    if meal["status"] == "writing" {
        return Ok(invalid("Wait for this meal to finish writing before moving it"));
    }
    let days = store::list_days(host, plan_id)?;
    let by_id = input.get("targetDayId").and_then(Value::as_str);
    let by_date = input.get("targetDate").and_then(Value::as_str);
    let target = match (by_id, by_date) {
        (Some(id), _) => days.iter().find(|d| d["day_id"] == id),
        (None, Some(date)) => days.iter().find(|d| d["day_date"] == date),
        _ => None,
    };
    let Some(target) = target else {
        return Ok(invalid(if by_id.is_some() || by_date.is_some() {
            "That day is in another plan"
        } else {
            "Give targetDayId or targetDate"
        }));
    };
    let slot = match target_slot(input) {
        Ok(slot) => slot.unwrap_or_else(|| text(meal, "slot_name")),
        Err(e) => return Ok(Err(e)),
    };
    let target_id = text(target, "day_id");
    let position = slot_position(&store::list_day_meals(host, &target_id)?, &slot);
    let moved = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", text(meal, "meal_id")),
            is_null("cooked_at"),
            ne("status", "writing"),
        ]),
        vec![
            ("day_id", json!(target_id)),
            ("slot_name", json!(slot)),
            ("slot_position", json!(position)),
        ],
    )?;
    if !moved {
        return Ok(invalid("A cooked meal cannot be moved"));
    }
    shopping::on_plan_change(host, plan_id)?;
    Ok(Ok(()))
}

pub fn meal_edit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        let meal_id = id_field(input, "mealId")?;
        let action = input.get("action").and_then(Value::as_str).unwrap_or_default().to_owned();
        if !["lock", "unlock", "move", "set_eaters"].contains(&action.as_str()) {
            return invalid("action must be lock, unlock, move or set_eaters");
        }
        Ok((meal_id, action))
    })();
    let (meal_id, action) = match parsed {
        Ok(parts) => parts,
        Err(e) => return Ok(Err(e)),
    };
    let Some(meal) = store::get_meal(host, &meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    let plan_id = plan_of_day(host, &text(&meal, "day_id"))?.unwrap_or_default();
    match action.as_str() {
        "move" => {
            if let Err(e) = move_meal(host, &meal, &plan_id, input)? {
                return Ok(Err(e));
            }
        }
        "set_eaters" => {
            if let Err(e) = crate::swap::set_eaters(host, &meal, &plan_id, input)? {
                return Ok(Err(e));
            }
        }
        _ => {
            let lock = action == "lock";
            if lock && (meal["kind"] != "recipe" || meal["status"] != "ready") {
                return Ok(invalid("Only a written recipe meal can be locked"));
            }
            let set = store::update(
                host,
                MEALS,
                and(vec![
                    Filter::eq("meal_id", meal_id.as_str()),
                    Filter::eq("kind", "recipe"),
                    is_null("cooked_at"),
                ]),
                vec![("locked", json!(lock))],
            )?;
            if !set {
                return Ok(invalid("A cooked or text meal cannot be locked"));
            }
        }
    }
    recipe_screen(host, &meal_id)
}

// ---- day.edit ----

const ACTIONS: &str = "action must be set_text, clear_text, add_one_off, set_cook_limit or set_sharing";

fn day_screen<H: Host + ?Sized>(host: &H, plan_id: &str, day_id: &str) -> Result<Checked<Value>> {
    let Some(plan) = store::get_plan(host, plan_id)? else {
        return Ok(invalid(NO_PLAN));
    };
    let full = plans::load_view(host, &plan)?;
    Ok(full["days"]
        .as_array()
        .and_then(|days| days.iter().find(|d| d["dayId"] == day_id))
        .cloned()
        .map_or_else(|| invalid("That day is not in this plan"), Ok))
}

/// The day a call names: by dayId, or by planId plus a date.
fn resolve_day<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    if let Some(Value::String(id)) = input.get("dayId") {
        return Ok(match store::get_day(host, id)? {
            Some(day) => Ok(day),
            None => invalid("No day with that id"),
        });
    }
    let plan_id = match id_field(input, "planId") {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    let days = store::list_days(host, &plan_id)?;
    if days.is_empty() {
        return Ok(invalid(NO_PLAN));
    }
    Ok(plans::find_day(&days, input).cloned())
}

fn set_text<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| Ok((id_field(input, "mealId")?, input::text(input, "text", true, 200)?.unwrap_or_default())))();
    let (meal_id, words) = match parsed {
        Ok(parts) => parts,
        Err(e) => return Ok(Err(e)),
    };
    let Some(meal) = store::get_meal(host, &meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    if meal["locked"] == true {
        return Ok(invalid("Unlock that meal first. A text slot would drop its recipe"));
    }
    if !meal["cooked_at"].is_null() {
        return Ok(invalid("A cooked meal cannot become text"));
    }
    let set = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id.as_str()),
            is_null("cooked_at"),
            ne("status", "writing"),
        ]),
        vec![
            ("kind", json!("text")),
            ("plain_text", json!(words)),
            ("recipe_id", Value::Null),
            ("locked", json!(false)),
            ("servings_override", Value::Null),
            ("status", json!("ready")),
            ("failure_reason", Value::Null),
        ],
    )?;
    if !set {
        return Ok(invalid("Wait for this meal to finish writing before changing it to text"));
    }
    let day_id = text(&meal, "day_id");
    let plan_id = plan_of_day(host, &day_id)?.unwrap_or_default();
    shopping::on_plan_change(host, &plan_id)?;
    day_screen(host, &plan_id, &day_id)
}

fn clear_text<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let meal_id = match id_field(input, "mealId") {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    let Some(meal) = store::get_meal(host, &meal_id)? else {
        return Ok(invalid(NO_MEAL));
    };
    if meal["kind"] != "text" {
        return Ok(invalid("That meal is not a text slot"));
    }
    let cleared = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id.as_str()),
            Filter::eq("kind", "text"),
            is_null("cooked_at"),
        ]),
        vec![
            ("kind", json!("recipe")),
            ("plain_text", Value::Null),
            ("status", json!("pending")),
            ("failure_reason", Value::Null),
        ],
    )?;
    if !cleared {
        return Ok(invalid("That text slot cannot be cleared"));
    }
    let day_id = text(&meal, "day_id");
    let plan_id = plan_of_day(host, &day_id)?.unwrap_or_default();
    plans::enqueue_day(host, &plan_id, &day_id)?;
    day_screen(host, &plan_id, &day_id)
}

fn add_one_off<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let day = match resolve_day(host, input) {
        Ok(Ok(day)) => day,
        Ok(Err(e)) => return Ok(Err(e)),
        Err(e) => return Err(e),
    };
    let parsed = (|| Ok((input::text(input, "slotName", true, 40)?.unwrap_or_default(), id_field(input, "memberId")?)))();
    let (slot, member) = match parsed {
        Ok(parts) => parts,
        Err(e) => return Ok(Err(e)),
    };
    let kitchen_view = kitchen::view(host)?;
    if !kitchen_view["members"].as_array().is_some_and(|m| m.iter().any(|p| p["memberId"] == member)) {
        return Ok(invalid("That person is not in the household"));
    }
    let day_id = text(&day, "day_id");
    let plan_id = text(&day, "plan_id");
    let Some(plan) = store::get_plan(host, &plan_id)? else {
        return Ok(invalid(NO_PLAN));
    };
    let position = slot_position(&store::list_day_meals(host, &day_id)?, &slot);
    let meal_id = new_id(host)?;
    let kitchen_id = text(&plan, "kitchen_id");
    store::insert_ignore(
        host,
        MEALS,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("day_id", json!(day_id)),
            ("meal_id", json!(meal_id)),
            ("slot_name", json!(slot)),
            ("slot_position", json!(position)),
            ("kind", json!("recipe")),
            ("sharing", json!("solo")),
            ("status", json!("pending")),
            ("one_off_for", json!(member)),
        ],
    )?;
    store::insert_ignore(
        host,
        EATERS,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("meal_id", json!(meal_id)),
            ("member_id", json!(member)),
        ],
    )?;
    plans::enqueue_day(host, &plan_id, &day_id)?;
    day_screen(host, &plan_id, &day_id)
}

fn set_cook_limit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let day = match resolve_day(host, input)? {
        Ok(day) => day,
        Err(e) => return Ok(Err(e)),
    };
    let minutes = match input.get("minutes") {
        Some(Value::Null) => None,
        Some(Value::Number(n)) if n.as_i64().is_some_and(|m| (5..=240).contains(&m)) => n.as_i64(),
        _ => return Ok(invalid("minutes must be a whole number from 5 to 240, or null to clear")),
    };
    let day_id = text(&day, "day_id");
    if !store::set_day_cook_limit(host, &day_id, minutes)? {
        return Ok(invalid("No day with that id"));
    }
    day_screen(host, &text(&day, "plan_id"), &day_id)
}

/// Copies of a shared meal for each eater after the first, then the original goes solo with
/// its first eater. Copies go in first and are guarded by their own ids, so a rerun adds none.
fn split_meal<H: Host + ?Sized>(host: &H, meal: &Value) -> Result<Checked<()>> {
    let eaters: Vec<Value> = meal["eaters"].as_array().cloned().unwrap_or_default();
    let meal_id = text(meal, "meal_id");
    let kitchen_id = text(meal, "kitchen_id");
    let mut copies = vec![];
    for eater in eaters.iter().skip(1) {
        let copy_id = new_id(host)?;
        let mut fields = vec![
            ("kitchen_id", json!(kitchen_id)),
            ("day_id", meal["day_id"].clone()),
            ("meal_id", json!(copy_id)),
            ("slot_name", meal["slot_name"].clone()),
            ("slot_position", meal["slot_position"].clone()),
            ("kind", meal["kind"].clone()),
            ("sharing", json!("solo")),
            ("status", meal["status"].clone()),
            ("failure_reason", meal["failure_reason"].clone()),
            ("locked", meal["locked"].clone()),
            ("one_off_for", meal["one_off_for"].clone()),
            ("favourite_of", meal["favourite_of"].clone()),
            ("recipe_id", meal["recipe_id"].clone()),
            ("plain_text", meal["plain_text"].clone()),
            ("attempts", meal["attempts"].clone()),
            ("generation", meal["generation"].clone()),
        ];
        fields.retain(|(_, v)| !v.is_null());
        store::insert_ignore(host, MEALS, fields)?;
        store::insert_ignore(
            host,
            EATERS,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("meal_id", json!(copy_id)),
                ("member_id", eater["member_id"].clone()),
                ("portion", eater["portion"].clone()),
                ("estimated_kcal", eater["estimated_kcal"].clone()),
                ("safety", eater["safety"].clone()),
                ("safety_reason", eater["safety_reason"].clone()),
            ],
        )?;
        copies.push(copy_id);
    }
    let flipped = store::update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id.as_str()),
            Filter::eq("sharing", "shared"),
            is_null("cooked_at"),
            ne("status", "writing"),
        ]),
        vec![("sharing", json!("solo")), ("servings_override", Value::Null)],
    )?;
    if !flipped {
        for id in &copies {
            Client(host).query(MEALS, &Query::delete(Filter::eq("meal_id", id.as_str())))?;
        }
        return Ok(invalid("That slot's sharing cannot change"));
    }
    for eater in eaters.iter().skip(1) {
        Client(host).query(
            EATERS,
            &Query::delete(and(vec![
                Filter::eq("meal_id", meal_id.as_str()),
                Filter::eq("member_id", text(eater, "member_id")),
            ])),
        )?;
    }
    Ok(Ok(()))
}

fn set_sharing<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let day = match resolve_day(host, input)? {
        Ok(day) => day,
        Err(e) => return Ok(Err(e)),
    };
    let parsed = (|| {
        let slot = input::text(input, "slotName", true, 40)?.unwrap_or_default();
        match input.get("sharing").and_then(Value::as_str) {
            Some(s @ ("shared" | "solo")) => Ok((slot, s.to_owned())),
            _ => invalid("sharing must be shared or solo"),
        }
    })();
    let (slot, sharing) = match parsed {
        Ok(parts) => parts,
        Err(e) => return Ok(Err(e)),
    };
    let day_id = text(&day, "day_id");
    let plan_id = text(&day, "plan_id");
    let meals: Vec<Value> = store::list_day_meals(host, &day_id)?
        .into_iter()
        .filter(|m| m["slot_name"] == slot.as_str())
        .collect();
    if meals.is_empty() {
        return Ok(invalid("No meals in that slot that day"));
    }
    if meals.iter().any(|m| !m["cooked_at"].is_null()) {
        return Ok(invalid("A cooked meal's sharing cannot change"));
    }
    if meals.iter().any(|m| m["status"] == "writing") {
        return Ok(invalid("Wait for that slot to finish writing before changing its sharing"));
    }
    let mut overrides = day["sharing_overrides"].as_object().cloned().unwrap_or_default();
    overrides.insert(slot.clone(), json!(sharing));
    store::update(
        host,
        DAYS,
        Filter::eq("day_id", day_id.as_str()),
        vec![("sharing_overrides", Value::Object(overrides))],
    )?;
    if sharing == "solo" {
        for meal in meals.iter().filter(|m| m["sharing"] == "shared" && m["eaters"].as_array().is_some_and(|e| !e.is_empty())) {
            if let Err(e) = split_meal(host, meal)? {
                return Ok(Err(e));
            }
        }
    } else if meals.iter().any(|m| m["sharing"] == "solo") {
        if let Err(e) = crate::swap::merge_slot(host, &day_id, &meals)? {
            return Ok(Err(e));
        }
    }
    shopping::on_plan_change(host, &plan_id)?;
    day_screen(host, &plan_id, &day_id)
}

pub fn day_edit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    match input.get("action").and_then(Value::as_str) {
        Some("set_text") => set_text(host, input),
        Some("clear_text") => clear_text(host, input),
        Some("add_one_off") => add_one_off(host, input),
        Some("set_cook_limit") => set_cook_limit(host, input),
        Some("set_sharing") => set_sharing(host, input),
        _ => Ok(invalid(ACTIONS)),
    }
}
