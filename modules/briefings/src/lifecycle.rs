//! Account deletion and export shape. Deleting an account removes both tables by cascade.
use moss_module_sdk::{query::Order, query::Query, Client, Error, Host, Result};
use serde_json::{Map, Value};

pub const COUNT_PREDICATE: &str = "owner_user_id = $1::uuid";
pub const OWNED_TABLES: [&str; 2] = ["app.briefing_definitions", "app.briefing_runs"];
const PAGE: u32 = 100;

const DEFINITION_FIELDS: [(&str, &str); 10] = [
    ("id", "id"),
    ("owner_user_id", "ownerUserId"),
    ("title", "title"),
    ("briefing_type", "briefingType"),
    ("cadence", "cadence"),
    ("schedule_metadata", "scheduleMetadata"),
    ("enabled", "enabled"),
    ("selected_tool_names", "selectedToolNames"),
    ("last_run_at", "lastRunAt"),
    ("created_at", "createdAt"),
];
const RUN_FIELDS: [(&str, &str); 8] = [
    ("id", "id"),
    ("definition_id", "definitionId"),
    ("owner_user_id", "ownerUserId"),
    ("status", "status"),
    ("run_kind", "runKind"),
    ("summary_text", "summaryText"),
    ("source_metadata", "sourceMetadata"),
    ("created_at", "createdAt"),
];

fn page<H: Host + ?Sized>(host: &H, table: &str, order: &[&str], fields: &[(&str, &str)]) -> Result<Value> {
    let mut query = Query {
        order: order.iter().map(|column| Order { column: (*column).into(), descending: false }).collect(),
        limit: Some(PAGE),
        ..Query::default()
    };
    let mut out = Vec::new();
    loop {
        let rows = Client(host).query(table, &query)?;
        let count = rows.len();
        for row in rows {
            let mut item = Map::new();
            for (column, name) in fields {
                let value = row.get(column).ok_or_else(|| Error::new("Briefings export row is incomplete"))?;
                item.insert((*name).into(), value.clone());
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
            .ok_or_else(|| Error::new("Briefings export exceeds the host paging limit"))?;
    }
    Ok(Value::Array(out))
}

pub fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut section = Map::new();
    section.insert("definitions".into(), page(host, "app.briefing_definitions", &["created_at", "id"], &DEFINITION_FIELDS)?);
    section.insert("runs".into(), page(host, "app.briefing_runs", &["created_at", "id"], &RUN_FIELDS)?);
    Ok(Value::Object(section))
}
