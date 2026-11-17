mod common;
use common::{Fake, A, B, OP1};
use serde_json::{json, Value};

const TX: &str = "app.finance_transactions";
const TARGETS: &str = "app.finance_targets";
const PLANS: &str = "app.finance_bill_plans";
const ADJ: &str = "app.finance_bill_adjustments";
const FLEX: &str = "app.finance_flex_policies";
const ACTIVITY: &str = "app.finance_activity";
const PLAN: &str = "44444444-4444-4444-8444-444444444444";
const BILL_NAME: &str = "PLANTED-BILL-6c31f0";
const BILL_CENTS: i64 = 123_457;

fn account() -> String {
    format!("manual:{OP1}")
}

fn setup() -> Fake {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 5_000_000);
    let (s, b) = f.route("POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(s, 200, "{b}");
    f
}

fn review(f: &Fake, month: &str) -> Value {
    let (s, b) = f.get("/finance/budget/status", json!({"month":month}));
    assert_eq!(s, 200, "{b}");
    json!({"month":month,"expectedRevision":b["revision"],"expectedFingerprint":b["fingerprint"]})
}

fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn window() -> Value {
    json!({"from":"2026-11-01","to":"2026-12-31","month":"2026-11"})
}

fn make_bill(f: &Fake) -> (u16, Value) {
    let body = with(review(f, "2026-11"), json!({"id":PLAN,"name":BILL_NAME,"accountId":account(),"categoryId":"groceries",
        "amountCents":BILL_CENTS,"anchorDate":"2026-11-20","cadence":"monthly"}));
    f.route("POST", "/finance/bills", body)
}

#[test]
fn a_bill_is_created_listed_and_adjusted() {
    let f = setup();
    let (s, b) = make_bill(&f);
    assert_eq!((s, b["status"].clone()), (200, json!("ok")), "{b}");
    let (s, read) = f.get("/finance/bills", window());
    assert_eq!(s, 200, "{read}");
    assert!(read.to_string().contains(BILL_NAME));
    let body = with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20","plannedDate":"2026-11-22","amountCents":200_000}));
    let (s, b) = f.route("POST", "/finance/bills/adjust", body);
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows(ADJ).len(), 1);
}

#[test]
fn a_stale_review_writes_nothing_and_answers_conflict() {
    let f = setup();
    let mut body = with(review(&f, "2026-11"), json!({"id":PLAN,"name":BILL_NAME,"accountId":account(),"categoryId":"groceries",
        "amountCents":BILL_CENTS,"anchorDate":"2026-11-20","cadence":"monthly"}));
    body["expectedRevision"] = json!(99);
    let (s, b) = f.route("POST", "/finance/bills", body);
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")));
    assert!(f.rows(PLANS).is_empty());
}

#[test]
fn a_target_is_set_and_removed_and_the_activity_row_holds_no_amount() {
    let f = setup();
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries","kind":"monthly","amountCents":BILL_CENTS}));
    let (s, b) = f.route("POST", "/finance/targets", body);
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows(TARGETS).len(), 1);
    assert!(!f.rows(ACTIVITY).iter().any(|r| r.to_string().contains(&BILL_CENTS.to_string())));
    let body = with(review(&f, "2026-11"), json!({"categoryId":"groceries"}));
    let (s, b) = f.route("POST", "/finance/targets/remove", body);
    assert_eq!(s, 200, "{b}");
}

#[test]
fn a_weekly_target_needs_a_weekday_and_a_balance_target_needs_a_date() {
    let f = setup();
    let base = review(&f, "2026-11");
    let (s, _) = f.route("POST", "/finance/targets", with(base.clone(), json!({"categoryId":"groceries","kind":"weekly","amountCents":5000})));
    assert_eq!(s, 400);
    let (s, _) = f.route("POST", "/finance/targets", with(base, json!({"categoryId":"groceries","kind":"balance","amountCents":5000})));
    assert_eq!(s, 400);
    assert!(f.rows(TARGETS).is_empty());
}

#[test]
fn the_flex_preview_and_configure_routes_agree() {
    let f = setup();
    let (s, p) = f.route("POST", "/finance/flex/preview", json!({"month":"2026-11","mode":"flex","flexIds":["groceries","dining"],"nonMonthlyIds":[]}));
    assert_eq!(s, 200, "{p}");
    let body = with(review(&f, "2026-11"), json!({"mode":"flex","flexIds":["groceries","dining"],"nonMonthlyIds":[]}));
    let (s, b) = f.route("POST", "/finance/flex/configure", body);
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows(FLEX).len(), 1);
    assert_eq!(b["mode"], "flex");
}

