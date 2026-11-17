//! Account deletion and export shape. Deleting an account removes all eight tables by cascade.
use crate::util::iso_or_null;
use moss_module_sdk::{query::Order, query::Query, Client, Error, Host, Result};
use serde_json::{Map, Value};

pub const COUNT_PREDICATE: &str = "owner_user_id = $1::uuid";
pub const OWNED_TABLES: [&str; 8] = [
    "app.news_prefs",
    "app.news_custom_sources",
    "app.news_custom_topics",
    "app.news_source_exclusions",
    "app.news_compilation_snapshots",
    "app.news_refresh_state",
    "app.news_policy_verdicts",
    "app.news_source_credentials",
];
const PAGE: u32 = 100;

/// Column, exported name and whether the column holds a timestamp.
type Field = (&'static str, &'static str, bool);

const SOURCES: [Field; 12] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("label", "label", false),
    ("canonical_domain", "canonicalDomain", false),
    ("homepage_url", "homepageUrl", false),
    ("feed_url", "feedUrl", false),
    ("retrieval_method", "retrievalMethod", false),
    ("validation_status", "validationStatus", false),
    ("health_status", "healthStatus", false),
    ("validated_at", "validatedAt", true),
    ("created_at", "createdAt", true),
    ("updated_at", "updatedAt", true),
];
const TOPICS: [Field; 8] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("label", "label", false),
    ("guidance", "guidance", false),
    ("validation_status", "validationStatus", false),
    ("validated_at", "validatedAt", true),
    ("created_at", "createdAt", true),
    ("updated_at", "updatedAt", true),
];
const EXCLUSIONS: [Field; 4] = [
    ("id", "id", false),
    ("owner_user_id", "ownerUserId", false),
    ("canonical_domain", "canonicalDomain", false),
    ("created_at", "createdAt", true),
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
                let value = row.get(column).ok_or_else(|| Error::new("News export row is incomplete"))?;
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
            .ok_or_else(|| Error::new("News export exceeds the host paging limit"))?;
    }
    Ok(Value::Array(out))
}

/// The `newsPersonalization` export section. Prefs, snapshots and credentials are not exported.
pub fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut section = Map::new();
    section.insert("custom_sources".into(), page(host, "app.news_custom_sources", &["created_at", "id"], &SOURCES)?);
    section.insert("custom_topics".into(), page(host, "app.news_custom_topics", &["created_at", "id"], &TOPICS)?);
    section.insert("source_exclusions".into(), page(host, "app.news_source_exclusions", &["created_at", "id"], &EXCLUSIONS)?);
    Ok(Value::Object(section))
}
