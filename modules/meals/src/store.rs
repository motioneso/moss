//! Plans, days, meals, eaters and recipes over the host's typed database port. The port has no
//! transactions and no joins, so a write that must not race is an update guarded by the
//! generation or status it expects, and a multi-row write is a series of idempotent inserts.
use crate::util::{context, values};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

pub const PLANS: &str = "app.meals_plans";
pub const DAYS: &str = "app.meals_plan_days";
pub const MEALS: &str = "app.meals_planned_meals";
pub const EATERS: &str = "app.meals_planned_meal_eaters";
pub const SWAP_CHOICES: &str = "app.meals_swap_choices";
pub const RECIPES: &str = "app.meals_recipes";
pub const INGREDIENTS: &str = "app.meals_recipe_ingredients";

pub(crate) fn asc(column: &str) -> Order {
    Order {
        column: column.into(),
        descending: false,
    }
}

pub(crate) fn desc(column: &str) -> Order {
    Order {
        column: column.into(),
        descending: true,
    }
}

/// A numeric column as a number, whether the host sends it as a number or as text.
pub fn num(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

pub fn text(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or_default().to_owned()
}

fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

pub(crate) fn in_list(column: &str, ids: &[String]) -> Filter {
    Filter::In {
        column: column.into(),
        values: ids.iter().map(|i| json!(i)).collect(),
    }
}

pub(crate) fn select<H: Host + ?Sized>(host: &H, table: &str, query: Query) -> Result<Vec<Value>> {
    Client(host).query(table, &query)
}

pub(crate) fn find<H: Host + ?Sized>(host: &H, table: &str, filter: Filter) -> Result<Option<Value>> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(select(host, table, query)?.into_iter().next())
}

/// True when the update touched a row, so a guard that no longer holds reads as false.
pub(crate) fn update<H: Host + ?Sized>(
    host: &H,
    table: &str,
    filter: Filter,
    set: Vec<(&str, Value)>,
) -> Result<bool> {
    let mut set = set;
    set.push(("updated_at", json!(context(host)?.1)));
    Ok(!Client(host)
        .query(table, &Query::update(filter, values(set)))?
        .is_empty())
}

pub(crate) fn insert_ignore<H: Host + ?Sized>(
    host: &H,
    table: &str,
    fields: Vec<(&str, Value)>,
) -> Result<Vec<Value>> {
    let mut query = Query::insert(values(fields));
    query.conflict = Conflict::Ignore;
    Client(host).query(table, &query)
}

pub struct NewPlan {
    pub plan_id: String,
    pub kitchen_id: String,
    pub start_date: String,
    pub day_count: i64,
    pub pantry_mode: String,
    pub request_text: Option<String>,
    pub allow_repeats: bool,
    pub idempotency_key: String,
    /// (day id, date)
    pub days: Vec<(String, String)>,
    pub meals: Vec<NewMeal>,
}

pub struct NewMeal {
    pub meal_id: String,
    pub day_id: String,
    pub slot_name: String,
    pub slot_position: i64,
    pub shared: bool,
    pub eater_ids: Vec<String>,
}

pub fn find_plan_by_key<H: Host + ?Sized>(host: &H, key: &str) -> Result<Option<String>> {
    Ok(find(host, PLANS, Filter::eq("idempotency_key", key))?.map(|r| text(&r, "plan_id")))
}

