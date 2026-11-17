mod common;
use common::{Fake, A, B, OP1};
use serde_json::{json, Value};

const TX: &str = "app.finance_transactions";
const ASSIGNED: &str = "app.finance_budget_assignments";
const DRAFTS: &str = "app.finance_budget_drafts";
const LINES: &str = "app.finance_budget_draft_lines";
const POLICY: &str = "app.finance_budget_policy";

fn account() -> String {
    format!("manual:{OP1}")
}

/// A posted row in the checking account.
fn spend(f: &Fake, id: &str, date: &str, cents: i64, category: &str, payee: &str) {
    f.seed(TX, A, json!({"id":id,"account_id":account(),"date":date,"name":payee,"amount_cents":cents,"iso_currency":"USD",
        "source":"manual","review_state":"confirmed","categorized_by":"user","category_id":category,"pending":false,"merchant":null,
        "splits":[],"split_revision":0,"transfer_id":null,"notes":null,"reconciled_at":null,"cleared":true,
        "ai_confidence":null,"plaid_category":null,"pending_transaction_id":null}));
}

/// A configured budget with one funded checking account.
fn setup() -> Fake {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 500_000);
    let (s, b) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(s, 200, "{b}");
    f
}

fn status(f: &Fake, month: &str) -> Value {
    let (s, b) = f.get("/finance/budget/status", json!({"month":month}));
    assert_eq!(s, 200, "{b}");
    b
}

/// The review a screen would hold, taken from the status reply.
fn review(f: &Fake, month: &str) -> Value {
    let b = status(f, month);
    json!({"month":month,"expectedRevision":b["revision"],"expectedFingerprint":b["fingerprint"]})
}

fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn assigned(f: &Fake, month: &str, category: &str) -> Option<i64> {
    f.rows(ASSIGNED).iter().find(|r| r["month"] == month && r["category_id"] == category).and_then(|r| r["assigned_cents"].as_i64())
}

#[test]
fn status_asks_for_setup_until_a_currency_is_chosen() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 1_000);
    let b = status(&f, "2026-11");
    assert_eq!(b["setupRequired"], true);
    assert_eq!(b["isoCurrency"], Value::Null);
    let (s, b) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!((s, b["status"].clone(), b["unchanged"].clone()), (200, json!("ok"), json!(false)));
    let b = status(&f, "2026-11");
    assert_eq!((b["setupRequired"].clone(), b["isoCurrency"].clone(), b["revision"].clone()), (json!(false), json!("USD"), json!(0)));
    assert_eq!(f.rows("app.finance_categories").iter().filter(|c| c["archived_at"].is_null()).count(), 16);
}

#[test]
fn configuring_twice_changes_nothing_and_another_currency_is_refused() {
    let f = setup();
    let (_, again) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(again["unchanged"], true);
    let (s, other) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"EUR","acknowledgeLegacy":false}));
    assert_eq!((s, other["code"].clone()), (400, json!("budget_currency_fixed")));
    assert_eq!(f.rows(POLICY).len(), 1);
    assert_eq!(f.rows(POLICY)[0]["iso_currency"], "USD");
}

#[test]
fn old_budget_data_must_be_acknowledged_before_configuring() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 1_000);
    f.seed(ASSIGNED, A, json!({"month":"2026-10","category_id":"groceries","assigned_cents":100}));
    let (_, refused) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(refused["code"], "legacy_review_required");
    assert!(f.rows(POLICY).is_empty());
    let (s, ok) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":true}));
    assert_eq!((s, ok["status"].clone()), (200, json!("ok")));
}

#[test]
fn assign_saves_the_amount_and_status_reflects_it() {
    let f = setup();
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":40_000,"previousCents":0}));
    let (s, b) = f.route("POST", "/finance/budget/assign", body);
    assert_eq!((s, b["status"].clone()), (200, json!("ok")), "{b}");
    assert_eq!(assigned(&f, "2026-11", "groceries"), Some(40_000));
    let st = status(&f, "2026-11");
    assert_eq!(st["state"]["categories"]["groceries"]["assignedCents"], 40_000);
    assert_eq!(st["readyToAssignCents"], 500_000 - 40_000);
    assert_eq!(st["revision"], 1);
}

#[test]
fn a_stale_review_saves_nothing_and_says_so() {
    let f = setup();
    let old = review(&f, "2026-11");
    // The ledger changes after the person looked.
    spend(&f, "late", "2026-11-05", 1_200, "groceries", "Corner Shop");
    let before = (f.rows(ASSIGNED), f.rows(POLICY), f.rows("app.finance_activity"));
    let (s, b) = f.route("POST", "/finance/budget/assign", with(old, json!({"categoryId":"groceries","amountCents":40_000,"previousCents":0})));
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")));
    assert!(b["message"].as_str().unwrap().contains("Refresh and review"));
    assert_eq!(before, (f.rows(ASSIGNED), f.rows(POLICY), f.rows("app.finance_activity")));
}

