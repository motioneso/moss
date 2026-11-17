//! The sorting run over a person's open rows. It loads the rules, the two policy tiers and the
//! merchants already confirmed, then lets the pure sorting code decide. No model is called here.
use crate::ledger::{log_as, values, Outcome, TRANSACTIONS};
use crate::rules::RULES;
use crate::sorting::{categorize, Context, Policy, Row, Tier};
use crate::transactions::{and, same, seen_payees, splits_of, split_balanced};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn tier<H: Host + ?Sized>(host: &H, family: &str, fallback: Tier) -> Tier {
    host.call("action-policy", "route-read", family, json!({}))
        .ok()
        .and_then(|v| v["tier"].as_str().and_then(Tier::parse))
        .unwrap_or(fallback)
}

fn row_of(r: &Value) -> Row {
    Row {
        id: r["id"].as_str().unwrap_or("").to_owned(),
        name: r["name"].as_str().unwrap_or("").to_owned(),
        amount_cents: r["amount_cents"].as_i64().unwrap_or(0),
        date: r["date"].as_str().unwrap_or("").to_owned(),
        plaid_category: r["plaid_category"].as_str().map(str::to_owned),
        category_id: r["category_id"].as_str().map(str::to_owned),
        categorized_by: r["categorized_by"].as_str().map(str::to_owned),
        review_state: r["review_state"].as_str().unwrap_or("confirmed").to_owned(),
        ai_confidence: r["ai_confidence"].as_f64(),
        split_balanced: split_balanced(r) && !splits_of(r).is_empty(),
    }
}

/// `finance.sorting.run`. Sorts every open row the person owns. Safe to run twice.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<Outcome> {
    let defaults = Policy::default();
    let policy = Policy { sorting: tier(host, "sorting", defaults.sorting), sorting_new: tier(host, "sorting_new", defaults.sorting_new) };
    let client = Client(host);
    let open = client.query(
        TRANSACTIONS,
        &Query::select(and(vec![
            Filter::Null { column: "category_id".into(), not: false },
            Filter::Null { column: "categorized_by".into(), not: false },
        ])),
    )?;
    let rules: BTreeMap<String, String> = client
        .query(RULES, &Query::select(Filter::eq("enabled", true)))?
        .iter()
        .filter_map(|r| Some((r["payee_key"].as_str()?.to_owned(), r["category_id"].as_str()?.to_owned())))
        .collect();
    let live: Vec<String> = crate::accounts::categories(host)?.into_iter().map(|c| c.id).collect();
    let context = Context { rules: &rules, live_ids: &live, policy, seen: seen_payees(host)? };
    let rows: Vec<Row> = open.iter().map(row_of).collect();
    let sorted = categorize(rows.clone(), &context, None);
    let mut changed = 0;
    for ((old, after), before) in open.iter().zip(sorted.iter()).zip(rows.iter()) {
        if after == before {
            continue;
        }
        let done = client.query(
            TRANSACTIONS,
            &Query::update(
                and(vec![Filter::eq("id", old["id"].clone()), same("category_id", &old["category_id"]), same("categorized_by", &old["categorized_by"])]),
                values(vec![
                    ("category_id", json!(after.category_id)),
                    ("categorized_by", json!(after.categorized_by)),
                    ("review_state", json!(after.review_state)),
                    ("ai_confidence", json!(after.ai_confidence)),
                ]),
            ),
        )?;
        changed += usize::from(!done.is_empty());
    }
    if changed > 0 {
        log_as(host, "moss", "transaction.sort", json!({"count":changed}), None)?;
    }
    Ok(Ok(json!({"status":"ok","sorted":changed})))
}