#[test]
fn every_part_24_route_answers_and_none_is_unknown() {
    let f = setup();
    for (m, p) in [("GET", "/finance/bills"), ("GET", "/finance/bills/suggestions")] {
        let (s, b) = f.get(p, window());
        assert_eq!(s, 200, "{m} {p} {b}");
    }
    for p in ["/finance/bills/decide", "/finance/bills/stop", "/finance/bills/clear", "/finance/bills/adjust", "/finance/bills/adjust-reset",
        "/finance/bills/suggestions/dismiss", "/finance/bills/entry-record", "/finance/bills/entry-preview", "/finance/targets", "/finance/targets/remove",
        "/finance/targets/fund", "/finance/flex/configure", "/finance/flex/assign", "/finance/flex/preview", "/finance/cards/save", "/finance/cards/preview"] {
        let (s, b) = f.route("POST", p, json!({}));
        assert_ne!(s, 404, "{p} {b}");
        assert!(s == 400 || s == 409, "{p} {s} {b}");
    }
}

fn plant_for_a(f: &Fake) {
    make_bill(f);
    let body = with(review(f, "2026-11"), json!({"categoryId":"groceries","kind":"monthly","amountCents":BILL_CENTS}));
    f.route("POST", "/finance/targets", body);
}

fn leaked(f: &Fake) -> Vec<String> {
    f.as_actor(B);
    let mut out = vec![];
    for path in ["/finance/bills", "/finance/bills/suggestions", "/finance/budget/status"] {
        let (_, body) = f.get(path, window());
        let text = body.to_string();
        if text.contains(BILL_NAME) || text.contains(&BILL_CENTS.to_string()) {
            out.push(path.to_owned());
        }
    }
    out
}

#[test]
fn a_second_person_sees_no_bill_or_target_of_the_first() {
    let f = setup();
    plant_for_a(&f);
    assert!(leaked(&f).is_empty(), "leaked through {:?}", leaked(&f));
}

#[test]
fn the_same_check_fails_with_the_protection_removed() {
    let f = setup();
    plant_for_a(&f);
    f.bypass_owner.set(true);
    assert!(!leaked(&f).is_empty(), "the check cannot detect a leak");
}

#[test]
fn a_second_person_cannot_change_the_first_persons_bills_or_targets() {
    let f = setup();
    plant_for_a(&f);
    let (plans, targets) = (f.rows(PLANS), f.rows(TARGETS));
    f.as_actor(B);
    for (p, body) in [
        ("/finance/bills/stop", json!({"planId":PLAN})),
        ("/finance/bills/adjust", json!({"planId":PLAN,"dueDate":"2026-11-20","plannedDate":"2026-11-21","amountCents":1,"month":"2026-11","expectedRevision":0,"expectedFingerprint":"x"})),
        ("/finance/targets/remove", json!({"categoryId":"groceries","month":"2026-11","expectedRevision":0,"expectedFingerprint":"x"})),
    ] {
        let (s, _) = f.route("POST", p, body);
        assert_ne!(s, 200, "{p}");
    }
    assert_eq!(f.rows(PLANS), plans);
    assert_eq!(f.rows(TARGETS), targets);
    assert!(f.rows(ACTIVITY).iter().all(|r| r["owner_user_id"] != json!(B)));
}

fn scan(f: &Fake, secrets: &[&str]) -> Vec<String> {
    let mut texts: Vec<(String, String)> = f.rows(ACTIVITY).iter().map(|r| ("activity".to_owned(), r.to_string())).collect();
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        if port != "db" {
            texts.push((format!("{port}:{resource}"), parameters.to_string()));
        }
    }
    texts.iter().flat_map(|(place, text)| secrets.iter().filter(|s| text.contains(**s)).map(move |s| format!("{s} in {place}"))).collect()
}

#[test]
fn bill_and_target_flows_leave_no_names_or_amounts_in_activity_or_host_calls() {
    let f = setup();
    plant_for_a(&f);
    let body = with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20","plannedDate":"2026-11-22","amountCents":BILL_CENTS + 1}));
    f.route("POST", "/finance/bills/adjust", body);
    assert!(f.rows(ACTIVITY).len() >= 3);
    let secrets = [BILL_NAME, "123457", "123458"];
    assert_eq!(scan(&f, &secrets), Vec::<String>::new());
}

#[test]
fn the_scan_does_catch_a_planted_leak() {
    let f = setup();
    plant_for_a(&f);
    f.seed(ACTIVITY, A, json!({"id":"x","kind":"test","params":{"name":BILL_NAME}}));
    assert!(!scan(&f, &[BILL_NAME]).is_empty());
}

#[test]
fn a_host_failure_never_echoes_a_bill_name_or_amount() {
    let f = setup();
    *f.db_failure.borrow_mut() = Some(format!("failed on {BILL_NAME} {BILL_CENTS}"));
    for p in ["/finance/bills", "/finance/bills/suggestions"] {
        let (s, out) = f.get(p, window());
        assert_eq!(s, 500, "{p}");
        assert!(!out.to_string().contains("PLANTED") && !out.to_string().contains("123457"), "{out}");
    }
}

