mod common;
use common::{Fake, A, B, OP1, OP2, OP3};
use serde_json::{json, Value};

const ACCT: &str = "manual:11111111-1111-4111-8111-111111111111";
const TXN: &str = "manual:22222222-2222-4222-8222-222222222222";

fn account_body(kind: &str) -> Value {
    json!({"operationId":OP1,"name":"Everyday","accountType":kind,"isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":12345})
}
fn entry_body(amount: i64, category: Value) -> Value {
    json!({"operationId":OP2,"accountId":ACCT,"name":"Coffee","date":"2026-11-10","amountCents":amount,
        "isoCurrency":"USD","categoryId":category,"cleared":true})
}
fn balance(f: &Fake) -> i64 {
    f.rows("app.finance_accounts")[0]["balance_cents"].as_i64().unwrap()
}

#[test]
fn an_account_is_created_with_the_old_kind_mapping_and_digest() {
    let f = Fake::new();
    let mut body = account_body("checking");
    body["name"] = json!("  Everyday \u{e9}\"q\"  ");
    let (status, out) = f.route("POST", "/finance/manual/accounts", body);
    assert_eq!((status, out), (200, json!({"status":"ok","id":ACCT,"unchanged":false})));
    let row = &f.rows("app.finance_accounts")[0];
    assert_eq!(row["creation_digest"], "71708e7263a746278d1145e2425578c4f0cad764043d0d6ffd1b26d58860b108");
    assert_eq!((row["type"].as_str(), row["subtype"].as_str()), (Some("depository"), Some("checking")));
    assert_eq!(row["source"], "manual");
    assert_eq!(row["balance_cents"], 12345);
    assert_eq!(row["opening_balance_cents"], 12345);
    assert!(row["item_id"].is_null());
}

#[test]
fn every_account_type_maps_to_its_stored_kind() {
    for (kind, type_, subtype) in [
        ("checking", "depository", "checking"),
        ("savings", "depository", "savings"),
        ("cash", "other", "cash"),
        ("credit", "credit", "credit card"),
        ("loan", "loan", "loan"),
        ("asset", "other", "asset"),
    ] {
        let f = Fake::new();
        f.account(kind, OP1, "2026-01-01", 0);
        let row = &f.rows("app.finance_accounts")[0];
        assert_eq!((row["type"].as_str(), row["subtype"].as_str()), (Some(type_), Some(subtype)), "{kind}");
    }
}

#[test]
fn repeating_an_account_is_unchanged_and_a_different_one_conflicts() {
    let f = Fake::new();
    f.route("POST", "/finance/manual/accounts", account_body("checking"));
    let (status, out) = f.route("POST", "/finance/manual/accounts", account_body("checking"));
    assert_eq!((status, out["unchanged"].as_bool()), (200, Some(true)));
    let mut other = account_body("checking");
    other["openingBalanceCents"] = json!(1);
    let (status, out) = f.route("POST", "/finance/manual/accounts", other);
    assert_eq!(status, 409);
    assert_eq!(out["code"], "manual_conflict");
    assert_eq!(f.rows("app.finance_accounts").len(), 1);
    assert_eq!(f.rows("app.finance_activity").len(), 1);
}

fn refused(f: &Fake, path: &str, body: Value) -> (u16, String, String) {
    let (status, out) = f.route("POST", path, body);
    (status, out["code"].as_str().unwrap_or("").into(), out["message"].as_str().unwrap_or("").into())
}

#[test]
fn account_input_is_refused_with_the_old_codes() {
    let f = Fake::new();
    let p = "/finance/manual/accounts";
    let with = |key: &str, value: Value| {
        let mut b = account_body("checking");
        b[key] = value;
        b
    };
    let cases: Vec<(Value, &str, &str)> = vec![
        (with("operationId", json!("manual:x")), "invalid_input", "operationId must be a UUID"),
        (with("operationId", json!("11111111-1111-1111-8111-111111111111")), "invalid_input", "operationId must be a UUID"),
        (with("operationId", json!("11111111-1111-4111-8111-11111111111G")), "invalid_input", "operationId must be a UUID"),
        (with("name", json!("   ")), "invalid_input", "name is required"),
        (with("name", json!("x".repeat(321))), "invalid_input", "name exceeds 320 bytes of UTF-8"),
        (with("name", json!(5)), "invalid_input", "name must be a string"),
        (with("accountType", json!("brokerage")), "invalid_input", "accountType is unsupported"),
        (with("isoCurrency", json!("JPY")), "unsupported_currency", "Choose a supported two-decimal currency"),
        (with("openingDate", json!("2026-02-30")), "invalid_input", "openingDate must be a valid calendar date"),
        (with("openingDate", json!("0000-01-01")), "invalid_input", "openingDate must be a valid calendar date"),
        (with("openingDate", json!("2026-11-12")), "future_date", "Posted entries cannot be in the future in your Moss timezone"),
        (with("openingBalanceCents", json!(9007199254740992_i64)), "invalid_input", "openingBalanceCents must be an integer"),
        (with("openingBalanceCents", json!("5")), "invalid_input", "openingBalanceCents must be an integer"),
        (with("openingBalanceCents", json!(1.5)), "invalid_input", "openingBalanceCents must be an integer"),
        (with("openingBalanceCents", Value::Null), "invalid_input", "openingBalanceCents is required"),
    ];
    for (body, code, message) in cases {
        let got = refused(&f, p, body.clone());
        assert_eq!(got, (400, code.into(), message.into()), "{body}");
    }
    assert!(f.rows("app.finance_accounts").is_empty());
}

