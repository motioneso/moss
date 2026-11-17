//! Part 25: household sharing, reports, export, activity undo and category archive.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const SECRET_NOTE: &str = "PLANTED-NOTE-a41c7e";
const SECRET_MERCHANT: &str = "PLANTED-MERCHANT-62d9b0";
const SECRET_ACCOUNT: &str = "PLANTED-ACCOUNT-30fe88";
const SECRET_OFFICIAL: &str = "PLANTED-OFFICIAL-b7712c";
const BALANCE: i64 = 4_417_013;

fn bank_account(f: &Fake, owner: &str, id: &str) {
    f.seed(
        "app.finance_accounts",
        owner,
        json!({"account_id":id,"item_id":"item-1","name":SECRET_ACCOUNT,"official_name":SECRET_OFFICIAL,"type":"depository","subtype":"checking",
            "mask":"1234","balance_cents":BALANCE,"iso_currency":"USD","updated_at":"2026-11-10T08:00:00Z","shared_to_household":false,
            "source":"provider","ledger_revision":0,"archived_at":null,"opening_date":null,"opening_balance_cents":null}),
    );
}

fn spend(f: &Fake, owner: &str, id: &str, account: &str, cents: i64, category: &str) {
    f.seed(
        "app.finance_transactions",
        owner,
        json!({"id":id,"account_id":account,"date":"2026-11-05","amount_cents":cents,"iso_currency":"USD","name":"Card purchase","merchant":SECRET_MERCHANT,
            "category_id":category,"pending":false,"splits":[],"notes":SECRET_NOTE,"transfer_id":null,"review_state":"confirmed",
            "categorized_by":"user","ai_confidence":0.9,"source":"provider","split_revision":0,"cleared":false,"reconciled_at":null,
            "plaid_category":null,"pending_transaction_id":null}),
    );
}

fn share(f: &Fake, account: &str, on: bool) -> (u16, Value) {
    f.route("POST", "/finance/accounts/shared", json!({"accountId":account,"shared":on}))
}

#[test]
fn a_shared_account_shows_the_other_person_only_the_allowed_fields() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    assert_eq!(share(&f, "acct-a", true).0, 200);

    f.as_actor(B);
    let (_, accounts) = f.get("/finance/accounts", json!({}));
    let list = accounts["accounts"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["ownerUserId"], A);
    assert_eq!(list[0]["shared"], true);
    assert_eq!(list[0]["balanceCents"], BALANCE);
    assert!(list[0].get("officialName").is_none() && list[0].get("itemStatus").is_none());
    let (_, month) = f.get("/finance/transactions", json!({"month":"2026-11"}));
    let rows = month["transactions"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["ownerUserId"], A);
    assert_eq!(rows[0]["shared"], true);
    assert_eq!(rows[0]["amountCents"], 2500);
    assert_eq!(month["needsLookCount"], 0);

    // Nothing private crosses, in any field the other person can read.
    let seen = format!("{accounts}{month}");
    for secret in [SECRET_NOTE, SECRET_OFFICIAL] {
        assert!(!seen.contains(secret), "{secret} reached the other person");
    }
    let mirror = f.rows("app.finance_shared_transactions").iter().map(Value::to_string).collect::<String>();
    assert!(!mirror.contains(SECRET_NOTE) && !mirror.contains("ai_confidence") && !mirror.contains("review_state"));

    // The owner still sees only their own account, once.
    f.as_actor(A);
    let (_, own) = f.get("/finance/accounts", json!({}));
    assert_eq!(own["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(own["accounts"][0]["sharedToHousehold"], true);
}

#[test]
fn unsharing_removes_everything_the_other_person_saw() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    share(&f, "acct-a", true);
    assert_eq!(share(&f, "acct-a", false).0, 200);
    f.as_actor(B);
    let (_, accounts) = f.get("/finance/accounts", json!({}));
    assert!(accounts["accounts"].as_array().unwrap().is_empty());
    assert!(f.rows("app.finance_shared_transactions").is_empty());
}

#[test]
fn a_new_transaction_reaches_the_copy_and_a_deleted_one_leaves_it() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    share(&f, "acct-a", true);
    spend(&f, A, "t2", "acct-a", 900, "dining");
    moss_finance_module::shared::sync_mirror(&f).unwrap();
    assert_eq!(f.rows("app.finance_shared_transactions").len(), 2);
    f.tables.borrow_mut().get_mut("app.finance_transactions").unwrap().retain(|r| r["id"] != "t1");
    moss_finance_module::shared::sync_mirror(&f).unwrap();
    assert_eq!(f.rows("app.finance_shared_transactions").len(), 1);
}

