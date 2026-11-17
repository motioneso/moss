//! The plan-day queue handler. One job writes one day, saving each meal as it finishes, then
//! queues the next pending day while the plan is active. A job carries ids and a generation
//! only; the handler reads whatever else it needs while it runs.
use crate::draft::{draft_safe_recipe, Ask, Model, Outcome, Person, Reason};
use crate::pantry::{Input as PantryInput, Stock};
use crate::plans::{enqueue_day, PLAN_DAY_QUEUE};
use crate::rules::{add_days, portion_for};
use crate::safety::Verdict;
use crate::store::{self, num, text, EaterRow, NewRecipe};
use crate::{input, kitchen, view};
use moss_module_sdk::{query::{Filter, Order, Query}, Client, Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const NO_REPEAT_DAYS: i64 = 7;
const MAX_OUTPUT_TOKENS: u32 = 4096;
const PANTRY_ITEMS: &str = "app.meals_pantry_items";
const STAPLES: &str = "app.meals_staples";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Value,
}

/// Asks the model through the host. Any failure leaves as a provider error.
pub(crate) struct AiModel<'a, H: Host + ?Sized>(pub(crate) &'a H);

impl<H: Host + ?Sized> Model for AiModel<'_, H> {
    fn ask(&mut self, prompt: &str) -> std::result::Result<String, Reason> {
        let answer = self
            .0
            .call(
                "ai",
                "generate",
                "structured",
                json!({"prompt": prompt, "maxOutputTokens": MAX_OUTPUT_TOKENS}),
            )
            .map_err(|_| "provider_error")?;
        answer["text"]
            .as_str()
            .map(str::to_owned)
            .ok_or("provider_error")
    }
}

#[derive(Debug, PartialEq)]
pub enum DayOutcome {
    Stale,
    Stopped,
    Missing,
    Written { ready: bool },
}

fn verdict_row(eater: &Value, verdict: Option<&Verdict>) -> EaterRow {
    let (safety, reason) = match verdict {
        Some(Verdict::Pass) => ("pass", None),
        Some(Verdict::Fail(reason)) => ("fail", Some(reason.clone())),
        None => (eater["safety"].as_str().unwrap_or("pending"), None),
    };
    EaterRow {
        member_id: text(eater, "member_id"),
        portion: num(&eater["portion"]).unwrap_or(1.0),
        estimated_kcal: eater["estimated_kcal"].as_i64(),
        safety: safety.to_owned(),
        safety_reason: reason,
    }
}

fn read_pantry<H: Host + ?Sized>(host: &H, mode: &str) -> Result<PantryInput> {
    let client = Client(host);
    let mut query = Query::select(Filter::All);
    query.order = vec![Order { column: "name_key".into(), descending: false }];
    let items = client.query(PANTRY_ITEMS, &query)?;
    let staples = client.query(STAPLES, &query)?;
    Ok(PantryInput {
        only: mode == "only",
        stock: items
            .iter()
            .map(|i| Stock {
                name: text(i, "name"),
                quantity: num(&i["quantity"]),
                unit: i["unit"].as_str().map(str::to_owned),
            })
            .collect(),
        staples: staples.iter().map(|s| text(s, "name")).collect(),
    })
}

struct DayContext<'a> {
    plan: &'a Value,
    day: &'a Value,
    generation: i64,
    kitchen: Value,
    avoid_titles: Vec<String>,
    recent_keys: HashSet<String>,
    pantry: Option<PantryInput>,
}

enum MealOutcome {
    Ready { title: String, key: String },
    ProviderFailure(Reason),
    SafetyCap,
    Lost,
}

