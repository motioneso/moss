mod common;
use common::{Fake, A};
use serde_json::{json, Value};

const TX: &str = "app.finance_transactions";
const ACCT: &str = "acct-1";

fn row(id: &str, date: &str, name: &str, cents: i64) -> Value {
    json!({"id":id,"account_id":ACCT,"date":date,"name":name,"amount_cents":cents,"iso_currency":"USD","source":"manual",
        "review_state":"confirmed","categorized_by":"user","category_id":"groceries","pending":false,"merchant":null,
        "splits":[],"split_revision":0,"transfer_id":null,"notes":null,"reconciled_at":null,"cleared":false,
        "ai_confidence":null,"plaid_category":null,"pending_transaction_id":null})
}
fn put(f: &Fake, mut r: Value, patch: Value) -> String {
    for (k, v) in patch.as_object().unwrap() {
        r[k.as_str()] = v.clone();
    }
    let id = r["id"].as_str().unwrap().to_owned();
    f.seed(TX, A, r);
    id
}
fn stored(f: &Fake, id: &str) -> Value {
    f.rows(TX).into_iter().find(|r| r["id"] == id).unwrap()
}
fn revision(f: &Fake, id: &str) -> String {
    let (_, out) = f.get("/finance/transactions", json!({"month":"2026-11","transactionId":id}));
    out["transactions"][0]["writeRevision"].as_str().unwrap().to_owned()
}
fn kinds(f: &Fake) -> Vec<String> {
    f.rows("app.finance_activity").iter().map(|r| r["kind"].as_str().unwrap().to_owned()).collect()
}
fn month_body(id: &str, category: &str) -> Value {
    json!({"transactionId":id,"accountId":ACCT,"month":"2026-11","categoryId":category})
}