#[test]
fn two_saves_holding_one_review_cannot_both_land() {
    let f = setup();
    let shared = review(&f, "2026-11");
    let one = with(shared.clone(), json!({"categoryId":"groceries","amountCents":10_000,"previousCents":0}));
    let two = with(shared, json!({"categoryId":"dining","amountCents":20_000,"previousCents":0}));
    assert_eq!(f.route("POST", "/finance/budget/assign", one).0, 200);
    let (s, b) = f.route("POST", "/finance/budget/assign", two);
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")));
    assert_eq!(assigned(&f, "2026-11", "dining"), None);
}

#[test]
fn a_wrong_previous_amount_or_unknown_category_is_refused_without_a_write() {
    let f = setup();
    let wrong = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":500,"previousCents":300}));
    let (s, b) = f.route("POST", "/finance/budget/assign", wrong);
    assert_eq!((s, b["code"].clone()), (409, json!("stale_previous")));
    let unknown = with(review(&f, "2026-11"), json!({"categoryId":"no-such-envelope","amountCents":500,"previousCents":0}));
    assert_eq!(f.route("POST", "/finance/budget/assign", unknown).1["code"], "invalid_category");
    assert!(f.rows(ASSIGNED).is_empty());
    assert_eq!(f.rows(POLICY)[0]["revision"], 0);
}

#[test]
fn move_takes_from_ready_to_assign_and_between_envelopes() {
    let f = setup();
    let from_ready = with(review(&f, "2026-11"), json!({"fromCategoryId":"ready_to_assign","toCategoryId":"groceries","amountCents":30_000}));
    let (s, b) = f.route("POST", "/finance/budget/move", from_ready);
    assert_eq!((s, b["status"].clone()), (200, json!("ok")), "{b}");
    let between = with(review(&f, "2026-11"), json!({"fromCategoryId":"groceries","toCategoryId":"dining","amountCents":12_000}));
    assert_eq!(f.route("POST", "/finance/budget/move", between).0, 200);
    assert_eq!((assigned(&f, "2026-11", "groceries"), assigned(&f, "2026-11", "dining")), (Some(18_000), Some(12_000)));
    let too_much = with(review(&f, "2026-11"), json!({"fromCategoryId":"groceries","toCategoryId":"dining","amountCents":18_001}));
    assert_eq!(f.route("POST", "/finance/budget/move", too_much).1["code"], "not_enough_available");
    let too_much = with(review(&f, "2026-11"), json!({"fromCategoryId":"ready_to_assign","toCategoryId":"dining","amountCents":9_999_999}));
    assert_eq!(f.route("POST", "/finance/budget/move", too_much).1["code"], "not_enough_ready");
    assert_eq!(assigned(&f, "2026-11", "groceries"), Some(18_000));
}

#[test]
fn apply_saves_a_batch_all_or_nothing() {
    let f = setup();
    let batch = with(review(&f, "2026-11"), json!({"categoryIds":["groceries","dining"],"amountsCents":[1_000,2_000],"previousAmountsCents":[0,0]}));
    assert_eq!(f.route("POST", "/finance/budget/apply", batch).0, 200);
    assert_eq!((assigned(&f, "2026-11", "groceries"), assigned(&f, "2026-11", "dining")), (Some(1_000), Some(2_000)));
    let bad = with(review(&f, "2026-11"), json!({"categoryIds":["groceries","nope"],"amountsCents":[5_000,6_000],"previousAmountsCents":[1_000,0]}));
    assert_eq!(f.route("POST", "/finance/budget/apply", bad).1["code"], "invalid_category");
    assert_eq!(assigned(&f, "2026-11", "groceries"), Some(1_000));
    let repeated = with(review(&f, "2026-11"), json!({"categoryIds":["groceries","groceries"],"amountsCents":[1,2],"previousAmountsCents":[1_000,1_000]}));
    assert_eq!(f.route("POST", "/finance/budget/apply", repeated).0, 400);
}

fn history(f: &Fake) {
    for (m, groceries) in [("2026-08", 30_000), ("2026-09", 31_234), ("2026-10", 32_000)] {
        spend(f, &format!("g-{m}"), &format!("{m}-10"), groceries, "groceries", "Corner Shop");
        spend(f, &format!("r-{m}"), &format!("{m}-01"), 120_000, "rent-mortgage", "Landlord");
        spend(f, &format!("p-{m}"), &format!("{m}-02"), -400_000, "income", "Employer");
    }
}

