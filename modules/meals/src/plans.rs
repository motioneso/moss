//! The meals.plan.* tools. Creating a plan writes its skeleton and queues the first day; the
//! day job queues the rest.
use crate::input::{invalid, Checked, Fields};
use crate::rules::{parse_date, plan_skeleton, Member, SlotRule, MAX_PLAN_DAYS};
use crate::store::{self, text, NewMeal, NewPlan};
use crate::{input, kitchen, md5, view};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

pub const PLAN_DAY_QUEUE: &str = "meals-plan-day";
const MAX_REQUEST_TEXT: usize = 1000;

fn new_id<H: Host + ?Sized>(host: &H) -> Result<String> {
    host.call("context", "uuid", "new", json!({}))?["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| moss_module_sdk::Error::new("Host id unavailable"))
}

fn date(input: &Fields, key: &str) -> Checked<String> {
    let value = input::text(input, key, true, 10)?.unwrap_or_default();
    if parse_date(&value).is_none() || value.len() != 10 {
        return invalid(format!("{key} must be a date like 2026-11-02"));
    }
    Ok(value)
}

/// The key a day's job runs under. One per day and generation, so a rerun never collides with
/// a key the queue still remembers.
fn day_key(day_id: &str, generation: i64) -> String {
    md5::uuid_of(&format!("meals.plan-day:{day_id}:g{generation}"))
}

/// Raises the day's generation and queues its job. A queue that refuses pauses the plan.
pub fn enqueue_day<H: Host + ?Sized>(host: &H, plan_id: &str, day_id: &str) -> Result<()> {
    let Some(generation) = store::bump_day(host, day_id)? else {
        return Ok(());
    };
    let queued = host.call(
        "jobs",
        "enqueue-options",
        PLAN_DAY_QUEUE,
        json!({
            "params": {"plan-id": plan_id, "day-id": day_id, "generation": generation},
            "idempotencyKey": day_key(day_id, generation),
            "availableAt": crate::util::context(host)?.1
        }),
    );
    if queued.is_err() {
        store::set_plan_state(host, plan_id, "paused", Some("pending"))?;
    }
    Ok(())
}

fn load_view<H: Host + ?Sized>(host: &H, plan: &Value) -> Result<Value> {
    let plan_id = text(plan, "plan_id");
    let days = store::list_days(host, &plan_id)?;
    let day_ids: Vec<String> = days.iter().map(|d| text(d, "day_id")).collect();
    let meals = store::meals_of_days(host, &day_ids)?;
    let recipe_ids: Vec<String> = meals
        .iter()
        .filter_map(|m| m["recipe_id"].as_str().map(str::to_owned))
        .collect();
    let recipes = store::get_recipes(host, &recipe_ids)?;
    Ok(view::plan_view(
        plan,
        &days,
        &meals,
        &recipes,
        &kitchen::view(host)?,
    ))
}

fn require_plan<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<Checked<Value>> {
    Ok(match store::get_plan(host, plan_id)? {
        Some(plan) => Ok(plan),
        None => invalid("No plan with that id"),
    })
}

fn members_and_rules(kitchen: &Value) -> (Vec<Member>, Vec<SlotRule>) {
    let members = kitchen["members"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| Member {
            id: text(m, "memberId"),
            meal_pattern: m["mealPattern"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect(),
            calorie_target: m["calorieTarget"].as_i64(),
        })
        .collect();
    let rules = kitchen["slotRules"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| SlotRule {
            slot_name: text(r, "slotName"),
            solo_weekdays: r["soloWeekdays"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .collect(),
        })
        .collect();
    (members, rules)
}

fn meal_types(input: &Fields) -> Checked<Option<Vec<String>>> {
    match input.get("mealTypes") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items))
            if !items.is_empty()
                && items.len() <= 8
                && items
                    .iter()
                    .all(|i| i.as_str().is_some_and(|s| !s.trim().is_empty() && s.len() <= 40)) =>
        {
            Ok(Some(
                items.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect(),
            ))
        }
        Some(_) => invalid("mealTypes must list 1 to 8 meal names such as dinner"),
    }
}