#[test]
fn the_month_query_filters_sorts_and_counts_like_the_old_one() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Corner Cafe", 450), json!({"notes":"for Sam"}));
    put(&f, row("t2", "2026-11-09", "Pay Day", -200000), json!({"category_id":"income"}));
    put(&f, row("t3", "2026-11-09", "Market", 1250), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    put(&f, row("t4", "2026-10-30", "Old Shop", 100), json!({}));
    put(&f, row("t5", "2026-11-09", "Pending Shop", 800), json!({"pending":true}));
    let (s, out) = f.get("/finance/transactions", json!({}));
    assert_eq!(s, 200);
    assert_eq!(out["month"], "2026-11");
    let ids: Vec<&str> = out["transactions"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["t2", "t3", "t5", "t1"]);
    assert_eq!((out["totalCount"].clone(), out["needsLookCount"].clone()), (json!(4), json!(1)));
    assert_eq!(out["supportsSplits"], true);
    let q = |query: Value| -> Vec<String> {
        let (s, o) = f.get("/finance/transactions", query);
        assert_eq!(s, 200, "{o}");
        o["transactions"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(q(json!({"search":"SAM"})), ["t1"]);
    assert_eq!(q(json!({"direction":"inflow"})), ["t2"]);
    assert_eq!(q(json!({"pendingOnly":"true"})), ["t5"]);
    assert_eq!(q(json!({"postingState":"posted"})), ["t2", "t3", "t1"]);
    assert_eq!(q(json!({"uncategorizedOnly":true})), ["t3"]);
    assert_eq!(q(json!({"needsLookOnly":true})), ["t3"]);
    assert_eq!(q(json!({"categoryId":"income"})), ["t2"]);
    assert_eq!(q(json!({"limit":"2"})), ["t2", "t3"]);
    assert_eq!(q(json!({"month":"2026-10"})), ["t4"]);
    assert_eq!(f.get("/finance/transactions", json!({"limit":2001})).0, 400);
    assert_eq!(f.get("/finance/transactions", json!({"month":"2026-13"})).0, 400);
    assert_eq!(f.get("/finance/transactions", json!({"direction":"sideways"})).0, 400);
}

#[test]
fn duplicates_group_by_account_day_amount_and_name() {
    let f = Fake::new();
    put(&f, row("d1", "2026-11-04", "Corner  Cafe", 450), json!({}));
    put(&f, row("d2", "2026-11-04", "corner cafe ", 450), json!({}));
    put(&f, row("d3", "2026-11-04", "Corner Cafe", 451), json!({}));
    let (_, out) = f.get("/finance/transactions", json!({"duplicatesOnly":true}));
    let ids: Vec<&str> = out["transactions"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["d1", "d2"]);
    assert_eq!(out["transactions"][0]["possibleDuplicate"], true);
}

#[test]
fn a_person_categorizes_one_row_and_activity_keeps_ids_only() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Corner Cafe", 450), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    let (s, out) = f.route("POST", "/finance/transactions/category", month_body("t1", "dining"));
    assert_eq!((s, out), (200, json!({"status":"ok","unchanged":false})));
    let r = stored(&f, "t1");
    assert_eq!((r["category_id"].as_str(), r["review_state"].as_str(), r["categorized_by"].as_str()), (Some("dining"), Some("confirmed"), Some("user")));
    let log = f.rows("app.finance_activity");
    assert_eq!(log[0]["kind"], "transaction.categorize");
    assert_eq!(log[0]["params"], json!({"transactionId":"t1","accountId":ACCT,"month":"2026-11","categoryId":"dining","previousCategoryId":null}));
    assert_eq!(log[0]["undo"], json!({"previousCategoryId":null}));
    let (_, again) = f.route("POST", "/finance/transactions/category", month_body("t1", "dining"));
    assert_eq!(again["unchanged"], true);
    assert_eq!(kinds(&f), ["transaction.categorize", "transaction.confirm"]);
}

#[test]
fn categorizing_refuses_with_the_old_codes() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Corner Cafe", 450), json!({}));
    put(&f, row("tr", "2026-11-03", "Move", 100), json!({"transfer_id":"x1"}));
    put(&f, row("sp", "2026-11-03", "Split", 100), json!({"category_id":null,"splits":[{"categoryId":"dining","amountCents":100}]}));
    let go = |body: Value| f.route("POST", "/finance/transactions/category", body);
    assert_eq!(go(month_body("t1", "no-such")).1["code"], "invalid_category");
    assert_eq!(go(month_body("nope", "dining")).1["code"], "not_found");
    assert_eq!(go(month_body("tr", "dining")), (409, json!({"status":"error","code":"linked_transfer","message":"Linked transfers are managed from the transfer"})));
    assert_eq!(go(month_body("sp", "dining")).1["code"], "split_transaction");
    assert_eq!(go(json!({"transactionId":"t1","accountId":ACCT,"month":"2026-12","categoryId":"dining"})).0, 404);
    assert_eq!(stored(&f, "t1")["category_id"], "groceries");
    assert!(f.rows("app.finance_activity").is_empty());
}