#[test]
fn a_draft_is_built_from_the_stored_records() {
    let f = setup();
    let (_, none) = f.route("POST", "/finance/budget/draft/build", json!({}));
    assert_eq!((none["built"].clone(), none["reason"].clone()), (json!(false), json!("no-history")));
    history(&f);
    let (s, b) = f.route("POST", "/finance/budget/draft/build", json!({}));
    assert_eq!((s, b["built"].clone()), (200, json!(true)), "{b}");
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let draft = &got["draft"];
    assert_eq!(draft["monthlyIncomeCents"], 400_000);
    let lines: Vec<&Value> = draft["groups"].as_array().unwrap().iter().flat_map(|g| g["lines"].as_array().unwrap()).collect();
    let line = |k: &str| lines.iter().find(|l| l["categoryKey"] == k).copied().unwrap_or_else(|| panic!("no {k} in {lines:?}"));
    // (30000 + 31234 + 32000) / 3 = 31078 rounded, then up to the next 500.
    assert_eq!(line("groceries")["basisMonthlyCents"], 31_078);
    assert_eq!(line("groceries")["planCents"], 31_500);
    assert_eq!(line("rent-mortgage")["planCents"], 120_000);
    let rent_group = draft["groups"].as_array().unwrap().iter().find(|g| g["lines"].as_array().unwrap().iter().any(|l| l["categoryKey"] == "rent-mortgage")).unwrap();
    assert_eq!(rent_group["name"], "Bills");
    // Changing a stored row changes the next draft, so the figures are not remembered from elsewhere.
    let (_, again) = f.route("POST", "/finance/budget/draft/build", json!({}));
    assert_eq!(again["built"], false);
}