#[test]
fn sharing_refuses_unknown_and_manual_accounts() {
    let f = Fake::new();
    assert_eq!(share(&f, "nope", true).1["code"], "unknown_account");
    f.account("checking", common::OP1, "2026-01-01", 100);
    let (status, body) = share(&f, &format!("manual:{}", common::OP1), true);
    assert_eq!((status, body["code"].clone()), (400, json!("manual_sharing_unavailable")));
}

#[test]
fn sharing_leaves_no_private_text_in_activity_rows_or_outside_calls() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    share(&f, "acct-a", true);
    for row in f.rows("app.finance_activity") {
        let text = row.to_string();
        for secret in [SECRET_NOTE, SECRET_MERCHANT, SECRET_ACCOUNT, SECRET_OFFICIAL, &BALANCE.to_string()] {
            assert!(!text.contains(secret), "{secret} in activity row {text}");
        }
    }
    for (port, _, _, parameters) in f.calls.borrow().iter() {
        if port != "db" {
            assert!(!parameters.to_string().contains(SECRET_MERCHANT));
        }
    }
}

#[test]
fn export_holds_only_the_callers_rows() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    bank_account(&f, B, "acct-b");
    spend(&f, A, "ta", "acct-a", 2500, "groceries");
    f.seed("app.finance_transactions", B, json!({"id":"tb","account_id":"acct-b","date":"2026-11-06","amount_cents":777,"iso_currency":"USD",
        "name":"OTHER-PERSON-ROW","merchant":null,"category_id":null,"pending":false,"splits":[],"transfer_id":null,"source":"provider"}));
    share(&f, "acct-a", true);
    f.as_actor(B);
    share(&f, "acct-b", true);
    let (status, out) = f.get("/finance/transactions/export", json!({}));
    assert_eq!(status, 200, "{out}");
    let csv = out["csv"].as_str().unwrap();
    assert_eq!(out["totalCount"], 1);
    assert!(csv.contains("\"tb\"") && !csv.contains("\"ta\"") && !csv.contains(SECRET_MERCHANT));
}

#[test]
fn export_refuses_bad_dates_and_reports_too_many() {
    let f = Fake::new();
    let (status, body) = f.get("/finance/transactions/export", json!({"from":"2026-12-01","through":"2026-11-01"}));
    assert_eq!((status, body["status"].clone()), (400, json!("error")));
}

#[test]
fn spending_report_counts_only_the_callers_own_rows_and_lists_shared_apart() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    bank_account(&f, B, "acct-b");
    spend(&f, A, "ta", "acct-a", 2500, "groceries");
    spend(&f, B, "tb", "acct-b", 900, "dining");
    f.as_actor(B);
    share(&f, "acct-b", true);
    f.as_actor(A);
    let (status, report) = f.get("/finance/reports/spending", json!({"months":"1"}));
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["own"][0]["cashFlow"]["outflowCents"], 2500);
    assert_eq!(report["shared"][0]["ownerUserId"], B);
    assert_eq!(report["shared"][0]["months"][0]["cashFlow"]["outflowCents"], 900);

    // With the owner-only protection removed the first number would include the other person's row.
    f.bypass_owner.set(true);
    let (_, leaked) = f.get("/finance/reports/spending", json!({"months":"1"}));
    f.bypass_owner.set(false);
    assert_ne!(leaked["own"][0]["cashFlow"]["outflowCents"], 2500, "the isolation check cannot fail");
}

#[test]
fn detail_rows_name_shared_accounts_generically() {
    let f = Fake::new();
    bank_account(&f, B, "acct-b");
    spend(&f, B, "tb", "acct-b", 900, "dining");
    f.as_actor(B);
    share(&f, "acct-b", true);
    f.as_actor(A);
    let (status, out) = f.get("/finance/reports/transactions", json!({"month":"2026-11","currency":"USD","group":"outflow","sharedOwnerIds":[B]}));
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["rows"][0]["accountName"], "Shared account");
    assert!(!out.to_string().contains(SECRET_ACCOUNT) && !out.to_string().contains(SECRET_NOTE));
    let (status, out) = f.get("/finance/reports/transactions", json!({"month":"2020-01","currency":"USD"}));
    assert_eq!((status, out["code"].clone()), (409, json!("report_scope_changed")));
}

#[test]
fn net_worth_is_never_shared() {
    let f = Fake::new();
    bank_account(&f, B, "acct-b");
    f.seed("app.finance_balance_snapshots", B, json!({"account_id":"acct-b","day":"2026-11-05","balance_cents":BALANCE}));
    f.as_actor(B);
    share(&f, "acct-b", true);
    f.as_actor(A);
    let (_, out) = f.get("/finance/reports/net-worth", json!({}));
    assert_eq!(out["points"], json!([]));
    assert_eq!(out["headlineCents"], Value::Null);
}