#[test]
fn whole_numbers_written_with_a_decimal_point_are_accepted() {
    let f = Fake::new();
    let mut body = account_body("checking");
    body["openingBalanceCents"] = json!(5.0);
    let (status, _) = f.route("POST", "/finance/manual/accounts", body);
    assert_eq!(status, 200);
    assert_eq!(f.rows("app.finance_accounts")[0]["balance_cents"], 5);
}

#[test]
fn an_entry_moves_the_balance_the_way_the_old_ledger_did() {
    for (kind, delta) in [("checking", -450), ("credit", 450), ("loan", 450), ("asset", -450)] {
        let f = Fake::new();
        f.account(kind, OP1, "2026-01-01", 1000);
        let (status, out) = f.route("POST", "/finance/manual/entries", entry_body(450, Value::Null));
        assert_eq!((status, out), (200, json!({"status":"ok","id":TXN,"unchanged":false})), "{kind}");
        assert_eq!(balance(&f), 1000 + delta, "{kind}");
        assert_eq!(f.rows("app.finance_accounts")[0]["ledger_revision"], 1);
    }
}

#[test]
fn an_entry_row_carries_the_old_fields_and_digest() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 0);
    let mut body = entry_body(-450, Value::Null);
    body["notes"] = json!("");
    f.route("POST", "/finance/manual/entries", body);
    let row = &f.rows("app.finance_transactions")[0];
    assert_eq!(row["entry_digest"], "35d13ba342a02b15882743ca33985b51466bf82df42d022489509ff74716bf0a");
    assert_eq!((row["pending"].clone(), row["source"].clone(), row["cleared"].clone()), (json!(false), json!("manual"), json!(true)));
    assert_eq!((row["categorized_by"].as_str(), row["review_state"].as_str()), (Some("user"), Some("needs_look")));
    assert!(row["notes"].is_null() && row["category_id"].is_null());
    assert_eq!(balance(&f), 450);
}

#[test]
fn a_categorised_entry_is_confirmed_and_notes_are_kept() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 0);
    let mut body = entry_body(450, json!("dining"));
    body["notes"] = json!("a\nb");
    body["cleared"] = json!(false);
    f.route("POST", "/finance/manual/entries", body);
    let row = &f.rows("app.finance_transactions")[0];
    assert_eq!(row["entry_digest"], "a94d4dfa614b39b010c2d4d84e7d5378e1fc861b9bbdc748d2db5eb5253e89bc");
    assert_eq!((row["review_state"].as_str(), row["category_id"].as_str(), row["notes"].as_str()), (Some("confirmed"), Some("dining"), Some("a\nb")));
}

#[test]
fn repeating_an_entry_never_moves_the_balance_twice() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 1000);
    f.route("POST", "/finance/manual/entries", entry_body(450, Value::Null));
    let (status, out) = f.route("POST", "/finance/manual/entries", entry_body(450, Value::Null));
    assert_eq!((status, out["unchanged"].as_bool()), (200, Some(true)));
    assert_eq!(balance(&f), 550);
    let (status, out) = f.route("POST", "/finance/manual/entries", entry_body(451, Value::Null));
    assert_eq!((status, out["code"].as_str()), (409, Some("manual_conflict")));
    assert_eq!(balance(&f), 550);
    assert_eq!(f.rows("app.finance_transactions").len(), 1);
    assert_eq!(f.rows("app.finance_activity").len(), 2);
}