fn write_meal<H: Host + ?Sized>(host: &H, c: &DayContext, meal: &Value) -> Result<MealOutcome> {
    let members = view::members_by_id(&c.kitchen);
    let slot = text(meal, "slot_name");
    let eaters = meal["eaters"].as_array().cloned().unwrap_or_default();
    let people: Vec<Option<Person>> = eaters
        .iter()
        .map(|e| {
            let member = members.get(e["member_id"].as_str().unwrap_or_default())?;
            let list = |key: &str| -> Vec<String> {
                member[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
            };
            Some(Person {
                restrictions: list("restrictions"),
                preferences: list("preferences"),
                share_kcal: view::share_kcal(member, &slot),
            })
        })
        .collect();
    let no_vetoes = HashSet::new();
    let ask = Ask {
        slot_name: &slot,
        date: &text(c.day, "day_date"),
        people: &people,
        cook_time_limit: c.day["cook_time_limit_minutes"].as_i64(),
        request_text: c.plan["request_text"].as_str(),
        avoid_titles: &c.avoid_titles,
        recent_keys: &c.recent_keys,
        vetoed_keys: &no_vetoes,
        allow_repeats: c.plan["allow_repeats"] == true,
        metric: c.kitchen["unitsSystem"] == "metric",
        pantry: c.pantry.as_ref(),
    };
    let meal_id = text(meal, "meal_id");
    let day_id = text(c.day, "day_id");
    match draft_safe_recipe(&mut AiModel(host), &ask) {
        Outcome::Failed { reason, attempts, verdicts } => {
            let rows: Option<Vec<EaterRow>> = verdicts.as_ref().map(|v| {
                eaters.iter().enumerate().map(|(i, e)| verdict_row(e, v.get(i))).collect()
            });
            store::fail_meal(host, &meal_id, attempts as i64, reason, rows.as_deref())?;
            Ok(if reason == "safety_cap" { MealOutcome::SafetyCap } else { MealOutcome::ProviderFailure(reason) })
        }
        Outcome::Ready { draft, key, verdicts, attempts } => {
            // Calories per serving stay empty until the estimator part, so every portion is 1.
            let rows: Vec<EaterRow> = eaters
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let share = people.get(i).and_then(Option::as_ref).and_then(|p| p.share_kcal);
                    EaterRow { portion: portion_for(share, None), ..verdict_row(e, verdicts.get(i)) }
                })
                .collect();
            let recipe = NewRecipe {
                recipe_id: host.call("context", "uuid", "new", json!({}))?["id"].as_str().unwrap_or_default().to_owned(),
                title: draft.title.clone(),
                title_key: key.clone(),
                steps: draft.steps.clone(),
                cook_minutes: draft.cook_minutes,
                base_servings: draft.base_servings,
                kcal_per_serving: None,
                ingredients: draft.ingredients.clone(),
            };
            let saved = store::save_meal_ready(
                host, &day_id, &meal_id, c.generation, attempts as i64,
                &text(c.plan, "kitchen_id"), &recipe, &rows,
            )?;
            Ok(if saved { MealOutcome::Ready { title: draft.title, key } } else { MealOutcome::Lost })
        }
    }
}

