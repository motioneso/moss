//! Builds the plan view from stored rows and the kitchen view. Pure, so it reads the same
//! wherever the rows came from.
use crate::rules::calorie_band;
use crate::store::{num, text};
use serde_json::{json, Value};
use std::collections::HashMap;

const REMOVED_MEMBER: &str = "Removed member";

/// Members of the kitchen view, by id.
pub fn members_by_id(kitchen: &Value) -> HashMap<String, &Value> {
    kitchen["members"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|m| m["memberId"].as_str().map(|id| (id.to_owned(), m)))
                .collect()
        })
        .unwrap_or_default()
}

/// An even split of the daily target over the member's meal pattern, when the slot is theirs.
pub fn share_kcal(member: &Value, slot: &str) -> Option<i64> {
    let target = member["calorieTarget"].as_i64()?;
    let pattern = member["mealPattern"].as_array()?;
    if !pattern.iter().any(|s| s == slot) {
        return None;
    }
    Some((target as f64 / pattern.len() as f64).round() as i64)
}

fn fit(target: i64, estimated: i64) -> Value {
    let (band, difference) = calorie_band(target, estimated);
    json!({"targetKcal":target,"estimatedKcal":estimated,"band":band,"differenceKcal":difference})
}

fn eater_view(eater: &Value, slot: &str, members: &HashMap<String, &Value>) -> Value {
    let person = eater["member_id"].as_str().and_then(|id| members.get(id));
    let share = person.and_then(|p| share_kcal(p, slot));
    let estimated = eater["estimated_kcal"].as_i64();
    json!({
        "memberId": eater["member_id"],
        "name": person.map_or(json!(REMOVED_MEMBER), |p| p["name"].clone()),
        "portion": num(&eater["portion"]).unwrap_or(1.0),
        "safety": eater["safety"],
        "safetyReason": eater["safety_reason"],
        "fit": match (share, estimated) { (Some(s), Some(e)) => fit(s, e), _ => Value::Null },
        "rating": null,
        "favourite": false
    })
}

pub fn meal_view(meal: &Value, recipe: Option<&Value>, members: &HashMap<String, &Value>) -> Value {
    let slot = meal["slot_name"].as_str().unwrap_or_default();
    let eaters: Vec<Value> = meal["eaters"]
        .as_array()
        .map(|all| all.iter().map(|e| eater_view(e, slot, members)).collect())
        .unwrap_or_default();
    let servings = num(&meal["servings_override"]).unwrap_or_else(|| {
        eaters
            .iter()
            .map(|e| e["portion"].as_f64().unwrap_or(0.0))
            .sum()
    });
    let check_labels = recipe
        .and_then(|r| r["ingredients"].as_array())
        .map_or(0, |lines| lines.iter().filter(|l| l["check_label"] == true).count());
    json!({
        "mealId": meal["meal_id"],
        "slotName": meal["slot_name"],
        "kind": meal["kind"],
        "sharing": meal["sharing"],
        "status": meal["status"],
        "failureReason": meal["failure_reason"],
        "locked": meal["locked"],
        "oneOffFor": meal["one_off_for"],
        "favouriteOf": meal["favourite_of"],
        "title": recipe.map_or(Value::Null, |r| r["title"].clone()),
        "plainText": meal["plain_text"],
        "cookMinutes": recipe.map_or(Value::Null, |r| r["cook_minutes"].clone()),
        "servings": servings,
        "eaters": eaters,
        "checkLabelCount": check_labels,
        "cookedAt": meal["cooked_at"],
        "quickMaxMinutes": meal["quick_max_minutes"]
    })
}

/// A member's day total against their target, once every meal they eat that day has an estimate.
fn day_fit(meals: &[Value], members: &HashMap<String, &Value>) -> Vec<Value> {
    let mut totals: Vec<(String, i64, bool)> = vec![];
    for meal in meals {
        for eater in meal["eaters"].as_array().into_iter().flatten() {
            let id = text(eater, "memberId");
            let at = totals.iter().position(|t| t.0 == id).unwrap_or_else(|| {
                totals.push((id.clone(), 0, true));
                totals.len() - 1
            });
            match (meal["status"] == "ready", eater["fit"]["estimatedKcal"].as_i64()) {
                (true, Some(kcal)) => totals[at].1 += kcal,
                _ => totals[at].2 = false,
            }
        }
    }
    totals
        .into_iter()
        .filter_map(|(id, kcal, complete)| {
            let target = members.get(&id)?["calorieTarget"].as_i64()?;
            complete.then(|| json!({"memberId":id,"fit":fit(target,kcal)}))
        })
        .collect()
}

/// A meal a Regenerate may replace: an uncooked, unlocked recipe meal that is ready or failed.
pub fn is_replaceable(meal: &Value) -> bool {
    meal["kind"] == "recipe"
        && meal["locked"] == false
        && meal["cooked_at"].is_null()
        && matches!(meal["status"].as_str(), Some("ready" | "failed"))
}

pub fn plan_view(
    plan: &Value,
    days: &[Value],
    meals: &[Value],
    recipes: &[Value],
    kitchen: &Value,
) -> Value {
    let members = members_by_id(kitchen);
    let recipe_of = |meal: &Value| {
        meal["recipe_id"]
            .as_str()
            .and_then(|id| recipes.iter().find(|r| r["recipe_id"] == id))
    };
    let day_views: Vec<Value> = days
        .iter()
        .map(|day| {
            let mine: Vec<Value> = meals
                .iter()
                .filter(|m| m["day_id"] == day["day_id"])
                .map(|m| meal_view(m, recipe_of(m), &members))
                .collect();
            let fits = day_fit(&mine, &members);
            json!({
                "dayId": day["day_id"],
                "date": day["day_date"],
                "status": day["status"],
                "failureReason": day["failure_reason"],
                "cookTimeLimitMinutes": day["cook_time_limit_minutes"],
                "meals": mine,
                "dayFit": fits
            })
        })
        .collect();
    json!({
        "planId": plan["plan_id"],
        "startDate": plan["start_date"],
        "dayCount": plan["day_count"],
        "pantryMode": plan["pantry_mode"],
        "state": plan["state"],
        "pausedReason": plan["paused_reason"],
        "progress": {
            "ready": days.iter().filter(|d| d["status"] == "ready").count(),
            "total": days.len()
        },
        "replaceable": meals.iter().filter(|m| is_replaceable(m)).count(),
        "days": day_views
    })
}
