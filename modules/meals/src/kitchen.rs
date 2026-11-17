//! The kitchen, its household members and its slot rules. Every query goes through the host's
//! typed database port, which scopes each row to the signed-in person.
//!
//! Reading never writes. Before the first write the default kitchen is returned, and its ids
//! derive from the person's id, so that answer names the same rows the first write stores.
use crate::util::{context, values};
use crate::{md5, KITCHENS};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

pub const MEMBERS: &str = "app.meals_household_members";
pub const RULES: &str = "app.meals_meal_slot_rules";
pub const FAVOURITES: &str = "app.meals_favourites";

const SELF_NAME: &str = "You";

fn desc(column: &str) -> Order {
    Order {
        column: column.into(),
        descending: true,
    }
}
fn asc(column: &str) -> Order {
    Order {
        column: column.into(),
        descending: false,
    }
}

/// Kitchen id and self-member id, derived from the person exactly as the old database did.
fn derived_ids<H: Host + ?Sized>(host: &H) -> Result<(String, String)> {
    let (actor, _) = context(host)?;
    Ok((
        md5::uuid_of(&format!("meals.kitchen:{actor}")),
        md5::uuid_of(&format!("meals.self:{actor}")),
    ))
}

fn unsaved_self(member_id: &str) -> Value {
    json!({
        "member_id": member_id, "name": SELF_NAME, "is_self": true,
        "linked_account_email": null, "calorie_target": null, "protein_target_g": null,
        "carb_target_g": null, "fat_target_g": null,
        "meal_pattern": ["breakfast", "lunch", "dinner"], "restrictions": [], "preferences": []
    })
}

pub fn member_view(row: &Value, favourites: Vec<Value>) -> Value {
    json!({
        "memberId": row["member_id"],
        "name": row["name"],
        "isSelf": row["is_self"],
        "linkedAccountEmail": row["linked_account_email"],
        "calorieTarget": row["calorie_target"],
        "macroTargets": {
            "proteinG": row["protein_target_g"],
            "carbG": row["carb_target_g"],
            "fatG": row["fat_target_g"]
        },
        "mealPattern": row["meal_pattern"],
        "restrictions": row["restrictions"],
        "preferences": row["preferences"],
        "favouriteRecipeIds": favourites
    })
}

fn kitchen_row<H: Host + ?Sized>(host: &H) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::All);
    query.limit = Some(1);
    Ok(Client(host).query(KITCHENS, &query)?.into_iter().next())
}

/// `meals.kitchen.get`. Never writes.
pub fn view<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let kitchen = kitchen_row(host)?;
    let kitchen_id = match &kitchen {
        Some(row) => row["kitchen_id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::new("Invalid kitchen row"))?,
        None => derived_ids(host)?.0,
    };
    let mut members = vec![];
    let (mut rules, mut favourites) = (vec![], vec![]);
    if kitchen.is_some() {
        let mut query = Query::select(Filter::eq("kitchen_id", kitchen_id.as_str()));
        query.order = vec![
            desc("is_self"),
            asc("sort_order"),
            asc("created_at"),
            asc("member_id"),
        ];
        members = client.query(MEMBERS, &query)?;
        let mut query = Query::select(Filter::eq("kitchen_id", kitchen_id.as_str()));
        query.order = vec![asc("created_at"), asc("slot_name")];
        rules = client.query(RULES, &query)?;
        let mut query = Query::select(Filter::All);
        query.order = vec![asc("created_at"), asc("recipe_id")];
        favourites = client.query(FAVOURITES, &query)?;
    }
    if !members.iter().any(|m| m["is_self"] == true) {
        members.insert(0, unsaved_self(&derived_ids(host)?.1));
    }
    let favourites_of = |member: &Value| -> Vec<Value> {
        favourites
            .iter()
            .filter(|f| f["member_id"] == member["member_id"])
            .map(|f| f["recipe_id"].clone())
            .collect()
    };
    Ok(json!({
        "kitchenId": kitchen_id,
        "unitsSystem": kitchen.as_ref().map_or(json!("us"), |k| k["units_system"].clone()),
        "defaultPantryMode": kitchen.as_ref().map_or(json!("prefer"), |k| k["default_pantry_mode"].clone()),
        "members": members.iter().map(|m| member_view(m, favourites_of(m))).collect::<Vec<_>>(),
        "slotRules": rules.iter().map(|r| json!({
            "slotName": r["slot_name"],
            "soloWeekdays": r["solo_weekdays"],
            // The database returns 07:30:00; the tool answers 07:30.
            "usualTime": r["usual_time"].as_str().map_or(Value::Null, |t| json!(t.get(..5).unwrap_or(t)))
        })).collect::<Vec<_>>(),
    }))
}

