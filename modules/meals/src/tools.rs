//! The four kitchen and household tools. The trusted host runs `handle` only after applying the
//! person's approval policy; `run` is the signed-in transport that asks the host to do so.
use crate::input::{self, coded, invalid, Checked, Fields, InputError};
use crate::{cooking, kitchen, log, plans, shopping, stock, undo, util};
use moss_module_sdk::{Host, Response, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub const TOOLS: [&str; 24] = [
    "meals.kitchen.get",
    "meals.kitchen.save",
    "meals.household.save",
    "meals.household.remove",
    "meals.plan.create",
    "meals.plan.get",
    "meals.plan.current",
    "meals.plan.control",
    "meals.list.get",
    "meals.list.build",
    "meals.list.edit",
    "meals.list.bought",
    "meals.list.clear",
    "meals.pantry.get",
    "meals.pantry.edit",
    "meals.log.list",
    "meals.log.summarize",
    "meals.log.add",
    "meals.log.reestimate",
    "meals.log.correct",
    "meals.log.delete",
    "meals.meal.cooked",
    "meals.meal.rate",
    "meals.undo",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    pub parameters: Value,
}

const KITCHEN_SAVE: [&str; 3] = ["unitsSystem", "defaultPantryMode", "slotRules"];
const SLOT_RULE: [&str; 3] = ["slotName", "soloWeekdays", "usualTime"];
const HOUSEHOLD_SAVE: [&str; 10] = [
    "memberId",
    "name",
    "linkedAccountEmail",
    "calorieTarget",
    "proteinTargetG",
    "carbTargetG",
    "fatTargetG",
    "mealPattern",
    "restrictions",
    "preferences",
];
const MAX_SLOT_RULES: usize = 6;

struct Rule {
    slot: String,
    weekdays: Vec<i64>,
    usual_time: Value,
}

fn slot_rules(raw: Option<&Value>) -> Checked<Vec<Rule>> {
    let Some(raw) = raw else { return Ok(vec![]) };
    let Some(items) = raw.as_array().filter(|a| a.len() <= MAX_SLOT_RULES) else {
        return invalid(format!(
            "slotRules must be an array of at most {MAX_SLOT_RULES} rules"
        ));
    };
    items
        .iter()
        .map(|entry| {
            let Some(rule) = entry.as_object() else {
                return invalid("slotRules entries must be objects");
            };
            input::no_unknown_keys(rule, &SLOT_RULE)?;
            let slot = input::text(rule, "slotName", true, 40)?
                .unwrap_or_default()
                .to_lowercase();
            let days: Option<Vec<i64>> = rule
                .get("soloWeekdays")
                .and_then(Value::as_array)
                .and_then(|days| {
                    days.iter()
                        .map(|d| {
                            d.as_f64()
                                .filter(|n| n.fract() == 0.0 && (1.0..=7.0).contains(n))
                                .map(|n| n as i64)
                        })
                        .collect()
                });
            let Some(mut weekdays) = days else {
                return invalid("soloWeekdays must hold ISO weekdays, 1 (Monday) to 7 (Sunday)");
            };
            weekdays.sort_unstable();
            weekdays.dedup();
            let usual_time = rule.get("usualTime").cloned().unwrap_or(Value::Null);
            if !usual_time.is_null() && !usual_time.as_str().is_some_and(input::is_clock_time) {
                return invalid("usualTime must be HH:MM or null");
            }
            Ok(Rule {
                slot,
                weekdays,
                usual_time,
            })
        })
        .collect()
}

/// Member columns the call set, in the order the old handler read them.
fn member_fields(input: &Fields, adding: bool) -> Checked<Vec<(&'static str, Value)>> {
    let mut out: Vec<(&'static str, Value)> = vec![];
    match input.get("linkedAccountEmail") {
        Some(Value::Null) => out.push(("linked_account_email", Value::Null)),
        _ => {
            if let Some(email) = input::text(input, "linkedAccountEmail", false, 320)? {
                if !input::is_email(&email) {
                    return invalid("linkedAccountEmail must be an email address");
                }
                out.push(("linked_account_email", json!(email)));
            }
        }
    }
    if let Some(name) = input::text(input, "name", adding, 80)? {
        out.push(("name", json!(name)));
    }
    for (key, column, min, max) in [
        ("calorieTarget", "calorie_target", 800, 6000),
        ("proteinTargetG", "protein_target_g", 0, 600),
        ("carbTargetG", "carb_target_g", 0, 1000),
        ("fatTargetG", "fat_target_g", 0, 400),
    ] {
        if let Some(value) = input::nullable_int(input, key, min, max)? {
            out.push((column, json!(value)));
        }
    }
    for (key, column, shape, lowercase) in [
        ("mealPattern", "meal_pattern", (1, 6, 40), true),
        ("restrictions", "restrictions", (0, 40, 80), false),
        ("preferences", "preferences", (0, 40, 120), false),
    ] {
        if let Some(list) = input::text_list(input, key, shape, lowercase)? {
            out.push((column, json!(list)));
        }
    }
    Ok(out)
}

fn failure(error: InputError) -> Value {
    json!({"data":{"error":error.message,"code":error.code}})
}

fn call<H: Host + ?Sized>(host: &H, tool: &str, parameters: &Value) -> Result<Checked<Value>> {
    let input = match input::strip_envelope(parameters) {
        Ok(input) => input,
        Err(error) => return Ok(Err(error)),
    };
    Ok(match tool {
        "meals.kitchen.get" => {
            if let Err(error) = input::no_unknown_keys(&input, &[]) {
                return Ok(Err(error));
            }
            Ok(kitchen::view(host)?)
        }
        "meals.kitchen.save" => save_kitchen(host, &input)?,
        "meals.household.save" => save_member(host, &input)?,
        "meals.household.remove" => remove_member(host, &input)?,
        "meals.plan.create" => plans::create(host, &input)?,
        "meals.plan.get" => plans::get(host, &input)?,
        "meals.plan.current" => plans::current(host, &input)?,
        "meals.plan.control" => plans::control(host, &input)?,
        "meals.list.get" => shopping::list_get(host, &input)?,
        "meals.list.build" => shopping::list_build(host, &input)?,
        "meals.list.edit" => shopping::list_edit(host, &input)?,
        "meals.list.bought" => shopping::list_bought(host, &input)?,
        "meals.list.clear" => shopping::list_clear(host, &input)?,
        "meals.pantry.get" => stock::get(host, &input)?,
        "meals.pantry.edit" => stock::edit(host, &input)?,
        "meals.log.list" => log::list(host, &input)?,
        "meals.log.summarize" => log::summarize(host, &input)?,
        "meals.log.add" => log::add(host, &input)?,
        "meals.log.reestimate" => log::reestimate(host, &input)?,
        "meals.log.correct" => log::correct(host, &input)?,
        "meals.log.delete" => log::delete(host, &input)?,
        "meals.meal.cooked" => cooking::cooked(host, &input)?,
        "meals.meal.rate" => cooking::rate(host, &input)?,
        "meals.undo" => undo::undo(host, &input)?,
        _ => return Err(moss_module_sdk::Error::new("Unknown Meals tool")),
    })
}

fn save_kitchen<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        input::no_unknown_keys(input, &KITCHEN_SAVE)?;
        let units = input::choice(input, "unitsSystem", &["us", "metric"])?;
        let pantry = input::choice(input, "defaultPantryMode", &["ignore", "prefer", "only"])?;
        Ok((units, pantry, slot_rules(input.get("slotRules"))?))
    })();
    let (units, pantry, rules) = match checked {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let kitchen_id = kitchen::ensure(host)?;
    if units.is_some() || pantry.is_some() {
        kitchen::update_kitchen(host, &kitchen_id, units, pantry)?;
    }
    for rule in &rules {
        kitchen::upsert_rule(
            host,
            &kitchen_id,
            &rule.slot,
            &rule.weekdays,
            &rule.usual_time,
        )?;
    }
    Ok(Ok(kitchen::view(host)?))
}

