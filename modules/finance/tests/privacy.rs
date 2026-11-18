mod common;
use common::{Fake, OP1, OP2};
use serde_json::{json, Value};

const NAME: &str = "PLANTED-NAME-7d2e41";
const ENTRY: &str = "PLANTED-ENTRY-91c0aa";
const NOTE: &str = "PLANTED-NOTE-55be10";
const AMOUNT: i64 = 7_300_123;

fn plant(f: &Fake) {
    f.route("POST", "/finance/manual/accounts", json!({"operationId":OP1,"name":NAME,"accountType":"checking",
        "isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":AMOUNT}));
    f.route("POST", "/finance/manual/entries", json!({"operationId":OP2,"accountId":format!("manual:{OP1}"),"name":ENTRY,
        "date":"2026-11-10","amountCents":-AMOUNT - 17,"isoCurrency":"USD","notes":NOTE,"cleared":true}));
}

#[test]
fn only_the_finance_tables_and_the_clock_are_called() {
    let f = Fake::new();
    plant(&f);
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "context"].contains(&port.as_str()), "unexpected port {port}");
        if port == "db" {
            assert!(
                ["app.finance_accounts", "app.finance_transactions", "app.finance_activity", "app.finance_budget_policy", "app.finance_merchant_rules", "app.finance_imports", "app.finance_categories", "app.finance_shared_accounts", "app.finance_shared_transactions"].contains(&resource.as_str()),
                "unexpected table {resource}"
            );
        } else {
            assert!(!parameters.to_string().contains(NAME));
        }
    }
}

#[test]
fn activity_rows_hold_ids_and_no_names_notes_or_amounts() {
    let f = Fake::new();
    plant(&f);
    let activity = f.rows("app.finance_activity");
    assert_eq!(activity.len(), 2);
    for row in &activity {
        let text = row.to_string();
        for secret in [NAME, ENTRY, NOTE, &AMOUNT.to_string(), &(AMOUNT + 17).to_string(), "7300"] {
            assert!(!text.contains(secret), "{secret} found in {text}");
        }
    }
    assert_eq!(activity[0]["params"], json!({"accountId":format!("manual:{OP1}")}));
}

#[test]
fn a_host_failure_never_echoes_names_notes_or_amounts() {
    let f = Fake::new();
    *f.db_failure.borrow_mut() = Some(format!("failed on {NAME} {NOTE} {AMOUNT}"));
    for (method, path, body) in [
        ("POST", "/finance/manual/accounts", json!({"operationId":OP1,"name":NAME,"accountType":"checking","isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":AMOUNT})),
        ("GET", "/finance/accounts", Value::Null),
        ("GET", "/finance/manual/context", Value::Null),
    ] {
        let (status, out) = f.route(method, path, body);
        assert_eq!(status, 500);
        assert!(!out.to_string().contains("PLANTED") && !out.to_string().contains(&AMOUNT.to_string()), "{out}");
    }
    let payload = json!({"tool":"finance.manual.account-create","parameters":{"operationId":OP1,"name":NAME,"accountType":"checking",
        "isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":AMOUNT}}).to_string();
    let err = moss_finance_module::handle(&f, "tool", &payload).unwrap_err();
    assert!(!err.to_string().contains("PLANTED"));
}

#[test]
fn a_refusal_names_the_field_and_never_the_value() {
    let f = Fake::new();
    let (_, out) = f.route("POST", "/finance/manual/accounts", json!({"operationId":OP1,"name":NAME,"accountType":NAME,
        "isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":AMOUNT}));
    assert!(!out.to_string().contains("PLANTED"), "{out}");
    let (_, out) = f.route("POST", "/finance/manual/accounts", json!({"operationId":NAME,"name":NAME}));
    assert!(!out.to_string().contains("PLANTED"), "{out}");
}

const MERCHANT: &str = "PLANTED-MERCHANT-3f9c21";

/// Every place a stored private value could land: activity rows, tool results sent to chat
/// routes, and the parameters of every non-database host call.
fn leak_scan(f: &Fake, secrets: &[&str]) -> Vec<String> {
    let mut found = vec![];
    let mut texts: Vec<(String, String)> = f
        .rows("app.finance_activity")
        .iter()
        .map(|r| ("activity".to_owned(), r.to_string()))
        .collect();
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        if port != "db" {
            texts.push((format!("{port}:{resource}"), parameters.to_string()));
        }
    }
    for (place, text) in texts {
        for s in secrets {
            if text.contains(s) {
                found.push(format!("{s} in {place}"));
            }
        }
    }
    found
}

fn drive_transaction_flows(f: &Fake) {
    f.account("checking", OP1, "2026-01-01", AMOUNT);
    let account = format!("manual:{OP1}");
    f.route("POST", "/finance/import/apply", json!({"operationId":OP2,"accountId":account,"isoCurrency":"USD","expectedRevision":0,
        "rows":[{"sourceRow":1,"date":"2026-11-03","name":MERCHANT,"amountCents":-AMOUNT,"notes":NOTE,"allowDuplicate":false}],"cleared":true}));
    let id = f.rows("app.finance_transactions")[0]["id"].as_str().unwrap().to_owned();
    f.route("POST", "/finance/transactions/notes", json!({"transactionId":id,"accountId":account,"notes":NOTE}));
    f.route("POST", "/finance/transactions/category", json!({"transactionId":id,"accountId":account,"month":"2026-11","categoryId":"groceries"}));
    f.tool("finance.rule.set", json!({"payee":MERCHANT,"categoryId":"groceries"}));
    f.route("POST", "/finance/sorting/run", Value::Null);
}

#[test]
fn transaction_flows_leave_no_names_notes_or_amounts_in_activity_or_host_calls() {
    let f = Fake::new();
    drive_transaction_flows(&f);
    assert!(f.rows("app.finance_activity").len() >= 3, "the flows wrote no activity");
    let secrets = [MERCHANT, NOTE, "7300123", "-7300123"];
    assert_eq!(leak_scan(&f, &secrets), Vec::<String>::new());
}

#[test]
fn the_scan_does_catch_a_planted_leak() {
    let f = Fake::new();
    drive_transaction_flows(&f);
    f.seed("app.finance_activity", common::A, json!({"id":"x","kind":"test","params":{"name":MERCHANT}}));
    assert!(!leak_scan(&f, &[MERCHANT]).is_empty());
}