#[test]
fn entry_input_and_account_state_are_refused_with_the_old_codes() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 0);
    let p = "/finance/manual/entries";
    let with = |key: &str, value: Value| {
        let mut b = entry_body(450, Value::Null);
        b[key] = value;
        b
    };
    let cases: Vec<(Value, u16, &str, &str)> = vec![
        (with("amountCents", json!(0)), 400, "invalid_input", "amountCents must be nonzero"),
        (with("amountCents", json!(9007199254740991_i64 + 1)), 400, "invalid_input", "amountCents must be an integer"),
        (with("name", json!(" ")), 400, "invalid_input", "name is required"),
        (with("name", json!("y".repeat(641))), 400, "invalid_input", "name exceeds 640 bytes of UTF-8"),
        (with("accountId", json!("a".repeat(129))), 400, "invalid_input", "accountId exceeds 128 bytes of UTF-8"),
        (with("notes", json!("n".repeat(4001))), 400, "invalid_input", "notes exceeds 4000 bytes of UTF-8"),
        (with("cleared", json!("yes")), 400, "invalid_input", "cleared must be a boolean"),
        (with("categoryId", json!("transfers")), 400, "invalid_category", "Choose a current category; linked transfers need their separate workflow"),
        (with("categoryId", json!("nope")), 400, "invalid_category", "Choose a current category; linked transfers need their separate workflow"),
        (with("isoCurrency", json!("EUR")), 404, "manual_unavailable", "This manual account is unavailable, archived or has a different currency"),
        (with("accountId", json!("manual:missing")), 404, "manual_unavailable", "This manual account is unavailable, archived or has a different currency"),
        (with("date", json!("2025-12-31")), 400, "manual_invalid_date", "The entry date precedes the account opening balance"),
        (with("date", json!("2026-11-12")), 400, "future_date", "Posted entries cannot be in the future in your Moss timezone"),
    ];
    for (body, status, code, message) in cases {
        assert_eq!(refused(&f, p, body.clone()), (status, code.into(), message.into()), "{body}");
    }
    assert!(f.rows("app.finance_transactions").is_empty());
    assert_eq!(balance(&f), 0);
}

#[test]
fn an_archived_or_reconciled_account_and_an_overflow_are_refused() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 0);
    f.tables.borrow_mut().get_mut("app.finance_accounts").unwrap()[0]["last_reconciled_date"] = json!("2026-11-10");
    let (s, c, _) = refused(&f, "/finance/manual/entries", entry_body(450, Value::Null));
    assert_eq!((s, c.as_str()), (409, "manual_reconciled_period"));
    f.tables.borrow_mut().get_mut("app.finance_accounts").unwrap()[0]["last_reconciled_date"] = Value::Null;
    f.tables.borrow_mut().get_mut("app.finance_accounts").unwrap()[0]["balance_cents"] = json!(9007199254740991_i64);
    let (s, c, _) = refused(&f, "/finance/manual/entries", entry_body(-1, Value::Null));
    assert_eq!((s, c.as_str()), (400, "manual_overflow"));
    f.tables.borrow_mut().get_mut("app.finance_accounts").unwrap()[0]["archived_at"] = json!("2026-11-01T00:00:00Z");
    let (s, c, _) = refused(&f, "/finance/manual/entries", entry_body(450, Value::Null));
    assert_eq!((s, c.as_str()), (404, "manual_unavailable"));
}

#[test]
fn the_account_list_is_sorted_and_points_to_the_next_step_when_empty() {
    let f = Fake::new();
    let (status, out) = f.route("GET", "/finance/accounts", Value::Null);
    assert_eq!(status, 200);
    assert_eq!(out, json!({"accounts":[],"banks":[],"supportsManualManagement":true,"nextStep":"Add a manual account or connect a bank"}));
    f.account("savings", OP2, "2026-02-01", 700);
    f.account("checking", OP1, "2026-01-01", 100);
    let (_, out) = f.route("GET", "/finance/accounts", Value::Null);
    let accounts = out["accounts"].as_array().unwrap();
    assert_eq!(accounts.iter().map(|a| a["accountId"].as_str().unwrap()).collect::<Vec<_>>(), [ACCT, "manual:22222222-2222-4222-8222-222222222222"]);
    let first = &accounts[0];
    assert_eq!(first["itemStatus"], "manual");
    assert_eq!(first["source"], "manual");
    assert_eq!(first["openingDate"], "2026-01-01");
    assert_eq!(first["archivedAt"], Value::Null);
    assert_eq!(first["sharedToHousehold"], false);
    assert!(out.get("nextStep").is_none());
    assert_eq!(out["banks"], json!([]));
}

