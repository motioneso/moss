mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const TX: &str = "app.finance_transactions";
const RULES: &str = "app.finance_merchant_rules";
const SECRET_NAME: &str = "Hidden Clinic Payee";
const SECRET_NOTE: &str = "PLANTED-NOTE-b0b0";

fn plant(f: &Fake) {
    f.seed(TX, A, json!({"id":"a1","account_id":"acct-a","date":"2026-11-03","name":SECRET_NAME,"amount_cents":987_654,
        "iso_currency":"USD","source":"manual","review_state":"needs_look","categorized_by":null,"category_id":null,
        "pending":false,"merchant":null,"splits":[],"split_revision":0,"transfer_id":null,"notes":SECRET_NOTE,
        "reconciled_at":null,"cleared":false,"ai_confidence":null,"plaid_category":null,"pending_transaction_id":null}));
    f.seed(RULES, A, json!({"id":"r1","payee_key":"hidden clinic payee","category_id":"groceries","enabled":true}));
}

/// What actor B can see of A's data through every read route.
fn leaked(f: &Fake) -> Vec<String> {
    f.as_actor(B);
    let mut out = vec![];
    for (path, query) in [
        ("/finance/transactions", json!({"month":"2026-11"})),
        ("/finance/transactions/notes", json!({"transactionId":"a1"})),
        ("/finance/rules", json!({})),
    ] {
        let (_, body) = f.get(path, query);
        let text = body.to_string();
        if text.contains(SECRET_NAME) || text.contains(SECRET_NOTE) || text.contains("hidden clinic") || text.contains("987654") {
            out.push(path.to_owned());
        }
    }
    out
}

#[test]
fn a_second_person_sees_nothing_of_the_first() {
    let f = Fake::new();
    plant(&f);
    assert!(leaked(&f).is_empty(), "leaked through {:?}", leaked(&f));
}

#[test]
fn the_same_test_fails_with_the_protection_removed() {
    let f = Fake::new();
    plant(&f);
    f.bypass_owner.set(true);
    assert!(!leaked(&f).is_empty(), "the check cannot detect a leak");
}

#[test]
fn a_second_person_cannot_change_the_first_persons_rows() {
    let f = Fake::new();
    plant(&f);
    f.as_actor(B);
    let before = f.rows(TX);
    let writes = [
        ("POST", "/finance/transactions/category", json!({"transactionId":"a1","accountId":"acct-a","month":"2026-11","categoryId":"groceries"})),
        ("POST", "/finance/transactions/notes", json!({"transactionId":"a1","accountId":"acct-a","notes":"changed"})),
        ("POST", "/finance/transactions/bulk-confirm", json!({"transactionIds":["a1"],"month":"2026-11"})),
    ];
    for (m, p, body) in writes {
        let (status, _) = f.route(m, p, body);
        assert_ne!(status, 200, "{p}");
    }
    assert_eq!(f.rows(TX), before);
    assert_eq!(f.rows(RULES).len(), 1);
    assert!(f.rows("app.finance_activity").iter().all(|r| r["owner_user_id"] != json!(A)));
}

#[test]
fn a_rule_written_by_one_person_is_not_applied_to_another() {
    let f = Fake::new();
    plant(&f);
    f.seed(TX, B, json!({"id":"b1","account_id":"acct-b","date":"2026-11-04","name":SECRET_NAME,"amount_cents":100,
        "iso_currency":"USD","source":"manual","review_state":"needs_look","categorized_by":null,"category_id":null,
        "pending":false,"merchant":null,"splits":[],"split_revision":0,"transfer_id":null,"notes":null,
        "reconciled_at":null,"cleared":false,"ai_confidence":null,"plaid_category":null,"pending_transaction_id":null}));
    f.as_actor(B);
    f.route("POST", "/finance/sorting/run", Value::Null);
    let b = f.rows(TX).into_iter().find(|r| r["id"] == "b1").unwrap();
    assert!(b["category_id"].is_null(), "A's rule sorted B's row: {b}");
}