fn save_member<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        input::no_unknown_keys(input, &HOUSEHOLD_SAVE)?;
        let member = input::uuid(input, "memberId", false)?;
        let fields = member_fields(input, member.is_none())?;
        Ok((member, fields))
    })();
    let (member, fields) = match checked {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let kitchen_id = kitchen::ensure(host)?;
    let Some(member) = member else {
        return Ok(Ok(kitchen::add_member(host, &kitchen_id, fields)?));
    };
    Ok(match kitchen::update_member(host, &member, fields)? {
        Some(updated) => Ok(updated),
        None => coded("member_not_found", "memberId names no household member"),
    })
}

fn remove_member<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        input::no_unknown_keys(input, &["memberId"])?;
        Ok(input::uuid(input, "memberId", true)?.unwrap_or_default())
    })();
    let member = match checked {
        Ok(member) => member,
        Err(error) => return Ok(Err(error)),
    };
    let current = kitchen::view(host)?;
    let is_self = current["members"].as_array().is_some_and(|all| {
        all.iter()
            .any(|m| m["memberId"] == member && m["isSelf"] == true)
    });
    if is_self {
        return Ok(coded("self_member", "the self member cannot be removed"));
    }
    Ok(Ok(
        json!({"removed": kitchen::remove_member(host, &member)?}),
    ))
}

pub fn handle<H: Host + ?Sized>(host: &H, req: Request) -> Result<Value> {
    Ok(match call(host, &req.tool, &req.parameters)? {
        Ok(data) => json!({"data":data}),
        Err(error) => failure(error),
    })
}

/// Signed-in transport for chat hosts. This crosses the host's one-use, exact-input approval
/// boundary; it must never call `handle` directly or accept an approval flag from the caller.
pub fn run<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response> {
    let req: Request = match serde_json::from_value(body.clone()) {
        Ok(req) => req,
        Err(_) => return Ok(util::bad_request("Invalid Meals tool request")),
    };
    if !TOOLS.contains(&req.tool.as_str()) || !req.parameters.is_object() {
        return Ok(util::bad_request("Invalid Meals tool input"));
    }
    match host.call(
        "tools",
        "run",
        &req.tool,
        json!({"parameters":req.parameters}),
    ) {
        Ok(result) => Ok(Response::new(200, result)),
        Err(_) => Ok(util::error(
            403,
            "Meals tool unavailable or approval required",
        )),
    }
}
