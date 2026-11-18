//! Category upsert (`app.finance_categories`). Needs the saved category list, which the budget
//! policy row marks ready. Archiving is not part of this build because it must check budget lines.
use crate::input::{self, refuse};
use crate::ledger::{first, log, log_as, values, Outcome};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const CATEGORIES: &str = "app.finance_categories";
const POLICY: &str = "app.finance_budget_policy";
const GROUPS: [&str; 5] = ["Bills", "Everyday", "Fun", "Savings", "Income"];
const NAME_MAX_BYTES: usize = 60;

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars().filter(|c| c.is_ascii()) {
        if c.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    if out.is_empty() { "category".into() } else { out }
}

/// `finance.categories.upsert`. Adds a category, or renames and regroups one.
pub fn upsert<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let ready = Client(host).query(POLICY, &Query::select(Filter::All))?.first().is_some_and(|r| r["taxonomy_ready"] == true);
    if !ready {
        return Ok(Err(refuse("taxonomy_not_ready", "Save your categories before editing them")));
    }
    let name = ask!(input::required_string(input, "name", Some(NAME_MAX_BYTES * 4))).trim_matches(input::is_js_space).to_owned();
    if name.is_empty() || name.len() > NAME_MAX_BYTES {
        return Ok(Err(input::invalid(format!("name must be 1 to {NAME_MAX_BYTES} bytes"))));
    }
    let group = ask!(input::required_string(input, "group", None));
    if !GROUPS.contains(&group.as_str()) {
        return Ok(Err(input::invalid("group is not supported")));
    }
    let id = ask!(input::string(input, "id", false, Some(128)));
    let mut all = Query::select(Filter::Null { column: "archived_at".into(), not: false });
    all.order = vec![Order { column: "sort_order".into(), descending: false }, Order { column: "id".into(), descending: false }];
    let live = Client(host).query(CATEGORIES, &all)?;
    let folded = name.to_lowercase();
    if live.iter().any(|c| c["name"].as_str().is_some_and(|n| n.to_lowercase() == folded) && Some(c["id"].as_str().unwrap_or("")) != id.as_deref()) {
        return Ok(Err(refuse("duplicate_name", "A category with that name already exists")));
    }
    let income = group == "Income";
    match id {
        Some(id) => {
            let Some(before) = live.iter().find(|c| c["id"] == id.as_str()).cloned() else {
                return Ok(Err(refuse("not_found", "That category was not found")));
            };
            Client(host).query(
                CATEGORIES,
                &Query::update(Filter::eq("id", id.clone()), values(vec![("name", json!(name)), ("group_name", json!(group)), ("is_income", json!(income))])),
            )?;
            log(host, "category.update", json!({"categoryId":id}))?;
            Ok(Ok(json!({"status":"ok","before":before,"after":{"id":id,"name":name,"group":group,"isIncome":income}})))
        }
        None => {
            let base = slug(&name);
            let taken = |c: &str| first(host, CATEGORIES, Filter::eq("id", c)).map(|r| r.is_some());
            let mut id = base.clone();
            let mut n = 2;
            while taken(&id)? {
                id = format!("{base}-{n}");
                n += 1;
            }
            let order = live.iter().filter_map(|c| c["sort_order"].as_i64()).max().unwrap_or(0) + 1;
            Client(host).query(
                CATEGORIES,
                &Query::insert(values(vec![("id", json!(id)), ("group_name", json!(group)), ("name", json!(name)), ("sort_order", json!(order)), ("is_income", json!(income))])),
            )?;
            log_as(host, "user", "category.create", json!({"categoryId":id}), Some(json!({"categoryId":id})))?;
            Ok(Ok(json!({"status":"ok","before":null,"after":{"id":id,"name":name,"group":group,"isIncome":income}})))
        }
    }
}