pub fn create<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        let start = date(input, "startDate")?;
        let days = match input.get("days") {
            Some(Value::Number(n)) if n.as_i64().is_some() => n.as_i64().unwrap_or(0),
            _ => return invalid("days must be a whole number"),
        };
        if !(1..=MAX_PLAN_DAYS).contains(&days) {
            return invalid(format!("days must be 1 to {MAX_PLAN_DAYS}"));
        }
        let key = input::text(input, "idempotencyKey", true, 128)?.unwrap_or_default();
        let pantry = input::choice(input, "pantryMode", &["ignore", "prefer", "only"])?;
        let request = match input.get("requestText") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.trim().to_owned(),
            Some(_) => return invalid("requestText must be text"),
        };
        if request.encode_utf16().count() > MAX_REQUEST_TEXT {
            return invalid(format!("requestText must be at most {MAX_REQUEST_TEXT} characters"));
        }
        let allow = match input.get("allowRepeats") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return invalid("allowRepeats must be true or false"),
        };
        Ok((start, days, key, pantry, request, meal_types(input)?, allow))
    })();
    let (start, days, key, pantry, request, types, allow) = match parsed {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };

    if let Some(existing) = store::find_plan_by_key(host, &key)? {
        return Ok(match require_plan(host, &existing)? {
            Ok(plan) => Ok(load_view(host, &plan)?),
            Err(e) => Err(e),
        });
    }
    let kitchen_id = kitchen::ensure(host)?;
    let kitchen_view = kitchen::view(host)?;
    let (members, rules) = members_and_rules(&kitchen_view);
    let skeleton = match plan_skeleton(&members, &rules, &start, days, types.as_deref()) {
        Ok(s) => s,
        Err(message) => return Ok(invalid(message)),
    };
    if skeleton.iter().all(|d| d.meals.is_empty()) {
        return Ok(invalid("No one in the household eats the meals asked for"));
    }
    let mut new_days = vec![];
    let mut new_meals = vec![];
    for day in &skeleton {
        let day_id = new_id(host)?;
        for meal in &day.meals {
            new_meals.push(NewMeal {
                meal_id: new_id(host)?,
                day_id: day_id.clone(),
                slot_name: meal.slot_name.clone(),
                slot_position: meal.slot_position as i64,
                shared: meal.shared,
                eater_ids: meal.eater_ids.clone(),
            });
        }
        new_days.push((day_id, day.date.clone()));
    }
    let first_day = new_days.first().map(|d| d.0.clone());
    let plan = NewPlan {
        plan_id: new_id(host)?,
        kitchen_id,
        start_date: start,
        day_count: days,
        pantry_mode: pantry.unwrap_or_else(|| text(&kitchen_view, "defaultPantryMode")),
        request_text: (!request.is_empty()).then_some(request),
        allow_repeats: allow,
        idempotency_key: key,
        days: new_days,
        meals: new_meals,
    };
    let (plan_id, created) = store::create_plan(host, &plan)?;
    if let (true, Some(first)) = (created, first_day) {
        enqueue_day(host, &plan_id, &first)?;
    }
    Ok(match require_plan(host, &plan_id)? {
        Ok(row) => Ok(load_view(host, &row)?),
        Err(e) => Err(e),
    })
}

pub fn get<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let found = (|| {
        let plan_id = input::text(input, "planId", false, 64)?;
        if plan_id.is_none() && !input.contains_key("date") {
            return invalid("Give a planId or a date");
        }
        let day = if plan_id.is_none() { Some(date(input, "date")?) } else { None };
        Ok((plan_id, day))
    })();
    let (plan_id, day) = match found {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let plan_id = match (plan_id, day) {
        (Some(id), _) => id,
        (None, Some(day)) => match store::find_plan_by_date(host, &day)? {
            Some(id) => id,
            None => return Ok(invalid("No plan covers that date")),
        },
        (None, None) => return Ok(invalid("Give a planId or a date")),
    };
    Ok(match require_plan(host, &plan_id)? {
        Ok(plan) => Ok(load_view(host, &plan)?),
        Err(e) => Err(e),
    })
}

/// The plan the Plan tab shows. `plan` is null when nothing has been planned yet.
pub fn current<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let day = match (|| {
        date(input, "date")
    })() {
        Ok(day) => day,
        Err(error) => return Ok(Err(error)),
    };
    let Some(plan_id) = store::find_current_plan(host, &day)? else {
        return Ok(Ok(json!({"plan": null})));
    };
    Ok(match require_plan(host, &plan_id)? {
        Ok(plan) => Ok(json!({"plan": load_view(host, &plan)?})),
        Err(e) => Err(e),
    })
}