enum DayWrite {
    Done(Option<&'static str>),
    Stale,
    Stopped,
}

/// Writes every unfinished meal. Returns the day's failure, or the reason it stopped early.
fn write_day<H: Host + ?Sized>(host: &H, c: &mut DayContext) -> Result<DayWrite> {
    let plan_id = text(c.plan, "plan_id");
    let day_id = text(c.day, "day_id");
    let mut failure = None;
    for meal in store::list_day_meals(host, &day_id)? {
        if meal["status"] == "ready" || meal["locked"] == true {
            continue;
        }
        if !store::claim_meal(host, &plan_id, &text(&meal, "meal_id"), &day_id, c.generation)? {
            let active = store::get_plan(host, &plan_id)?.is_some_and(|p| p["state"] == "active");
            return Ok(if active { DayWrite::Stale } else { DayWrite::Stopped });
        }
        match write_meal(host, c, &meal)? {
            MealOutcome::Lost => return Ok(DayWrite::Stale),
            MealOutcome::Ready { title, key } => {
                c.recent_keys.insert(key);
                c.avoid_titles.push(title);
            }
            // The provider is failing; the rest of the day waits for a retry.
            MealOutcome::ProviderFailure(reason) => return Ok(DayWrite::Done(Some(reason))),
            MealOutcome::SafetyCap => failure = failure.or(Some("safety_cap")),
        }
    }
    Ok(DayWrite::Done(failure))
}

pub fn run_plan_day<H: Host + ?Sized>(host: &H, params: &Value) -> Result<DayOutcome> {
    let id = |key: &str| params[key].as_str().filter(|s| input::is_uuid(s));
    let (Some(plan_id), Some(day_id), Some(generation)) =
        (id("plan-id"), id("day-id"), params["generation"].as_i64().filter(|g| *g >= 1))
    else {
        return Err(Error::new("Invalid plan-day job"));
    };
    let (Some(plan), Some(day)) = (store::get_plan(host, plan_id)?, store::get_day(host, day_id)?) else {
        return Ok(DayOutcome::Missing);
    };
    if day["plan_id"] != plan_id {
        return Ok(DayOutcome::Missing);
    }
    if day["generation"].as_i64() != Some(generation) {
        return Ok(DayOutcome::Stale);
    }
    if plan["state"] != "active" {
        return Ok(DayOutcome::Stopped);
    }
    let mut ready = true;
    let mut provider_down = false;
    if day["status"] != "ready" {
        if !store::claim_day(host, &day, generation)? {
            return Ok(DayOutcome::Stale);
        }
        let date = text(&day, "day_date");
        let recent = if plan["allow_repeats"] == true {
            vec![]
        } else {
            store::recent_titles(host, &add_days(&date, -NO_REPEAT_DAYS).unwrap_or(date.clone()), &date)?
        };
        // A regenerated meal keeps its old recipe until the new one is saved. Writing the same
        // dish again would make Regenerate look like it did nothing.
        let replaced_ids: Vec<String> = store::list_day_meals(host, day_id)?
            .iter()
            .filter(|m| m["status"] != "ready")
            .filter_map(|m| m["recipe_id"].as_str().map(str::to_owned))
            .collect();
        let replaced: Vec<(String, String)> = store::get_recipes(host, &replaced_ids)?
            .iter()
            .map(|r| (text(r, "title"), text(r, "title_key")))
            .collect();
        let avoid: Vec<&(String, String)> = recent.iter().chain(replaced.iter()).collect();
        let mode = text(&plan, "pantry_mode");
        let mut context = DayContext {
            plan: &plan,
            day: &day,
            generation,
            kitchen: kitchen::view(host)?,
            avoid_titles: avoid.iter().map(|e| e.0.clone()).collect(),
            recent_keys: avoid.iter().map(|e| e.1.clone()).collect(),
            pantry: if mode == "ignore" { None } else { Some(read_pantry(host, &mode)?) },
        };
        match write_day(host, &mut context)? {
            DayWrite::Stale => return Ok(DayOutcome::Stale),
            DayWrite::Stopped => {
                store::finish_day(host, day_id, generation, "pending", None)?;
                return Ok(DayOutcome::Stopped);
            }
            DayWrite::Done(failure) => {
                ready = failure.is_none();
                provider_down = failure == Some("provider_error");
                store::finish_day(host, day_id, generation, if ready { "ready" } else { "failed" }, failure)?;
                crate::shopping::on_plan_change(host, plan_id)?;
            }
        }
    }
    let active = store::get_plan(host, plan_id)?.is_some_and(|p| p["state"] == "active");
    // A provider outage would fail every later day too, so the chain waits for a retry.
    if active && !provider_down {
        let days = store::list_days(host, plan_id)?;
        if let Some(next) = days.iter().find(|d| d["status"] == "pending") {
            enqueue_day(host, plan_id, &text(next, "day_id"))?;
        }
    }
    Ok(DayOutcome::Written { ready })
}

/// Runs one job. The reply is an empty object, because a job never returns text.
pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    match job.queue.as_str() {
        PLAN_DAY_QUEUE => {
            run_plan_day(host, &job.parameters)?;
        }
        crate::log::LOG_ESTIMATE_QUEUE => {
            crate::log::run_estimate(host, &job.parameters)?;
        }
        _ => return Err(Error::new("Unknown Meals job")),
    }
    Ok("{}".into())
}
