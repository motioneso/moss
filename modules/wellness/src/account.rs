//! Wellness sections of the whole-account export and delete. Both act only on the caller's rows.
//! Delete also clears the medication tables, which hold the same person's data.
use crate::{checkins::CHECKINS, notes::NOTES};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Api {
    name: String,
    parameters: Value,
}

fn export_rows<H: Host + ?Sized>(host: &H, table: &str, column: &str) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::Owned);
    query.order = vec![
        Order { column: column.into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    Client(host).query(table, &query)
}

fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    Ok(json!({
        "checkins": export_rows(host, CHECKINS, "checked_in_at")?,
        "therapy_notes": export_rows(host, NOTES, "created_at")?,
    }))
}

fn delete_all<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut removed = 0;
    for table in [NOTES, CHECKINS, "app.medication_logs", "app.medications"] {
        removed += client.query(table, &Query::delete(Filter::Owned))?.len();
    }
    for namespace in [crate::export::JOBS, crate::export::FILES] {
        host.call("kv", "delete", namespace, json!({}))?;
    }
    Ok(json!({"deleted": removed}))
}

pub fn execute<H: Host + ?Sized>(host: &H, api: Api) -> Result<Value> {
    if api.parameters != json!({}) {
        return Err(Error::new("Account operation takes no parameters"));
    }
    match api.name.as_str() {
        "collectWellnessExportSection" => collect(host),
        "deleteWellnessAccountData" => delete_all(host),
        _ => Err(Error::new("Unknown Wellness API")),
    }
}