/// Stores the kitchen and a self member named "You" on first use. A repeat changes nothing.
pub fn ensure<H: Host + ?Sized>(host: &H) -> Result<String> {
    let (kitchen_id, self_id) = derived_ids(host)?;
    let client = Client(host);
    let mut query = Query::insert(values(vec![("kitchen_id", json!(kitchen_id))]));
    query.conflict = Conflict::Ignore;
    client.query(KITCHENS, &query)?;
    let stored =
        kitchen_row(host)?.ok_or_else(|| Error::new("Kitchen not visible after insert"))?;
    let kitchen_id = stored["kitchen_id"]
        .as_str()
        .ok_or_else(|| Error::new("Invalid kitchen row"))?
        .to_owned();
    let mut query = Query::insert(values(vec![
        ("kitchen_id", json!(kitchen_id)),
        ("member_id", json!(self_id)),
        ("name", json!(SELF_NAME)),
        ("is_self", json!(true)),
    ]));
    query.conflict = Conflict::Ignore;
    client.query(MEMBERS, &query)?;
    Ok(kitchen_id)
}

pub fn update_kitchen<H: Host + ?Sized>(
    host: &H,
    kitchen_id: &str,
    units: Option<String>,
    pantry_mode: Option<String>,
) -> Result<()> {
    let mut set = vec![("updated_at", json!(context(host)?.1))];
    if let Some(units) = units {
        set.push(("units_system", json!(units)));
    }
    if let Some(mode) = pantry_mode {
        set.push(("default_pantry_mode", json!(mode)));
    }
    Client(host).query(
        KITCHENS,
        &Query::update(Filter::eq("kitchen_id", kitchen_id), values(set)),
    )?;
    Ok(())
}

/// One row per slot name. A rule for an existing slot replaces it.
pub fn upsert_rule<H: Host + ?Sized>(
    host: &H,
    kitchen_id: &str,
    slot: &str,
    weekdays: &[i64],
    usual_time: &Value,
) -> Result<()> {
    let mut query = Query::insert(values(vec![
        ("kitchen_id", json!(kitchen_id)),
        ("slot_name", json!(slot)),
        ("solo_weekdays", json!(weekdays)),
        ("usual_time", usual_time.clone()),
    ]));
    query.conflict = Conflict::Update {
        columns: vec![
            "owner_user_id".into(),
            "kitchen_id".into(),
            "slot_name".into(),
        ],
        values: values(vec![
            ("solo_weekdays", json!(weekdays)),
            ("usual_time", usual_time.clone()),
            ("updated_at", json!(context(host)?.1)),
        ]),
    };
    Client(host).query(RULES, &query)?;
    Ok(())
}

pub fn add_member<H: Host + ?Sized>(
    host: &H,
    kitchen_id: &str,
    mut fields: Vec<(&str, Value)>,
) -> Result<Value> {
    let mut query = Query::select(Filter::eq("kitchen_id", kitchen_id));
    query.order = vec![desc("sort_order")];
    query.limit = Some(1);
    let top = Client(host)
        .query(MEMBERS, &query)?
        .first()
        .and_then(|row| row["sort_order"].as_i64())
        .unwrap_or(0);
    let id = host.call("context", "uuid", "new", json!({}))?["id"].clone();
    fields.extend([
        ("kitchen_id", json!(kitchen_id)),
        ("member_id", id),
        ("sort_order", json!(top.max(0) + 1)),
    ]);
    let rows = Client(host).query(MEMBERS, &Query::insert(values(fields)))?;
    let row = rows
        .first()
        .ok_or_else(|| Error::new("Member was not stored"))?;
    Ok(member_view(row, vec![]))
}

/// `None` when no member with this id is visible to the person.
pub fn update_member<H: Host + ?Sized>(
    host: &H,
    member_id: &str,
    mut fields: Vec<(&str, Value)>,
) -> Result<Option<Value>> {
    fields.push(("updated_at", json!(context(host)?.1)));
    let rows = Client(host).query(
        MEMBERS,
        &Query::update(Filter::eq("member_id", member_id), values(fields)),
    )?;
    Ok(rows.first().map(|row| member_view(row, vec![])))
}

/// False when the member is missing or is the self member, whose row is never deleted.
pub fn remove_member<H: Host + ?Sized>(host: &H, member_id: &str) -> Result<bool> {
    let filter = Filter::And {
        filters: vec![
            Filter::eq("member_id", member_id),
            Filter::eq("is_self", false),
        ],
    };
    Ok(!Client(host)
        .query(MEMBERS, &Query::delete(filter))?
        .is_empty())
}