/// Stores the plan with its days, meals and eaters. Every insert ignores a repeat, so asking
/// again with the same key finishes a plan an earlier call left half written. Returns the plan
/// id and whether this call created the plan row.
pub fn create_plan<H: Host + ?Sized>(host: &H, plan: &NewPlan) -> Result<(String, bool)> {
    let created = !insert_ignore(
        host,
        PLANS,
        vec![
            ("kitchen_id", json!(plan.kitchen_id)),
            ("plan_id", json!(plan.plan_id)),
            ("start_date", json!(plan.start_date)),
            ("day_count", json!(plan.day_count)),
            ("pantry_mode", json!(plan.pantry_mode)),
            ("request_text", json!(plan.request_text)),
            ("allow_repeats", json!(plan.allow_repeats)),
            ("idempotency_key", json!(plan.idempotency_key)),
        ],
    )?
    .is_empty();
    let plan_id = find_plan_by_key(host, &plan.idempotency_key)?
        .ok_or_else(|| Error::new("Plan not visible after insert"))?;
    if !created {
        // A winner already stored it. The winner's days and meals use the winner's ids.
        return Ok((plan_id, false));
    }
    for (day_id, date) in &plan.days {
        insert_ignore(
            host,
            DAYS,
            vec![
                ("kitchen_id", json!(plan.kitchen_id)),
                ("plan_id", json!(plan_id)),
                ("day_id", json!(day_id)),
                ("day_date", json!(date)),
                ("generation", json!(0)),
            ],
        )?;
    }
    for meal in &plan.meals {
        insert_ignore(
            host,
            MEALS,
            vec![
                ("kitchen_id", json!(plan.kitchen_id)),
                ("day_id", json!(meal.day_id)),
                ("meal_id", json!(meal.meal_id)),
                ("slot_name", json!(meal.slot_name)),
                ("slot_position", json!(meal.slot_position)),
                ("kind", json!("recipe")),
                ("sharing", json!(if meal.shared { "shared" } else { "solo" })),
            ],
        )?;
        for member in &meal.eater_ids {
            insert_ignore(
                host,
                EATERS,
                vec![
                    ("kitchen_id", json!(plan.kitchen_id)),
                    ("meal_id", json!(meal.meal_id)),
                    ("member_id", json!(member)),
                ],
            )?;
        }
    }
    Ok((plan_id, true))
}

pub fn get_plan<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<Option<Value>> {
    find(host, PLANS, Filter::eq("plan_id", plan_id))
}

/// The newest plan whose days include the date.
pub fn find_plan_by_date<H: Host + ?Sized>(host: &H, date: &str) -> Result<Option<String>> {
    let mut query = Query::select(Filter::eq("day_date", date));
    query.order = vec![desc("created_at")];
    query.limit = Some(1);
    Ok(select(host, DAYS, query)?
        .first()
        .map(|d| text(d, "plan_id")))
}

/// The plan the Plan tab shows: one covering the date, else the next to start, else the newest.
pub fn find_current_plan<H: Host + ?Sized>(host: &H, date: &str) -> Result<Option<String>> {
    if let Some(id) = find_plan_by_date(host, date)? {
        return Ok(Some(id));
    }
    let mut query = Query::select(Filter::Compare {
        column: "start_date".into(),
        op: moss_module_sdk::query::Compare::Gt,
        value: json!(date),
    });
    query.order = vec![asc("start_date"), desc("created_at")];
    query.limit = Some(1);
    if let Some(row) = select(host, PLANS, query)?.first() {
        return Ok(Some(text(row, "plan_id")));
    }
    let mut query = Query::select(Filter::All);
    query.order = vec![desc("start_date"), desc("created_at")];
    query.limit = Some(1);
    Ok(select(host, PLANS, query)?
        .first()
        .map(|r| text(r, "plan_id")))
}

pub fn set_plan_state<H: Host + ?Sized>(
    host: &H,
    plan_id: &str,
    state: &str,
    paused_reason: Option<&str>,
) -> Result<()> {
    update(
        host,
        PLANS,
        Filter::eq("plan_id", plan_id),
        vec![("state", json!(state)), ("paused_reason", json!(paused_reason))],
    )?;
    Ok(())
}

pub fn set_plan_pantry_mode<H: Host + ?Sized>(host: &H, plan_id: &str, mode: &str) -> Result<()> {
    update(
        host,
        PLANS,
        Filter::eq("plan_id", plan_id),
        vec![("pantry_mode", json!(mode))],
    )?;
    Ok(())
}

/// Days, meals, eaters and swap choices follow by the tables' cascading foreign keys.
pub fn delete_plan<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<bool> {
    Ok(!Client(host)
        .query(PLANS, &Query::delete(Filter::eq("plan_id", plan_id)))?
        .is_empty())
}

pub fn list_days<H: Host + ?Sized>(host: &H, plan_id: &str) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::eq("plan_id", plan_id));
    query.order = vec![asc("day_date")];
    select(host, DAYS, query)
}