#[test]
fn the_assistants_tools_check_amount_and_merchant_history_and_act_as_moss() {
    let f = Fake::new();
    put(&f, row("old", "2026-10-02", "Corner Cafe 12", 300), json!({}));
    put(&f, row("a", "2026-11-03", "CORNER CAFE #44", 450), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    put(&f, row("b", "2026-11-04", "Brand New Place", 900), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    let body = |id: &str, cents: i64| json!({"transactionId":id,"accountId":ACCT,"month":"2026-11","categoryId":"dining","amountCents":cents});
    assert_eq!(f.tool("finance.transactions.categorize", body("a", 451))["code"], "amount_mismatch");
    assert_eq!(f.tool("finance.transactions.categorize", body("b", 900))["code"], "new_merchant");
    assert_eq!(f.tool("finance.transactions.categorize-new", body("a", 450))["code"], "merchant_seen");
    assert_eq!(f.tool("finance.transactions.categorize", body("a", 450))["status"], "ok");
    let mut with_note = body("b", 900);
    with_note["notes"] = json!("first visit");
    assert_eq!(f.tool("finance.transactions.categorize-new", with_note)["status"], "ok");
    assert_eq!(stored(&f, "b")["notes"], "first visit");
    assert_eq!(stored(&f, "a")["categorized_by"], "moss");
    assert!(f.rows("app.finance_activity").iter().all(|r| r["actor"] == "moss" && r["kind"] == "transaction.categorize"));
}

#[test]
fn bulk_changes_check_every_row_first_and_refuse_stale_rows() {
    let f = Fake::new();
    put(&f, row("a", "2026-11-03", "One", 100), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    put(&f, row("b", "2026-11-03", "Two", 200), json!({"category_id":null,"review_state":"needs_look","categorized_by":null}));
    let (ra, rb) = (revision(&f, "a"), revision(&f, "b"));
    let stale = json!({"categoryId":"dining","transactions":[{"id":"a","writeRevision":ra},{"id":"b","writeRevision":"0".repeat(32)}]});
    let (s, out) = f.route("POST", "/finance/transactions/bulk-categorize", stale);
    assert_eq!((s, out["code"].clone()), (409, json!("stale_transactions")));
    assert!(stored(&f, "a")["category_id"].is_null(), "nothing was written");
    let ok = json!({"categoryId":"dining","transactions":[{"id":"a","writeRevision":ra},{"id":"b","writeRevision":rb}]});
    assert_eq!(f.route("POST", "/finance/transactions/bulk-categorize", ok).1, json!({"status":"ok","updated":2}));
    let (ra2, rb2) = (revision(&f, "a"), revision(&f, "b"));
    let confirm = json!({"transactions":[{"id":"a","writeRevision":ra2},{"id":"b","writeRevision":rb2}]});
    assert_eq!(f.route("POST", "/finance/transactions/bulk-confirm", confirm).0, 409, "already confirmed rows are not needs_look");
    put(&f, row("c", "2026-11-03", "Three", 5), json!({"review_state":"needs_look"}));
    let rc = revision(&f, "c");
    let (s, out) = f.route("POST", "/finance/transactions/bulk-confirm", json!({"transactions":[{"id":"c","writeRevision":rc}]}));
    assert_eq!((s, out), (200, json!({"confirmed":1})));
    assert_eq!(f.route("POST", "/finance/transactions/bulk-categorize", json!({"categoryId":"dining","transactions":[]})).0, 400);
}

#[test]
fn review_apply_validates_all_before_any_write() {
    let f = Fake::new();
    put(&f, row("a", "2026-11-03", "One", 100), json!({}));
    put(&f, row("b", "2026-11-03", "Two", 200), json!({}));
    let bad = json!({"transactionIds":["a","b"],"accountIds":[ACCT,ACCT],"months":["2026-11","2026-11"],"categoryIds":["dining","no-such"]});
    assert_eq!(f.route("POST", "/finance/transactions/review", bad).1["code"], "invalid_category");
    assert_eq!(stored(&f, "a")["category_id"], "groceries");
    let uneven = json!({"transactionIds":["a","b"],"accountIds":[ACCT],"months":["2026-11","2026-11"],"categoryIds":["dining","dining"]});
    assert_eq!(f.route("POST", "/finance/transactions/review", uneven).0, 400);
    let ok = json!({"transactionIds":["a","b"],"accountIds":[ACCT,ACCT],"months":["2026-11","2026-11"],"categoryIds":["dining","groceries"]});
    let (s, out) = f.route("POST", "/finance/transactions/review", ok);
    assert_eq!((s, out["applied"].clone()), (200, json!(2)));
    assert_eq!(kinds(&f), ["transaction.categorize", "transaction.confirm"]);
    let two_with_rule = json!({"transactionIds":["a","b"],"accountIds":[ACCT,ACCT],"months":["2026-11","2026-11"],"categoryIds":["dining","dining"],"createRule":{"merchant":"One"}});
    assert_eq!(f.route("POST", "/finance/transactions/review", two_with_rule).0, 400);
}

#[test]
fn notes_are_saved_by_compare_and_set_and_never_trimmed() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Corner Cafe", 450), json!({}));
    let read = |f: &Fake| f.get("/finance/transactions/notes", json!({"transactionId":"t1","accountId":ACCT,"month":"2026-11"})).1;
    let first = read(&f);
    assert_eq!((first["available"].clone(), first["notes"].clone()), (json!(true), Value::Null));
    let save = |f: &Fake, note: &str, rev: &str| {
        f.route("POST", "/finance/transactions/notes", json!({"transactionId":"t1","accountId":ACCT,"month":"2026-11","notes":note,"writeRevision":rev}))
    };
    let rev = first["writeRevision"].as_str().unwrap().to_owned();
    let (s, out) = save(&f, "  keep spaces  ", &rev);
    assert_eq!((s, out["unchanged"].clone()), (200, json!(false)));
    assert_eq!(stored(&f, "t1")["notes"], "  keep spaces  ");
    let (s, out) = save(&f, "other", &rev);
    assert_eq!((s, out["code"].clone()), (409, json!("stale_transaction")));
    let now = read(&f);
    let (_, same) = save(&f, "  keep spaces  ", now["writeRevision"].as_str().unwrap());
    assert_eq!(same["unchanged"], true);
    let rev = now["writeRevision"].as_str().unwrap();
    assert_eq!(save(&f, &"x".repeat(4001), rev).1["code"], "invalid_note");
    assert_eq!(save(&f, "a\0b", rev).1["code"], "invalid_note");
    assert_eq!(save(&f, &"x".repeat(4000), rev).0, 200);
    assert_eq!(kinds(&f), ["transaction.note", "transaction.note"]);
    assert_eq!(f.rows("app.finance_activity")[0]["params"], json!({"transactionId":"t1","accountId":ACCT,"month":"2026-11","notesChanged":true}));
    assert_eq!(f.get("/finance/transactions/notes", json!({"transactionId":"zz","accountId":ACCT,"month":"2026-11"})).1, json!({"available":false}));
}

#[test]
fn splits_must_add_up_and_a_repeat_changes_nothing() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Big Shop", 1000), json!({}));
    let body = |cats: Value, amounts: Value, rev: i64| {
        json!({"transactionId":"t1","accountId":ACCT,"month":"2026-11","expectedAmountCents":1000,"expectedCurrency":"USD",
            "expectedRevision":rev,"categoryIds":cats,"amountsCents":amounts})
    };
    let go = |b: Value| f.route("POST", "/finance/transactions/splits", b);
    assert_eq!(go(body(json!(["dining","groceries"]), json!([600, 300]), 0)).1["code"], "split_total_mismatch");
    assert_eq!(go(body(json!(["dining","no-such"]), json!([600, 400]), 0)).1["code"], "invalid_category");
    assert_eq!(go(body(json!(["dining"]), json!([600, 400]), 0)).0, 400);
    assert_eq!(go(body(json!(["dining","groceries"]), json!([600, 400]), 3)).1["code"], "stale_transaction");
    assert_eq!(go(body(json!(["dining","groceries"]), json!([600, 400]), 0)).1, json!({"status":"ok","parts":2}));
    let r = stored(&f, "t1");
    assert_eq!((r["split_revision"].clone(), r["category_id"].clone()), (json!(1), Value::Null));
    assert_eq!(go(body(json!(["dining","groceries"]), json!([600, 400]), 1)).1, json!({"status":"ok","unchanged":true}));
    assert_eq!(stored(&f, "t1")["split_revision"], 1);
    assert_eq!(go(body(json!(["dining","groceries"]), json!([500, 500]), 1)).1, json!({"status":"ok","parts":2}));
    assert_eq!(stored(&f, "t1")["split_revision"], 2);
    put(&f, row("p", "2026-11-03", "Pending", 10), json!({"pending":true}));
    let mut pending = body(json!(["dining"]), json!([10]), 0);
    pending["transactionId"] = json!("p");
    pending["expectedAmountCents"] = json!(10);
    assert_eq!(go(pending).1["code"], "pending_transaction");
}

#[test]
fn a_rule_sets_the_plain_message_and_never_touches_old_rows() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Trader Joe's #12", 450), json!({"category_id":"shopping"}));
    let set = |f: &Fake, merchant: &str, category: &str| f.tool("finance.rule.set", json!({"merchant":merchant,"categoryId":category}));
    let a = set(&f, "  Trader Joe's  ", "groceries");
    assert_eq!(a["status"], "ok");
    assert_eq!(a["message"], "I made a rule: Trader Joe's always goes to Groceries. Future transactions from Trader Joe's will be sorted into Groceries automatically. No existing transactions were changed. You can see or undo it in Finance settings: the Merchant rules list, or Activity.");
    assert_eq!(a["before"], json!({"categoryId":null}));
    assert_eq!(stored(&f, "t1")["category_id"], "shopping");
    let b = set(&f, "trader joes", "dining");
    assert_eq!(b["before"], json!({"categoryId":"groceries"}));
    assert_eq!(b["ruleId"], a["ruleId"], "the same payee keeps one rule");
    assert!(b["message"].as_str().unwrap().contains("It replaces the earlier rule that sent trader joes to Groceries."));
    let c = set(&f, "Trader Joes", "dining");
    assert_eq!(c["message"], "Nothing changed. A rule already sends Trader Joes to Dining & coffee. No existing transactions were changed. You can see or undo it in Finance settings: the Merchant rules list, or Activity.");
    assert_eq!(f.rows("app.finance_merchant_rules").len(), 1);
    assert_eq!(set(&f, "1234 #", "dining")["code"], "invalid_merchant");
    assert_eq!(set(&f, &"a".repeat(201), "dining")["code"], "invalid_input");
    assert_eq!(set(&f, "Shop", "no-such")["code"], "invalid_category");
    let rule = &f.rows("app.finance_activity")[0];
    assert_eq!(rule["kind"], "merchant-rule.set");
    assert_eq!(rule["params"]["enabled"], 1);
    assert_eq!(rule["actor"], "moss");
}

