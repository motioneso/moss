//! `GET /finance/setup/status`. What the Start and Settings screens need to know in one read.
use crate::plaid;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const ACCOUNTS: &str = "app.finance_accounts";

/// Whether the person has a bank or a manual account, whether the admin saved bank keys, and
/// the two sorting tiers the module declares. A tier that cannot be read comes back as null.
pub fn status<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let rows = Client(host).query(ACCOUNTS, &Query::select(Filter::All))?;
    let manual = rows.iter().any(|r| r["source"] == "manual");
    let bank = rows.iter().any(|r| r["source"] != "manual");
    let tier = |family: &str| {
        host.call("action-policy", "route-read", family, json!({})).ok().map_or(Value::Null, |v| v["tier"].clone())
    };
    Ok(json!({
        "keysConfigured": plaid::keys_saved(host).unwrap_or(false),
        "hasBank": bank,
        "hasManualAccount": manual,
        "tiers": {"sorting": tier("sorting"), "sortingNew": tier("sorting_new")}
    }))
}
