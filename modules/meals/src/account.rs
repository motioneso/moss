//! Meals sections of the whole-account export and delete. Both act only on the caller's rows.
//! Delete removes children before parents, so a half-finished delete never leaves a row that
//! points at a missing parent.
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Api {
    name: String,
    parameters: Value,
}

/// Every owned table, children first. The export key is the table name without its prefix.
pub const TABLES: [&str; 20] = [
    "app.meals_undo_actions",
    "app.meals_swap_choices",
    "app.meals_planned_meal_eaters",
    "app.meals_planned_meals",
    "app.meals_plan_days",
    "app.meals_plans",
    "app.meals_shopping_list_items",
    "app.meals_shopping_lists",
    "app.meals_log_estimate_items",
    "app.meals_log_estimates",
    "app.meals_log_entries",
    "app.meals_ratings",
    "app.meals_favourites",
    "app.meals_recipe_ingredients",
    "app.meals_recipes",
    "app.meals_staples",
    "app.meals_pantry_items",
    "app.meals_meal_slot_rules",
    "app.meals_household_members",
    "app.meals_kitchens",
];

/// Rows per page. The host cuts an unpaged read at 1000 rows, so the export pages below that.
const PAGE: u32 = 500;

/// Columns that order a table's rows for paging, matching its primary key after the owner.
fn key_columns(table: &str) -> &'static [&'static str] {
    match table {
        "app.meals_meal_slot_rules" => &["kitchen_id", "slot_name"],
        "app.meals_plans" => &["plan_id"],
        "app.meals_recipes" => &["recipe_id"],
        "app.meals_household_members" => &["member_id"],
        "app.meals_undo_actions" => &["action_id"],
        "app.meals_kitchens" => &["kitchen_id"],
        "app.meals_pantry_items" => &["item_id"],
        "app.meals_log_entries" => &["entry_id"],
        "app.meals_recipe_ingredients" => &["recipe_id", "position"],
        "app.meals_favourites" | "app.meals_ratings" => &["member_id", "recipe_id"],
        "app.meals_planned_meals" => &["meal_id"],
        "app.meals_plan_days" => &["day_id"],
        "app.meals_log_estimate_items" => &["entry_id", "revision", "item_index"],
        "app.meals_shopping_lists" => &["list_id"],
        "app.meals_swap_choices" => &["choice_id"],
        "app.meals_staples" => &["staple_id"],
        "app.meals_planned_meal_eaters" => &["meal_id", "member_id"],
        "app.meals_log_estimates" => &["entry_id", "revision"],
        _ => &["line_id"],
    }
}

fn read_table<H: Host + ?Sized>(client: &Client<'_, H>, table: &str) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    loop {
        let mut query = Query::select(Filter::Owned);
        query.order = key_columns(table)
            .iter()
            .map(|column| Order { column: (*column).to_owned(), descending: false })
            .collect();
        query.limit = Some(PAGE);
        query.offset = rows.len() as u32;
        let page = client.query(table, &query)?;
        let full = page.len() as u32 == PAGE;
        rows.extend(page);
        if !full {
            return Ok(rows);
        }
    }
}

fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut out = Map::new();
    for table in TABLES.iter().rev() {
        let key = table.trim_start_matches("app.meals_");
        out.insert(key.to_owned(), Value::Array(read_table(&client, table)?));
    }
    Ok(Value::Object(out))
}

fn delete_all<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut removed = 0;
    for table in TABLES {
        removed += client.query(table, &Query::delete(Filter::Owned))?.len();
    }
    Ok(json!({"deleted": removed}))
}

pub fn execute<H: Host + ?Sized>(host: &H, api: Api) -> Result<Value> {
    if api.parameters != json!({}) {
        return Err(Error::new("Account operation takes no parameters"));
    }
    match api.name.as_str() {
        "collectMealsExportSection" => collect(host),
        "deleteMealsAccountData" => delete_all(host),
        _ => Err(Error::new("Unknown Meals API")),
    }
}