pub fn get_day<H: Host + ?Sized>(host: &H, day_id: &str) -> Result<Option<Value>> {
    find(host, DAYS, Filter::eq("day_id", day_id))
}

/// Raises the day's generation, sets it pending and resets its failed meals to pending. Ready
/// meals are never touched. The raise is guarded by the generation it read, so two callers
/// cannot both take the same number. None for a missing day.
pub fn bump_day<H: Host + ?Sized>(host: &H, day_id: &str) -> Result<Option<i64>> {
    for _ in 0..5 {
        let Some(day) = get_day(host, day_id)? else {
            return Ok(None);
        };
        let current = day["generation"].as_i64().unwrap_or(0);
        let next = current + 1;
        if update(
            host,
            DAYS,
            and(vec![
                Filter::eq("day_id", day_id),
                Filter::eq("generation", current),
            ]),
            vec![
                ("generation", json!(next)),
                ("status", json!("pending")),
                ("failure_reason", Value::Null),
            ],
        )? {
            update(
                host,
                MEALS,
                and(vec![
                    Filter::eq("day_id", day_id),
                    Filter::eq("status", "failed"),
                ]),
                vec![("status", json!("pending")), ("failure_reason", Value::Null)],
            )?;
            return Ok(Some(next));
        }
    }
    Err(Error::new("Day generation kept changing"))
}

