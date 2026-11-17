//! The account list and the manual entry setup (`app.finance_accounts`, `app.finance_items`,
//! `app.finance_categories`).
use crate::input::CURRENCIES;
use crate::ledger::{today, ACCOUNTS};
use chrono::{DateTime, SecondsFormat};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};

const ITEMS: &str = "app.finance_items";
const CATEGORIES: &str = "app.finance_categories";
const POLICY: &str = "app.finance_budget_policy";

pub struct Category {
    pub id: String,
    pub name: String,
}

/// Seed categories used until the person's own list is saved.
const DEFAULTS: [(&str, &str); 16] = [
    ("rent-mortgage", "Rent & mortgage"),
    ("utilities", "Utilities"),
    ("insurance", "Insurance"),
    ("subscriptions", "Subscriptions & services"),
    ("groceries", "Groceries"),
    ("dining", "Dining & coffee"),
    ("transport", "Transport"),
    ("shopping", "Shopping"),
    ("fuel", "Fuel"),
    ("entertainment", "Entertainment"),
    ("health", "Health"),
    ("personal-care", "Personal care"),
    ("travel", "Travel"),
    ("savings", "Savings"),
    ("income", "Income"),
    ("transfers", "Transfers"),
];

/// Current categories a manual entry may use. Archived ones and transfers are left out.
pub fn categories<H: Host + ?Sized>(host: &H) -> Result<Vec<Category>> {
    let client = Client(host);
    let ready = client
        .query(POLICY, &Query::select(Filter::All))?
        .first()
        .is_some_and(|row| row["taxonomy_ready"] == true);
    let all = if ready {
        let mut query = Query::select(Filter::Null { column: "archived_at".into(), not: false });
        query.order = vec![
            Order { column: "sort_order".into(), descending: false },
            Order { column: "id".into(), descending: false },
        ];
        client
            .query(CATEGORIES, &query)?
            .iter()
            .map(|r| Ok(Category { id: str_of(r, "id")?, name: str_of(r, "name")? }))
            .collect::<Result<Vec<_>>>()?
    } else {
        DEFAULTS.iter().map(|(id, name)| Category { id: (*id).into(), name: (*name).into() }).collect()
    };
    Ok(all.into_iter().filter(|c| c.id != "transfers").collect())
}

fn str_of(row: &Value, key: &str) -> Result<String> {
    row[key].as_str().map(str::to_owned).ok_or_else(|| Error::new("Invalid Finance row"))
}

/// Database timestamps become the `toISOString` form the old app returned.
pub(crate) fn iso(value: &Value) -> Value {
    match value.as_str() {
        Some(text) => DateTime::parse_from_rfc3339(text)
            .map(|at| json!(at.to_utc().to_rfc3339_opts(SecondsFormat::Millis, true)))
            .unwrap_or_else(|_| json!(text)),
        None => Value::Null,
    }
}

/// `finance.manual.context`.
pub fn context<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let categories: Vec<Value> =
        categories(host)?.into_iter().map(|c| json!({"id":c.id,"name":c.name})).collect();
    Ok(json!({"status":"ok","today":today(host)?,"currencies":CURRENCIES,"supported":true,"categories":categories}))
}

fn account(row: &Value) -> Result<Value> {
    let mut view = Map::new();
    let manual = row["source"] == "manual";
    view.insert("accountId".into(), row["account_id"].clone());
    view.insert("itemId".into(), row["item_id"].clone());
    view.insert("name".into(), row["name"].clone());
    view.insert("mask".into(), row["mask"].clone());
    view.insert("type".into(), row["type"].clone());
    view.insert("subtype".into(), row["subtype"].clone());
    view.insert("balanceCents".into(), row["balance_cents"].clone());
    view.insert("isoCurrency".into(), row["iso_currency"].clone());
    view.insert("updatedAt".into(), iso(&row["updated_at"]));
    view.insert("sharedToHousehold".into(), json!(row["shared_to_household"] == true));
    if manual {
        view.insert("source".into(), json!("manual"));
        view.insert("openingDate".into(), row["opening_date"].clone());
        view.insert("openingBalanceCents".into(), row["opening_balance_cents"].clone());
        view.insert("archivedAt".into(), iso(&row["archived_at"]));
    }
    Ok(Value::Object(view))
}

/// `finance.accounts.list`. The person's own accounts only.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut query = Query::select(Filter::All);
    query.order = vec![Order { column: "account_id".into(), descending: false }];
    let rows = client.query(ACCOUNTS, &query)?;
    let items = client.query(ITEMS, &Query::select(Filter::All))?;
    let mut own = Vec::new();
    let mut bank_ids = Vec::new();
    for row in &rows {
        let item = row["item_id"].as_str().and_then(|id| items.iter().find(|i| i["item_id"] == id));
        let mut view = account(row)?;
        let status = if row["source"] == "manual" {
            json!("manual")
        } else {
            item.map_or(json!("error"), |i| i["status"].clone())
        };
        view["institutionId"] = item.map_or(Value::Null, |i| i["institution_id"].clone());
        view["itemStatus"] = status;
        if let Some(id) = row["item_id"].as_str() {
            if !bank_ids.contains(&id) {
                bank_ids.push(id);
            }
        }
        own.push(view);
    }
    bank_ids.sort_unstable();
    let banks: Vec<Value> = bank_ids
        .into_iter()
        .map(|id| {
            let item = items.iter().find(|i| i["item_id"] == id);
            let message = item
                .and_then(|i| i["last_error_detail"].as_str())
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .and_then(|d| d["message"].as_str().map(str::to_owned));
            json!({
                "itemId": id,
                "institutionId": item.map_or(Value::Null, |i| i["institution_id"].clone()),
                "institutionName": item.map_or(Value::Null, |i| i["institution_name"].clone()),
                "status": item.map_or(json!("error"), |i| i["status"].clone()),
                "lastSyncAt": item.map_or(Value::Null, |i| iso(&i["last_sync_at"])),
                "message": message,
            })
        })
        .collect();
    let none = own.is_empty();
    let mut out = json!({"accounts":own,"banks":banks,"supportsManualManagement":true});
    if none {
        out["nextStep"] = json!("Add a manual account or connect a bank");
    }
    Ok(out)
}
