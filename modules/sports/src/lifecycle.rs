//! Account deletion and export shape. Deleting an account removes all six tables by cascade.
use crate::util::{iso_or_null};
use moss_module_sdk::{query::Order, query::Query, Client, Error, Host, Result};
use serde_json::{Map, Value};

pub const COUNT_PREDICATE: &str = "owner_user_id = $1::uuid";
pub const OWNED_TABLES: [&str; 6] = [
    "app.sports_follows",
    "app.sports_custom_sources",
    "app.sports_source_assignments",
    "app.sports_espn_source_assignments",
    "app.sports_policy_verdicts",
    "app.sports_headline_prefs",
];
const PAGE: u32 = 100;

/// Column, exported name and whether the column holds a timestamp.
type Field = (&'static str, &'static str, bool);

const SOURCES: [Field; 20] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("label", "label", false),
    ("canonical_domain", "canonicalDomain", false),
    ("homepage_url", "homepageUrl", false),
    ("feed_url", "feedUrl", false),
    ("retrieval_method", "retrievalMethod", false),
    ("enabled", "enabled", false),
    ("health_state", "healthState", false),
    ("health_reason_code", "healthReasonCode", false),
    ("health_message", "healthMessage", false),
    ("last_checked_at", "lastCheckedAt", true),
    ("last_success_at", "lastSuccessAt", true),
    ("recipe_status", "recipeStatus", false),
    ("photo_rule_state", "photoRuleState", false),
    ("photo_last_outcome", "photoLastOutcome", false),
    ("recipe_schema_version", "recipeSchemaVersion", false),
    ("authorization_confirmed_at", "authorizationConfirmedAt", true),
    ("validated_at", "validatedAt", true),
    ("created_at", "createdAt", true),
];
const SOURCE_UPDATED: Field = ("updated_at", "updatedAt", true);
const ASSIGNMENTS: [Field; 12] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("source_id", "sourceId", false),
    ("follow_id", "followId", false),
    ("sport_key", "sportKey", false),
    ("target_url", "targetUrl", false),
    ("health_state", "healthState", false),
    ("health_reason_code", "healthReasonCode", false),
    ("health_message", "healthMessage", false),
    ("last_checked_at", "lastCheckedAt", true),
    ("last_success_at", "lastSuccessAt", true),
    ("created_at", "createdAt", true),
];
const ESPN: [Field; 5] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("follow_id", "followId", false),
    ("sport_key", "sportKey", false),
    ("created_at", "createdAt", true),
];
const FOLLOWS: [Field; 5] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("competition_key", "competitionKey", false),
    ("team_key", "teamKey", false),
    ("created_at", "createdAt", true),
];
const HEADLINES: [Field; 3] = [
    ("owner_user_id", "ownerUserId", false),
    ("espn_headlines_enabled", "espnHeadlinesEnabled", false),
    ("updated_at", "updatedAt", true),
];

fn page<H: Host + ?Sized>(host: &H, table: &str, order: &[&str], fields: &[Field]) -> Result<Value> {
    let mut query = Query {
        order: order.iter().map(|column| Order { column: (*column).into(), descending: *column == "created_at" }).collect(),
        limit: Some(PAGE),
        ..Query::default()
    };
    let mut out = Vec::new();
    loop {
        let rows = Client(host).query(table, &query)?;
        let count = rows.len();
        for row in rows {
            let mut item = Map::new();
            for (column, name, time) in fields {
                let value = row.get(column).ok_or_else(|| Error::new("Sports export row is incomplete"))?;
                item.insert((*name).into(), if *time { iso_or_null(value)? } else { value.clone() });
            }
            out.push(Value::Object(item));
        }
        if count < PAGE as usize {
            break;
        }
        query.offset = query
            .offset
            .checked_add(PAGE)
            .filter(|offset| *offset <= 1_000_000)
            .ok_or_else(|| Error::new("Sports export exceeds the host paging limit"))?;
    }
    Ok(Value::Array(out))
}

pub fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut sources: Vec<Field> = SOURCES.to_vec();
    sources.push(SOURCE_UPDATED);
    let mut section = Map::new();
    section.insert("assignments".into(), page(host, "app.sports_source_assignments", &["created_at", "id"], &ASSIGNMENTS)?);
    section.insert("espnAssignments".into(), page(host, "app.sports_espn_source_assignments", &["created_at", "id"], &ESPN)?);
    section.insert("follows".into(), page(host, "app.sports_follows", &["created_at", "id"], &FOLLOWS)?);
    section.insert("headlinePreferences".into(), page(host, "app.sports_headline_prefs", &["owner_user_id"], &HEADLINES)?);
    section.insert("sources".into(), page(host, "app.sports_custom_sources", &["created_at", "id"], &sources)?);
    Ok(Value::Object(section))
}