#[test]
fn rules_list_preview_and_update_work_on_the_screen() {
    let f = Fake::new();
    put(&f, row("t1", "2026-11-03", "Trader Joe's #12", 450), json!({}));
    put(&f, row("t2", "2026-11-05", "Trader Joes 99", 650), json!({}));
    put(&f, row("t3", "2026-10-05", "Trader Joes", 650), json!({}));
    let (s, p) = f.get("/finance/rules/preview", json!({"merchant":"Trader Joe's","month":"2026-11"}));
    assert_eq!((s, p["total"].clone(), p["limit"].clone(), p["existing"].clone()), (200, json!(2), json!(20), Value::Null));
    assert_eq!(p["payeeKey"], "trader joes");
    let (s, out) = f.route("POST", "/finance/rules", json!({"merchant":"Trader Joe's","categoryId":"groceries","enabled":true}));
    assert_eq!(s, 200);
    let rule = out["rule"].clone();
    let list = f.get("/finance/rules", json!({"search":"JOE"})).1;
    assert_eq!(list["rules"].as_array().unwrap().len(), 1);
    assert_eq!(f.get("/finance/rules", json!({"limit":0})).0, 400);
    let stale = json!({"merchant":"Trader Joe's","categoryId":"dining","enabled":false,"expectedRevision":"0".repeat(32)});
    assert_eq!(f.route("POST", "/finance/rules", stale).1["code"], "stale_rules");
    let fresh = json!({"merchant":"Trader Joe's","categoryId":"dining","enabled":false,"expectedRevision":rule["writeRevision"]});
    let (s, out) = f.route("POST", "/finance/rules", fresh);
    assert_eq!((s, out["rule"]["enabled"].clone()), (200, json!(false)));
    let bad = json!({"merchant":"x","categoryId":"dining","enabled":true,"expectedRevision":"nope"});
    assert_eq!(f.route("POST", "/finance/rules", bad).1["code"], "invalid_revision");
}