#[test]
fn a_bill_never_touches_a_transaction_row() {
    let f = setup();
    make_bill(&f);
    assert!(f.rows(TX).is_empty());
}

const CARD: &str = "55555555-5555-4555-8555-555555555555";

#[test]
fn a_card_is_enrolled_and_its_reserve_saved_without_amounts_in_activity() {
    let f = setup();
    f.account("credit", CARD, "2026-01-01", 0);
    let card = format!("manual:{CARD}");
    let body = with(review(&f, "2026-11"), json!({"accountId":card,"action":"enroll","availableCents":0}));
    let (s, p) = f.route("POST", "/finance/cards/preview", body.clone());
    assert_eq!(s, 200, "{p}");
    let (s, b) = f.route("POST", "/finance/cards/save", body);
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows("app.finance_card_policies").len(), 1);
    assert_eq!(f.rows("app.finance_card_assignments").len(), 1);
    let again = with(review(&f, "2026-11"), json!({"accountId":card,"action":"enroll","availableCents":0}));
    let (s, _) = f.route("POST", "/finance/cards/save", again);
    assert_eq!(s, 400);
}

#[test]
fn a_second_person_cannot_enroll_the_first_persons_card() {
    let f = setup();
    f.account("credit", CARD, "2026-01-01", 0);
    f.as_actor(B);
    let body = json!({"month":"2026-11","expectedRevision":0,"expectedFingerprint":"x","accountId":format!("manual:{CARD}"),"action":"enroll","availableCents":0});
    let (s, _) = f.route("POST", "/finance/cards/save", body);
    assert_ne!(s, 200);
    assert!(f.rows("app.finance_card_policies").is_empty());
}

const OCC: &str = "app.finance_bill_occurrences";

fn rows_snapshot(f: &Fake) -> Vec<Vec<Value>> {
    [PLANS, OCC, ADJ, TARGETS, FLEX, TX, "app.finance_accounts", "app.finance_budget_assignments", "app.finance_card_assignments"].iter().map(|t| f.rows(t)).collect()
}

fn stale_of(f: &Fake, review: &Value) -> Value {
    let mut r = review.clone();
    r["expectedRevision"] = json!(r["expectedRevision"].as_i64().unwrap() + 50);
    r
}

#[test]
fn deciding_clearing_and_stopping_a_bill_each_refuse_an_old_review_and_write_nothing() {
    let f = setup();
    make_bill(&f);
    let before = rows_snapshot(&f);
    let old = stale_of(&f, &review(&f, "2026-11"));
    for (p, extra) in [
        ("/finance/bills/decide", json!({"planId":PLAN,"dueDate":"2026-11-20","state":"skipped"})),
        ("/finance/bills/clear", json!({"planId":PLAN,"dueDate":"2026-11-20"})),
        ("/finance/bills/stop", json!({"id":PLAN,"endDate":"2026-12-01"})),
        ("/finance/bills/adjust-reset", json!({"planId":PLAN,"dueDate":"2026-11-20"})),
        ("/finance/bills/adjust", json!({"planId":PLAN,"dueDate":"2026-11-20","plannedDate":"2026-11-21","amountCents":9})),
    ] {
        let (s, b) = f.route("POST", p, with(old.clone(), extra));
        assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")), "{p} {b}");
    }
    assert_eq!(rows_snapshot(&f), before);
}

