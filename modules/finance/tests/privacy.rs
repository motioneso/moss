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
                ["app.finance_accounts", "app.finance_transactions", "app.finance_activity", "app.finance_budget_policy"].contains(&resource.as_str()),
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