#[test]
fn category_upsert_needs_a_saved_list_and_rejects_duplicate_names() {
    let f = Fake::new();
    let body = json!({"name":"Pets","group":"Everyday"});
    assert_eq!(f.route("POST", "/finance/categories", body.clone()).1["code"], "taxonomy_not_ready");
    f.seed("app.finance_budget_policy", A, json!({"taxonomy_ready":true,"iso_currency":"USD","revision":1}));
    f.seed("app.finance_categories", A, json!({"id":"dining","group_name":"Everyday","name":"Dining","sort_order":1}));
    let (s, out) = f.route("POST", "/finance/categories", body.clone());
    assert_eq!((s, out["after"]["id"].clone()), (200, json!("pets")));
    assert_eq!(f.route("POST", "/finance/categories", json!({"name":"PETS","group":"Fun"})).1["code"], "duplicate_name");
    let (_, renamed) = f.route("POST", "/finance/categories", json!({"id":"pets","name":"Pets & vets","group":"Bills"}));
    assert_eq!(renamed["after"]["name"], "Pets & vets");
    assert_eq!(f.route("POST", "/finance/categories", json!({"name":"x".repeat(61),"group":"Fun"})).0, 400);
    assert_eq!(f.route("POST", "/finance/categories", json!({"id":"zzz","name":"Q","group":"Fun"})).1["code"], "not_found");
}