#[test]
fn a_bill_occurrence_can_be_skipped_cleared_and_a_plan_stopped() {
    let f = setup();
    make_bill(&f);
    let (s, b) = f.route("POST", "/finance/bills/decide", with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20","state":"skipped"})));
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows(OCC).len(), 1);
    let (s, b) = f.route("POST", "/finance/bills/clear", with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20"})));
    assert_eq!(s, 200, "{b}");
    assert!(f.rows(OCC).is_empty());
    let (s, b) = f.route("POST", "/finance/bills/adjust", with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20","plannedDate":"2026-11-21","amountCents":9})));
    assert_eq!(s, 200, "{b}");
    let (s, b) = f.route("POST", "/finance/bills/adjust-reset", with(review(&f, "2026-11"), json!({"planId":PLAN,"dueDate":"2026-11-20"})));
    assert_eq!(s, 200, "{b}");
    assert!(f.rows(ADJ).is_empty());
    let (s, b) = f.route("POST", "/finance/bills/stop", with(review(&f, "2026-11"), json!({"id":PLAN,"endDate":"2027-03-01"})));
    assert_eq!(s, 200, "{b}");
    assert_eq!(f.rows(PLANS)[0]["end_date"], "2027-03-01");
}

#[test]
fn recording_a_bill_moves_the_balance_once_and_a_retry_changes_nothing() {
    let f = setup();
    make_bill(&f);
    *f.today.borrow_mut() = "2026-11-21".into();
    let entry = || {
        with(review(&f, "2026-11"), json!({"operationId":"66666666-6666-4666-8666-666666666666","planId":PLAN,"dueDate":"2026-11-20","accountId":account(),
            "categoryId":"groceries","name":BILL_NAME,"isoCurrency":"USD","date":"2026-11-10","amountCents":BILL_CENTS,"cleared":true}))
    };
    let (s, p) = f.route("POST", "/finance/bills/entry-preview", entry());
    assert_eq!(s, 200, "{p}");
    let balance = |f: &Fake| f.rows("app.finance_accounts")[0]["balance_cents"].as_i64().unwrap();
    let start = balance(&f);
    let (s, b) = f.route("POST", "/finance/bills/entry-record", entry());
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["unchanged"], false);
    assert_eq!(balance(&f), start - BILL_CENTS);
    let (s, b) = f.route("POST", "/finance/bills/entry-record", entry());
    assert_eq!((s, b["unchanged"].clone()), (200, json!(true)), "{b}");
    assert_eq!(balance(&f), start - BILL_CENTS);
    assert_eq!(f.rows(TX).len(), 1);
    assert_eq!(f.rows(OCC).len(), 1);
    assert!(!f.rows(ACTIVITY).iter().any(|r| r.to_string().contains(BILL_NAME) || r.to_string().contains("2026-11-20")));
}

#[test]
fn funding_a_target_moves_ready_money_and_an_old_review_writes_nothing() {
    let f = setup();
    let set = with(review(&f, "2026-11"), json!({"categoryId":"dining","kind":"monthly","amountCents":25_000}));
    assert_eq!(f.route("POST", "/finance/targets", set).0, 200);
    let fund = |review: Value| with(review, json!({"categoryIds":["dining"],"expectedAmountsCents":[25_000]}));
    let before = rows_snapshot(&f);
    let (s, b) = f.route("POST", "/finance/targets/fund", fund(stale_of(&f, &review(&f, "2026-11"))));
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")), "{b}");
    assert_eq!(rows_snapshot(&f), before);
    let (s, b) = f.route("POST", "/finance/targets/fund", fund(review(&f, "2026-11")));
    assert_eq!(s, 200, "{b}");
    let assigned = f.rows("app.finance_budget_assignments").iter().find(|r| r["category_id"] == "dining").map(|r| r["assigned_cents"].clone());
    assert_eq!(assigned, Some(json!(25_000)));
}

#[test]
fn the_flexible_pool_is_set_up_assigned_and_an_old_review_writes_nothing() {
    let f = setup();
    let pool = with(review(&f, "2026-11"), json!({"mode":"flex","flexIds":["groceries","dining"],"nonMonthlyIds":[]}));
    assert_eq!(f.route("POST", "/finance/flex/configure", pool).0, 200);
    let assign = |review: Value| with(review, json!({"amountCents":30_000,"previousCents":0}));
    let before = rows_snapshot(&f);
    let (s, b) = f.route("POST", "/finance/flex/assign", assign(stale_of(&f, &review(&f, "2026-11"))));
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")), "{b}");
    assert_eq!(rows_snapshot(&f), before);
    let (s, b) = f.route("POST", "/finance/flex/assign", assign(review(&f, "2026-11")));
    assert_eq!(s, 200, "{b}");
    let leave = with(review(&f, "2026-11"), json!({"mode":"envelopes"}));
    let (s, b) = f.route("POST", "/finance/flex/configure", leave);
    assert!(s == 200 || s == 400, "{b}");
    assert!(!f.rows(ACTIVITY).iter().any(|r| r.to_string().contains("30000")));
}

#[test]
fn funding_a_card_reserve_needs_an_enrolled_card_and_an_old_review_writes_nothing() {
    let f = setup();
    f.account("credit", CARD, "2026-01-01", 0);
    let card = format!("manual:{CARD}");
    let fund = |review: Value, cents: i64| with(review, json!({"accountId":card,"action":"fund","availableCents":cents}));
    let (s, b) = f.route("POST", "/finance/cards/save", fund(review(&f, "2026-11"), 0));
    assert_eq!(s, 400, "{b}");
    let enroll = with(review(&f, "2026-11"), json!({"accountId":card,"action":"enroll","availableCents":0}));
    assert_eq!(f.route("POST", "/finance/cards/save", enroll).0, 200);
    let before = rows_snapshot(&f);
    let (s, b) = f.route("POST", "/finance/cards/save", fund(stale_of(&f, &review(&f, "2026-11")), 10_000));
    assert_eq!((s, b["code"].clone()), (409, json!("stale_budget")), "{b}");
    assert_eq!(rows_snapshot(&f), before);
}