fn categorize(f: &Fake, id: &str, category: &str) -> (u16, Value) {
    f.route("POST", "/finance/transactions/category", json!({"transactionId":id,"accountId":"acct-a","month":"2026-11","categoryId":category}))
}

#[test]
fn undoing_a_categorize_restores_the_old_category_once() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    let (status, body) = categorize(&f, "t1", "dining");
    assert_eq!(status, 200, "{body}");
    let (_, list) = f.get("/finance/activity", json!({"from":"2026-01-01T00:00:00Z","to":"2026-12-31T00:00:00Z"}));
    let item = list["activity"].as_array().unwrap().iter().find(|a| a["undoable"] == true).expect("an undoable row").clone();
    let (status, done) = f.route("POST", "/finance/activity/undo", json!({"activityId":item["id"]}));
    assert_eq!((status, done["undone"].clone()), (200, json!(true)), "{done}");
    let tx = f.rows("app.finance_transactions").into_iter().find(|r| r["id"] == "t1").unwrap();
    assert_eq!(tx["category_id"], "groceries");
    let (_, again) = f.route("POST", "/finance/activity/undo", json!({"activityId":item["id"]}));
    assert_eq!(again["alreadyUndone"], true);
}

#[test]
fn undo_refuses_when_the_category_moved_on() {
    let f = Fake::new();
    bank_account(&f, A, "acct-a");
    spend(&f, A, "t1", "acct-a", 2500, "groceries");
    categorize(&f, "t1", "dining");
    let first = f.rows("app.finance_activity")[0]["id"].clone();
    f.tables.borrow_mut().get_mut("app.finance_transactions").unwrap()[0]["category_id"] = json!("fun");
    let (status, body) = f.route("POST", "/finance/activity/undo", json!({"activityId":first}));
    assert_eq!((status, body["code"].clone()), (409, json!("changed_since")));
    let (status, body) = f.route("POST", "/finance/activity/undo", json!({"activityId":"missing"}));
    assert_eq!((status, body["code"].clone()), (404, json!("not_found")));
}

#[test]
fn an_activity_row_without_an_undo_record_cannot_be_undone() {
    let f = Fake::new();
    f.account("checking", common::OP1, "2026-01-01", 100);
    let id = f.rows("app.finance_activity")[0]["id"].clone();
    let (status, body) = f.route("POST", "/finance/activity/undo", json!({"activityId":id}));
    assert_eq!((status, body["code"].clone()), (400, json!("not_undoable")));
}

#[test]
fn archiving_needs_a_saved_category_list_and_protects_income() {
    let f = Fake::new();
    let (status, body) = f.route("POST", "/finance/categories/archive", json!({"id":"income"}));
    assert_eq!((status, body["code"].clone()), (400, json!("protected_category")));
    let (_, body) = f.route("POST", "/finance/categories/archive", json!({"id":"fun"}));
    assert_eq!(body["code"], "budget_currency_required");
}

#[test]
fn an_empty_category_archives_and_the_archive_can_be_undone() {
    let f = Fake::new();
    f.seed("app.finance_budget_policy", A, json!({"iso_currency":"USD","revision":1,"taxonomy_ready":true}));
    f.seed("app.finance_categories", A, json!({"id":"fun","group_name":"Fun","name":"Fun money","sort_order":1,"is_income":false,"archived_at":null}));
    let (status, body) = f.route("POST", "/finance/categories/archive", json!({"id":"fun"}));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["after"]["archived"], true);
    assert!(!f.rows("app.finance_categories")[0]["archived_at"].is_null());
    let id = f.rows("app.finance_activity")[0]["id"].clone();
    let (status, done) = f.route("POST", "/finance/activity/undo", json!({"activityId":id}));
    assert_eq!(status, 200, "{done}");
    assert!(f.rows("app.finance_categories")[0]["archived_at"].is_null());
}

#[test]
fn a_category_holding_budget_money_is_not_archived() {
    let f = Fake::new();
    f.seed("app.finance_budget_policy", A, json!({"iso_currency":"USD","revision":1,"taxonomy_ready":true}));
    f.seed("app.finance_categories", A, json!({"id":"fun","group_name":"Fun","name":"Fun money","sort_order":1,"is_income":false,"archived_at":null}));
    f.seed("app.finance_budget_assignments", A, json!({"month":"2026-12","category_id":"fun","assigned_cents":500}));
    let (status, body) = f.route("POST", "/finance/categories/archive", json!({"id":"fun"}));
    assert_eq!((status, body["code"].clone()), (409, json!("has_assignments")), "{body}");
}