#[test]
fn the_setup_lists_today_currencies_and_current_categories() {
    let f = Fake::new();
    let (status, out) = f.route("GET", "/finance/manual/context", Value::Null);
    assert_eq!(status, 200);
    assert_eq!(out["today"], "2026-11-11");
    assert_eq!(out["currencies"], json!(["USD","EUR","GBP","CAD","AUD","NZD","CHF","CNY","HKD","SGD","INR","MXN"]));
    assert_eq!(out["status"], "ok");
    assert_eq!(out["supported"], true);
    let cats = out["categories"].as_array().unwrap();
    assert_eq!(cats.len(), 15);
    assert_eq!(cats[0], json!({"id":"rent-mortgage","name":"Rent & mortgage"}));
    assert!(cats.iter().all(|c| c["id"] != "transfers"));
}

#[test]
fn a_saved_category_list_replaces_the_seed_and_hides_archived_ones() {
    let f = Fake::new();
    f.seed("app.finance_budget_policy", A, json!({"taxonomy_ready":true}));
    f.seed("app.finance_categories", A, json!({"id":"zeta","name":"Zeta","sort_order":2,"archived_at":null}));
    f.seed("app.finance_categories", A, json!({"id":"alpha","name":"Alpha","sort_order":1,"archived_at":null}));
    f.seed("app.finance_categories", A, json!({"id":"old","name":"Old","sort_order":0,"archived_at":"2026-01-01T00:00:00Z"}));
    f.seed("app.finance_categories", A, json!({"id":"transfers","name":"Transfers","sort_order":3,"archived_at":null}));
    let (_, out) = f.route("GET", "/finance/manual/context", Value::Null);
    assert_eq!(out["categories"], json!([{"id":"alpha","name":"Alpha"},{"id":"zeta","name":"Zeta"}]));
    f.account("checking", OP1, "2026-01-01", 0);
    let (status, _) = f.route("POST", "/finance/manual/entries", entry_body(450, json!("alpha")));
    assert_eq!(status, 200);
    let mut again = entry_body(450, json!("dining"));
    again["operationId"] = json!(OP3);
    assert_eq!(f.route("POST", "/finance/manual/entries", again).1["code"], "invalid_category");
}

#[test]
fn two_people_never_see_or_touch_each_others_accounts() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 1000);
    f.as_actor(B);
    let (_, out) = f.route("GET", "/finance/accounts", Value::Null);
    assert_eq!(out["accounts"], json!([]));
    let (status, out) = f.route("POST", "/finance/manual/entries", entry_body(450, Value::Null));
    assert_eq!((status, out["code"].as_str()), (404, Some("manual_unavailable")));
    f.account("checking", OP1, "2026-01-01", 5);
    f.as_actor(A);
    assert_eq!(balance(&f), 1000);
}

#[test]
fn tools_return_the_same_shapes_as_routes() {
    let f = Fake::new();
    assert_eq!(f.tool("finance.manual.account-create", account_body("checking")), json!({"status":"ok","id":ACCT,"unchanged":false}));
    assert_eq!(f.tool("finance.manual.entry-create", entry_body(450, Value::Null))["status"], "ok");
    assert_eq!(f.tool("finance.accounts.list", json!({}))["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(f.tool("finance.manual.context", json!({}))["today"], "2026-11-11");
    let refusal = f.tool("finance.manual.entry-create", entry_body(0, Value::Null));
    assert_eq!(refusal, json!({"status":"error","code":"invalid_input","message":"amountCents must be nonzero"}));
    assert!(moss_finance_module::handle(&f, "tool", r#"{"tool":"finance.other","parameters":{}}"#).is_err());
    assert!(moss_finance_module::handle(&f, "job", "{}").is_err());
}

#[test]
fn the_assistants_writes_need_the_accounts_one_use_approval() {
    let f = Fake::new();
    let (status, _) = f.route("POST", "/finance/chat/manual/account-create", account_body("checking"));
    assert_eq!(status, 500);
    assert!(f.rows("app.finance_accounts").is_empty());
    f.approved.set(true);
    let (status, out) = f.route("POST", "/finance/chat/manual/account-create", account_body("checking"));
    assert_eq!((status, out["status"].as_str()), (200, Some("ok")));
    let (status, _) = f.route("POST", "/finance/chat/manual/entry-create", entry_body(450, Value::Null));
    assert_eq!(status, 500);
    assert!(f.rows("app.finance_transactions").is_empty());
}

#[test]
fn an_unknown_route_is_a_plain_404() {
    let f = Fake::new();
    assert_eq!(f.route("GET", "/finance/nope", Value::Null).0, 404);
}