/// Sets a pending or failed day to writing when the generation matches and no other day in the
/// plan is writing, so a plan writes one day at a time.
pub fn claim_day<H: Host + ?Sized>(host: &H, day: &Value, generation: i64) -> Result<bool> {
    let plan_id = text(day, "plan_id");
    let day_id = text(day, "day_id");
    let busy = list_days(host, &plan_id)?
        .iter()
        .any(|d| d["status"] == "writing" && text(d, "day_id") != day_id);
    if busy {
        return Ok(false);
    }
    for status in ["pending", "failed"] {
        if update(
            host,
            DAYS,
            and(vec![
                Filter::eq("day_id", day_id.as_str()),
                Filter::eq("generation", generation),
                Filter::eq("status", status),
            ]),
            vec![("status", json!("writing"))],
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn finish_day<H: Host + ?Sized>(
    host: &H,
    day_id: &str,
    generation: i64,
    status: &str,
    failure: Option<&str>,
) -> Result<bool> {
    update(
        host,
        DAYS,
        and(vec![
            Filter::eq("day_id", day_id),
            Filter::eq("generation", generation),
        ]),
        vec![("status", json!(status)), ("failure_reason", json!(failure))],
    )
}

pub fn set_day_cook_limit<H: Host + ?Sized>(
    host: &H,
    day_id: &str,
    minutes: Option<i64>,
) -> Result<bool> {
    update(
        host,
        DAYS,
        Filter::eq("day_id", day_id),
        vec![("cook_time_limit_minutes", json!(minutes))],
    )
}

/// Every meal row of the given days with its eaters, by slot position then creation.
pub fn meals_of_days<H: Host + ?Sized>(host: &H, day_ids: &[String]) -> Result<Vec<Value>> {
    if day_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut query = Query::select(in_list("day_id", day_ids));
    query.order = vec![asc("slot_position"), asc("created_at"), asc("meal_id")];
    let mut meals = select(host, MEALS, query)?;
    let ids: Vec<String> = meals.iter().map(|m| text(m, "meal_id")).collect();
    let mut eaters = if ids.is_empty() {
        vec![]
    } else {
        let mut query = Query::select(in_list("meal_id", &ids));
        query.order = vec![asc("created_at"), asc("member_id")];
        select(host, EATERS, query)?
    };
    eaters.sort_by_key(|e| text(e, "created_at"));
    for meal in &mut meals {
        let mine: Vec<Value> = eaters
            .iter()
            .filter(|e| e["meal_id"] == meal["meal_id"])
            .cloned()
            .collect();
        meal["eaters"] = Value::Array(mine);
    }
    Ok(meals)
}

pub fn list_day_meals<H: Host + ?Sized>(host: &H, day_id: &str) -> Result<Vec<Value>> {
    meals_of_days(host, &[day_id.to_owned()])
}

pub fn get_meal<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<Option<Value>> {
    let Some(meal) = find(host, MEALS, Filter::eq("meal_id", meal_id))? else {
        return Ok(None);
    };
    Ok(meals_of_days(host, &[text(&meal, "day_id")])?
        .into_iter()
        .find(|m| m["meal_id"] == meal["meal_id"]))
}

/// Sets a not-ready, unlocked meal to writing when the day's generation matches and the plan is
/// active. This is the Stop check before each meal.
pub fn claim_meal<H: Host + ?Sized>(
    host: &H,
    plan_id: &str,
    meal_id: &str,
    day_id: &str,
    generation: i64,
) -> Result<bool> {
    let active = get_plan(host, plan_id)?.is_some_and(|p| p["state"] == "active");
    let current = get_day(host, day_id)?.and_then(|d| d["generation"].as_i64());
    if !active || current != Some(generation) {
        return Ok(false);
    }
    for status in ["pending", "failed"] {
        if update(
            host,
            MEALS,
            and(vec![
                Filter::eq("meal_id", meal_id),
                Filter::eq("status", status),
                Filter::eq("locked", false),
            ]),
            vec![("status", json!("writing")), ("failure_reason", Value::Null)],
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub struct EaterRow {
    pub member_id: String,
    pub portion: f64,
    pub estimated_kcal: Option<i64>,
    pub safety: String,
    pub safety_reason: Option<String>,
}

pub struct NewRecipe {
    pub recipe_id: String,
    pub title: String,
    pub title_key: String,
    pub steps: Vec<String>,
    pub cook_minutes: i64,
    pub base_servings: f64,
    pub kcal_per_serving: Option<i64>,
    pub ingredients: Vec<crate::recipe::Ingredient>,
}

pub(crate) fn store_recipe<H: Host + ?Sized>(host: &H, kitchen_id: &str, r: &NewRecipe) -> Result<()> {
    insert_ignore(
        host,
        RECIPES,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("recipe_id", json!(r.recipe_id)),
            ("title", json!(r.title)),
            ("title_key", json!(r.title_key)),
            ("steps", json!(r.steps)),
            ("cook_minutes", json!(r.cook_minutes)),
            ("base_servings", json!(r.base_servings)),
            ("kcal_per_serving", json!(r.kcal_per_serving)),
            ("source", json!("generated")),
        ],
    )?;
    for (position, line) in r.ingredients.iter().enumerate() {
        insert_ignore(
            host,
            INGREDIENTS,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("recipe_id", json!(r.recipe_id)),
                ("position", json!(position)),
                ("original_text", json!(line.original_text)),
                ("name", json!(line.name)),
                ("name_key", json!(crate::rules::title_key(&line.name))),
                ("quantity", json!(line.quantity)),
                ("unit", json!(line.unit)),
                ("store_section", json!(line.section)),
                ("check_label", json!(line.check_label)),
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn write_eaters<H: Host + ?Sized>(host: &H, meal_id: &str, eaters: &[EaterRow]) -> Result<()> {
    for eater in eaters {
        update(
            host,
            EATERS,
            and(vec![
                Filter::eq("meal_id", meal_id),
                Filter::eq("member_id", eater.member_id.as_str()),
            ]),
            vec![
                ("portion", json!(eater.portion)),
                ("estimated_kcal", json!(eater.estimated_kcal)),
                ("safety", json!(eater.safety)),
                ("safety_reason", json!(eater.safety_reason)),
            ],
        )?;
    }
    Ok(())
}

/// Saves the recipe, its ingredients, the eaters and the ready meal. The meal row flips last,
/// guarded by the day's generation and the writing status, so a stale job saves nothing that
/// the meal points to. The recipe rows a stale job stored are orphans and are deleted.
pub fn save_meal_ready<H: Host + ?Sized>(
    host: &H,
    day_id: &str,
    meal_id: &str,
    generation: i64,
    attempts: i64,
    kitchen_id: &str,
    recipe: &NewRecipe,
    eaters: &[EaterRow],
) -> Result<bool> {
    let current = get_day(host, day_id)?.and_then(|d| d["generation"].as_i64());
    if current != Some(generation) {
        return Ok(false);
    }
    store_recipe(host, kitchen_id, recipe)?;
    let saved = update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id),
            Filter::eq("status", "writing"),
        ]),
        vec![
            ("recipe_id", json!(recipe.recipe_id)),
            ("status", json!("ready")),
            ("failure_reason", Value::Null),
            ("attempts", json!(attempts)),
        ],
    )?;
    if saved {
        write_eaters(host, meal_id, eaters)?;
    } else {
        Client(host).query(
            RECIPES,
            &Query::delete(Filter::eq("recipe_id", recipe.recipe_id.as_str())),
        )?;
    }
    Ok(saved)
}

pub fn fail_meal<H: Host + ?Sized>(
    host: &H,
    meal_id: &str,
    attempts: i64,
    reason: &str,
    eaters: Option<&[EaterRow]>,
) -> Result<bool> {
    if let Some(eaters) = eaters {
        write_eaters(host, meal_id, eaters)?;
    }
    update(
        host,
        MEALS,
        and(vec![
            Filter::eq("meal_id", meal_id),
            Filter::eq("status", "writing"),
        ]),
        vec![
            ("status", json!("failed")),
            ("failure_reason", json!(reason)),
            ("attempts", json!(attempts)),
        ],
    )
}

/// Sets the replaceable meals among `meal_ids` back to pending. Returns how many it reset.
/// Their recipes stay stored.
pub fn reset_meals<H: Host + ?Sized>(host: &H, meal_ids: &[String]) -> Result<usize> {
    let mut count = 0;
    for id in meal_ids {
        for status in ["ready", "failed"] {
            if update(
                host,
                MEALS,
                and(vec![
                    Filter::eq("meal_id", id.as_str()),
                    Filter::eq("kind", "recipe"),
                    Filter::eq("locked", false),
                    Filter::eq("status", status),
                    Filter::Null {
                        column: "cooked_at".into(),
                        not: false,
                    },
                ]),
                vec![("status", json!("pending")), ("failure_reason", Value::Null)],
            )? {
                count += 1;
                break;
            }
        }
    }
    Ok(count)
}

pub fn get_recipes<H: Host + ?Sized>(host: &H, ids: &[String]) -> Result<Vec<Value>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut recipes = select(host, RECIPES, Query::select(in_list("recipe_id", ids)))?;
    let mut query = Query::select(in_list("recipe_id", ids));
    query.order = vec![asc("position")];
    let lines = select(host, INGREDIENTS, query)?;
    for recipe in &mut recipes {
        let mine: Vec<Value> = lines
            .iter()
            .filter(|l| l["recipe_id"] == recipe["recipe_id"])
            .cloned()
            .collect();
        recipe["ingredients"] = Value::Array(mine);
    }
    Ok(recipes)
}

/// (title, title key) of ready meals in the kitchen on days from `from` to `to`, inclusive.
pub fn recent_titles<H: Host + ?Sized>(
    host: &H,
    from: &str,
    to: &str,
) -> Result<Vec<(String, String)>> {
    let days = select(
        host,
        DAYS,
        Query::select(and(vec![
            Filter::Compare {
                column: "day_date".into(),
                op: moss_module_sdk::query::Compare::Ge,
                value: json!(from),
            },
            Filter::Compare {
                column: "day_date".into(),
                op: moss_module_sdk::query::Compare::Le,
                value: json!(to),
            },
        ])),
    )?;
    let day_ids: Vec<String> = days.iter().map(|d| text(d, "day_id")).collect();
    let recipe_ids: Vec<String> = meals_of_days(host, &day_ids)?
        .iter()
        .filter(|m| m["status"] == "ready")
        .filter_map(|m| m["recipe_id"].as_str().map(str::to_owned))
        .collect();
    Ok(get_recipes(host, &recipe_ids)?
        .iter()
        .map(|r| (text(r, "title"), text(r, "title_key")))
        .collect())
}

/// The swap choices stored for a meal, by position.
pub fn list_swap_choices<H: Host + ?Sized>(host: &H, meal_id: &str) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::eq("meal_id", meal_id));
    query.order = vec![asc("position")];
    select(host, SWAP_CHOICES, query)
}