fn find_day<'a>(days: &'a [Value], input: &Fields) -> Checked<&'a Value> {
    let by_id = input::text(input, "dayId", false, 64)?;
    let wanted = match &by_id {
        Some(_) => None,
        None => Some(date(input, "date")?),
    };
    days.iter()
        .find(|d| match (&by_id, &wanted) {
            (Some(id), _) => d["day_id"] == id.as_str(),
            (None, Some(day)) => d["day_date"] == day.as_str(),
            _ => false,
        })
        .map_or_else(|| invalid("That day is not in this plan"), Ok)
}

/// Resets the target meals and queues their days. The first day queues; the job chains.
fn reset_and_enqueue<H: Host + ?Sized>(
    host: &H,
    plan_id: &str,
    days: &[Value],
    targets: &[Value],
) -> Result<()> {
    let ids: Vec<String> = targets.iter().map(|m| text(m, "meal_id")).collect();
    store::reset_meals(host, &ids)?;
    store::set_plan_state(host, plan_id, "active", None)?;
    let touched: Vec<&Value> = targets.iter().map(|m| &m["day_id"]).collect();
    let mut affected = days.iter().filter(|d| touched.contains(&&d["day_id"]));
    let first = affected.next().map(|d| text(d, "day_id"));
    for day in affected {
        store::bump_day(host, &text(day, "day_id"))?;
    }
    if let Some(first) = first {
        enqueue_day(host, plan_id, &first)?;
    }
    Ok(())
}

fn regenerate<H: Host + ?Sized>(host: &H, plan_id: &str, input: &Fields) -> Result<Checked<()>> {
    let days = store::list_days(host, plan_id)?;
    let day_ids: Vec<String> = days.iter().map(|d| text(d, "day_id")).collect();
    let meals = store::meals_of_days(host, &day_ids)?;
    let scope: Vec<Value> = match input::text(input, "mealId", false, 64) {
        Err(e) => return Ok(Err(e)),
        Ok(Some(id)) => {
            let found: Vec<Value> = meals.into_iter().filter(|m| m["meal_id"] == id.as_str()).collect();
            if found.is_empty() {
                return Ok(invalid("That meal is not in this plan"));
            }
            found
        }
        Ok(None) if input.contains_key("dayId") || input.contains_key("date") => {
            let day = match find_day(&days, input) {
                Ok(day) => day["day_id"].clone(),
                Err(e) => return Ok(Err(e)),
            };
            meals.into_iter().filter(|m| m["day_id"] == day).collect()
        }
        Ok(None) => meals,
    };
    let targets: Vec<Value> = scope.into_iter().filter(view::is_replaceable).collect();
    if targets.is_empty() {
        return Ok(invalid("There is nothing to replace"));
    }
    reset_and_enqueue(host, plan_id, &days, &targets)?;
    Ok(Ok(()))
}

pub fn control<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        Ok(input::text(input, "planId", true, 64)?.unwrap_or_default())
    })();
    let plan_id = match parsed {
        Ok(id) => id,
        Err(error) => return Ok(Err(error)),
    };
    if let Err(e) = require_plan(host, &plan_id)? {
        return Ok(Err(e));
    }
    match input.get("action").and_then(Value::as_str) {
        Some("stop") => store::set_plan_state(host, &plan_id, "stopped", None)?,
        Some("resume") => {
            store::set_plan_state(host, &plan_id, "active", None)?;
            let days = store::list_days(host, &plan_id)?;
            if let Some(next) = days.iter().find(|d| matches!(d["status"].as_str(), Some("pending" | "writing"))) {
                enqueue_day(host, &plan_id, &text(next, "day_id"))?;
            }
        }
        Some("retry_day") => {
            let days = store::list_days(host, &plan_id)?;
            let day = match find_day(&days, input) {
                Ok(day) => day,
                Err(e) => return Ok(Err(e)),
            };
            if day["status"] == "ready" {
                return Ok(invalid("That day is already written"));
            }
            store::set_plan_state(host, &plan_id, "active", None)?;
            enqueue_day(host, &plan_id, &text(day, "day_id"))?;
        }
        Some("regenerate") => {
            if let Err(e) = regenerate(host, &plan_id, input)? {
                return Ok(Err(e));
            }
        }
        _ => return Ok(invalid("action must be stop, resume, retry_day or regenerate")),
    }
    Ok(match require_plan(host, &plan_id)? {
        Ok(plan) => Ok(load_view(host, &plan)?),
        Err(e) => Err(e),
    })
}
