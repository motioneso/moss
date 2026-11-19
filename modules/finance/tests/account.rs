//! Part 27: the Finance sections of the whole-account export and delete.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

fn call(f: &Fake, name: &str) -> Value {
    let payload = json!({"name": name, "parameters": {}}).to_string();
    serde_json::from_str(&moss_finance_module::handle(f, "api", &payload).expect("api")).unwrap()
}

fn seed_person(f: &Fake, owner: &str, tag: &str) {
    f.seed("app.finance_accounts", owner, json!({"account_id":format!("acct-{tag}"),"item_id":null,"name":"Checking","type":"depository","subtype":"checking","balance_cents":1000,"iso_currency":"USD","source":"manual"}));
    f.seed("app.finance_bank_links", owner, json!({"item_id":format!("item-{tag}"),"slot":format!("SLOT-{tag}"),"sync_cursor":null,"pagination_start":null}));
    f.seed("app.finance_link_sessions", owner, json!({"link_token":format!("LINK-{tag}")}));
    f.seed("app.finance_categories", owner, json!({"id":format!("cat-{tag}"),"name":"Food"}));
}

#[test]
fn export_holds_only_the_callers_rows_and_no_bank_secrets() {
    let f = Fake::new();
    seed_person(&f, A, "a");
    seed_person(&f, B, "b");
    f.as_actor(A);
    let export = call(&f, "collectFinanceExportSection");
    let text = export.to_string();
    assert_eq!(export["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(export["accounts"][0]["account_id"], "acct-a");
    assert_eq!(export["categories"].as_array().unwrap().len(), 1);
    assert!(!text.contains("acct-b"));
    assert!(!text.contains("SLOT-"), "a credential slot name reached the export");
    assert!(!text.contains("LINK-"), "a link token reached the export");
    assert!(export.get("bank_links").is_none() && export.get("link_sessions").is_none());
}

#[test]
fn delete_removes_the_callers_rows_drops_bank_tokens_and_spares_others() {
    let f = Fake::new();
    seed_person(&f, A, "a");
    seed_person(&f, B, "b");
    f.as_actor(A);
    let deleted = call(&f, "deleteFinanceAccountData");
    assert!(deleted["deleted"].as_i64().unwrap() >= 4);
    assert_eq!(call(&f, "collectFinanceExportSection")["accounts"].as_array().unwrap().len(), 0);
    let forgot: Vec<_> = f.calls.borrow().iter().filter(|c| c.1 == "forget").map(|c| c.3.clone()).collect();
    assert_eq!(forgot.len(), 1);
    assert_eq!(forgot[0]["slot"], "SLOT-a");
    f.as_actor(B);
    assert_eq!(f.rows("app.finance_accounts").iter().filter(|r| r["owner_user_id"] == B).count(), 1);
    assert_eq!(f.rows("app.finance_bank_links").iter().filter(|r| r["owner_user_id"] == B).count(), 1);
}

#[test]
fn account_calls_refuse_parameters_and_unknown_names() {
    let f = Fake::new();
    f.as_actor(A);
    let bad = json!({"name":"collectFinanceExportSection","parameters":{"x":1}}).to_string();
    assert!(moss_finance_module::handle(&f, "api", &bad).is_err());
    let unknown = json!({"name":"nope","parameters":{}}).to_string();
    assert!(moss_finance_module::handle(&f, "api", &unknown).is_err());
}

#[test]
fn export_returns_every_row_of_a_large_table() {
    let f = Fake::new();
    for i in 0..1200 {
        f.seed("app.finance_activity", A, json!({"id": format!("00000000-0000-4000-8000-{i:012}")}));
    }
    f.as_actor(A);
    assert_eq!(call(&f, "collectFinanceExportSection")["activity"].as_array().unwrap().len(), 1200);
}

#[test]
fn setup_status_reports_accounts_without_bank_keys() {
    let f = Fake::new();
    let (status, empty) = f.route("GET", "/finance/setup/status", json!({}));
    assert_eq!(status, 200);
    assert_eq!(empty["hasBank"], false);
    assert_eq!(empty["hasManualAccount"], false);
    assert_eq!(empty["keysConfigured"], false);
    f.seed(
        "app.finance_accounts",
        A,
        json!({"account_id":"m1","name":"Cash","source":"manual","type":"depository","iso_currency":"USD"}),
    );
    let (_, after) = f.route("GET", "/finance/setup/status", json!({}));
    assert_eq!(after["hasManualAccount"], true);
    assert_eq!(after["hasBank"], false);
}