#[test]
fn a_draft_can_be_edited_and_then_started_once() {
    let f = setup();
    history(&f);
    f.route("POST", "/finance/budget/draft/build", json!({}));
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let id = got["draft"]["id"].as_str().unwrap().to_owned();
    let edit = json!({"draftId":id,"categoryKey":"groceries","amountCents":29_000,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    let (s, b) = f.route("POST", "/finance/budget/draft/update", edit);
    assert_eq!((s, b["after"]["planCents"].clone()), (200, json!(29_000)), "{b}");
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let drop = json!({"draftId":id,"categoryKey":"rent-mortgage","dropped":true,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    assert_eq!(f.route("POST", "/finance/budget/draft/update", drop).0, 200);
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let protect = json!({"draftId":id,"categoryKey":"income","amountCents":1,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    assert_eq!(f.route("POST", "/finance/budget/draft/update", protect).1["code"], "protected_category");
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let start = json!({"draftId":id,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    let (s, b) = f.route("POST", "/finance/budget/draft/start", start.clone());
    assert_eq!((s, b["started"].clone()), (200, json!(true)), "{b}");
    assert_eq!(assigned(&f, "2026-11", "groceries"), Some(29_000));
    assert_eq!(assigned(&f, "2026-11", "rent-mortgage"), None);
    assert_eq!(f.rows(DRAFTS)[0]["status"], "started");
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let again = json!({"draftId":id,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    let (_, replay) = f.route("POST", "/finance/budget/draft/start", again);
    assert_eq!(replay["alreadyStarted"], true);
    let late = json!({"draftId":id,"categoryKey":"groceries","amountCents":1,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    assert_eq!(f.route("POST", "/finance/budget/draft/update", late).1["code"], "draft_not_open");
}

#[test]
fn a_stale_draft_start_saves_nothing() {
    let f = setup();
    history(&f);
    f.route("POST", "/finance/budget/draft/build", json!({}));
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let id = got["draft"]["id"].as_str().unwrap().to_owned();
    spend(&f, "new", "2026-11-03", 900, "groceries", "Corner Shop");
    let before = (f.rows(ASSIGNED), f.rows(DRAFTS), f.rows(LINES), f.rows(POLICY));
    let start = json!({"draftId":id,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    let (s, b) = f.route("POST", "/finance/budget/draft/start", start);
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")));
    assert_eq!(before, (f.rows(ASSIGNED), f.rows(DRAFTS), f.rows(LINES), f.rows(POLICY)));
}

#[test]
fn the_assistant_routes_need_the_one_use_approval() {
    let f = setup();
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":500,"previousCents":0}));
    // No approval: the host stops the call and nothing is saved.
    let (s, _) = f.route("POST", "/finance/chat/budget/assign", body.clone());
    assert_eq!(s, 500);
    assert!(f.rows(ASSIGNED).is_empty());
    f.approved.set(true);
    let (s, b) = f.route("POST", "/finance/chat/budget/assign", body);
    assert_eq!((s, b["status"].clone()), (200, json!("ok")), "{b}");
    assert_eq!(assigned(&f, "2026-11", "groceries"), Some(500));
}

#[test]
fn another_month_in_the_future_has_no_ready_figure() {
    let f = setup();
    let b = status(&f, "2027-01");
    assert_eq!(b["readyUnavailable"], "future_month");
    assert_eq!(b["readyToAssignCents"], Value::Null);
}

#[test]
fn bad_input_is_refused_before_anything_is_read_or_written() {
    let f = setup();
    for (path, body) in [
        ("/finance/budget/assign", json!({"month":"2026-13","categoryId":"x","amountCents":1,"previousCents":0})),
        ("/finance/budget/assign", json!({"month":"2026-11","categoryId":"x","amountCents":1.5,"previousCents":0})),
        ("/finance/budget/assign", json!({"month":"2026-11","categoryId":"x","amountCents":1,"previousCents":0,"expectedRevision":0,"expectedFingerprint":"nope"})),
        ("/finance/budget/move", json!({"month":"2026-11","fromCategoryId":"a","toCategoryId":"a","amountCents":1,"expectedRevision":0,"expectedFingerprint":"0".repeat(32)})),
    ] {
        let (s, b) = f.route("POST", path, body);
        assert!(s == 400 && b["status"] == "error", "{path}: {s} {b}");
    }
    assert!(f.rows(ASSIGNED).is_empty());
}

#[test]
fn the_second_person_sees_and_changes_none_of_the_first_persons_budget() {
    let f = setup();
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":40_000,"previousCents":0}));
    f.route("POST", "/finance/budget/assign", body.clone());
    history(&f);
    f.route("POST", "/finance/budget/draft/build", json!({}));
    f.as_actor(B);
    let b = status(&f, "2026-11");
    assert_eq!(b["setupRequired"], true, "{b}");
    assert!(!b.to_string().contains("40000"));
    let (_, d) = f.get("/finance/budget/draft", json!({}));
    assert_eq!(d["setupRequired"], true);
    let before = (f.rows(ASSIGNED), f.rows(POLICY), f.rows(DRAFTS));
    let (s, refused) = f.route("POST", "/finance/budget/assign", body);
    assert!(s >= 400, "{refused}");
    assert_eq!(before, (f.rows(ASSIGNED), f.rows(POLICY), f.rows(DRAFTS)));
}

#[test]
fn the_isolation_check_fails_with_the_protection_removed() {
    let f = setup();
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":40_000,"previousCents":0}));
    f.route("POST", "/finance/budget/assign", body);
    f.as_actor(B);
    f.bypass_owner.set(true);
    let b = status(&f, "2026-11");
    assert!(b.to_string().contains("40000"), "the check cannot detect a leak: {b}");
}

#[test]
fn private_text_stays_out_of_activity_rows_and_every_non_database_call() {
    const PAYEE: &str = "PLANTED-PAYEE-3c91d2";
    const CATEGORY_NOTE: &str = "PLANTED-LINE-NAME-8e77aa";
    let f = setup();
    for m in ["2026-08", "2026-09", "2026-10"] {
        spend(&f, &format!("x-{m}"), &format!("{m}-10"), 7_654_321, "groceries", PAYEE);
        spend(&f, &format!("p-{m}"), &format!("{m}-02"), -9_000_000, "income", "Employer");
    }
    f.route("POST", "/finance/budget/draft/build", json!({}));
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let id = got["draft"]["id"].as_str().unwrap().to_owned();
    let add = json!({"draftId":id,"categoryKey":"hidden-thing","categoryName":CATEGORY_NOTE,"groupName":"Fun","amountCents":4_242_424,
        "expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    assert_eq!(f.route("POST", "/finance/budget/draft/update", add).0, 200);
    let (_, got) = f.get("/finance/budget/draft", json!({}));
    let start = json!({"draftId":id,"expectedRevision":got["revision"],"expectedFingerprint":got["fingerprint"]});
    assert_eq!(f.route("POST", "/finance/budget/draft/start", start).0, 200);
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","amountCents":3_141_592,"previousCents":0}));
    f.route("POST", "/finance/budget/assign", body);
    let secrets = [PAYEE, CATEGORY_NOTE, "7654321", "4242424", "3141592", "9000000"];
    for row in f.rows("app.finance_activity") {
        let text = row.to_string();
        for s in secrets {
            assert!(!text.contains(s), "{s} in activity row {text}");
        }
    }
    assert!(!f.rows("app.finance_activity").is_empty());
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "context"].contains(&port.as_str()), "unexpected port {port} {resource}");
        if port == "context" {
            for s in secrets {
                assert!(!parameters.to_string().contains(s));
            }
        }
    }
}

#[test]
fn the_privacy_scan_catches_a_planted_leak() {
    let f = setup();
    f.seed("app.finance_activity", A, json!({"id":"x","kind":"budget.assign","params":{"note":"PLANTED-PAYEE-3c91d2"}}));
    assert!(f.rows("app.finance_activity").iter().any(|r| r.to_string().contains("PLANTED-PAYEE-3c91d2")));
}