#[test]
fn the_sorting_run_keeps_the_tiers_exactly_and_a_second_run_changes_nothing() {
    let f = Fake::new();
    f.tiers.borrow_mut().insert("sorting".into(), "trusted_auto".into());
    f.tiers.borrow_mut().insert("sorting_new".into(), "ask_each_time".into());
    put(&f, row("seen", "2026-10-02", "Known Grocer 1", 100), json!({}));
    let open = json!({"category_id":null,"review_state":"confirmed","categorized_by":null,"plaid_category":"FOOD_AND_DRINK"});
    put(&f, row("a", "2026-11-03", "Known Grocer 7", 100), open.clone());
    let mut fresh = open.clone();
    fresh["plaid_category"] = json!("FOOD_AND_DRINK");
    put(&f, row("b", "2026-11-04", "Unknown Grocer", 100), fresh);
    put(&f, row("c", "2026-11-05", "Mystery", 100), json!({"category_id":null,"review_state":"confirmed","categorized_by":null}));
    f.tool("finance.rule.set", json!({"merchant":"Mystery","categoryId":"shopping"}));
    assert_eq!(f.route("POST", "/finance/sorting/run", json!({})).1, json!({"status":"ok","sorted":3}));
    let state = |id: &str| {
        let r = stored(&f, id);
        (r["category_id"].as_str().map(str::to_owned), r["review_state"].as_str().unwrap().to_owned(), r["categorized_by"].as_str().map(str::to_owned))
    };
    assert_eq!(state("a").1, "confirmed", "trusted tier applies a known merchant without asking");
    assert_eq!(state("b").1, "needs_look", "a new merchant waits for the person");
    assert_eq!(state("c"), (Some("shopping".into()), "confirmed".into(), Some("rule".into())), "a rule is always confirmed");
    assert_eq!(f.route("POST", "/finance/sorting/run", json!({})).1, json!({"status":"ok","sorted":0}));
    f.tiers.borrow_mut().insert("sorting".into(), "ask_each_time".into());
    put(&f, row("d", "2026-11-06", "Known Grocer 8", 100), open);
    f.route("POST", "/finance/sorting/run", json!({}));
    assert_eq!(state("d").1, "needs_look", "the known-merchant tier is read live");
}
