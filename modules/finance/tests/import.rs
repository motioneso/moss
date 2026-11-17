mod common;
use common::{Fake, OP1, OP2, OP3};
use serde_json::{json, Value};

const ACCT: &str = "manual:11111111-1111-4111-8111-111111111111";
const MIB: usize = 1024 * 1024;

fn mapping(csv: &str) -> Value {
    json!({"csv":csv,"isoCurrency":"USD","date":0,"name":1,"amount":2,"notes":3,"dateFormat":"iso","amountMode":"positive-out"})
}

/// A CSV of `rows` data rows, padded in an unmapped column to exactly `bytes` bytes.
fn fixture(rows: usize, bytes: usize) -> String {
    let head = "date,name,amount,notes,filler\n";
    let lines: Vec<String> = (1..=rows).map(|n| format!("2026-11-01,Shop {n},1.00,note {n},")).collect();
    let used: usize = head.len() + lines.iter().map(|l| l.len() + 1).sum::<usize>();
    let spare = bytes - used;
    let mut out = String::from(head);
    for (i, line) in lines.iter().enumerate() {
        out.push_str(line);
        out.push_str(&"x".repeat(spare / rows + usize::from(i < spare % rows)));
        out.push('\n');
    }
    assert_eq!(out.len(), bytes);
    out
}

/// Writes the fixture to a real file and reads it back, as a person's file would arrive.
fn through_a_file(name: &str, text: &str) -> String {
    let dir = std::env::temp_dir().join(format!("finance-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    let back = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&dir).unwrap();
    back
}

fn parse(f: &Fake, csv: &str) -> (u16, Value) {
    f.route("POST", "/finance/import/parse", mapping(csv))
}

#[test]
fn a_file_at_both_caps_parses_and_one_step_over_each_is_refused() {
    let f = Fake::new();
    let at_caps = through_a_file("at-caps.csv", &fixture(200, MIB));
    assert_eq!(at_caps.len(), MIB);
    let (s, out) = parse(&f, &at_caps);
    assert_eq!(s, 200, "{}", out.to_string().chars().take(300).collect::<String>());
    assert_eq!(out["rows"].as_array().unwrap().len(), 200);
    assert_eq!(out["rows"][0], json!({"sourceRow":1,"date":"2026-11-01","name":"Shop 1","amountCents":100,"notes":"note 1","allowDuplicate":false}));
    let (s, out) = parse(&f, &through_a_file("too-many.csv", &fixture(201, 100_000)));
    assert_eq!((s, out["code"].clone(), out["message"].clone()), (400, json!("invalid_csv"), json!("Import at most 200 data rows at a time.")));
    let (s, out) = parse(&f, &through_a_file("too-big.csv", &fixture(200, MIB + 1)));
    assert_eq!((s, out["message"].clone()), (400, json!("Choose a CSV file no larger than 1 MiB.")));
}

#[test]
fn parse_reports_the_row_and_reason_for_each_bad_file() {
    let f = Fake::new();
    let msg = |csv: &str| parse(&f, csv).1["message"].as_str().unwrap_or("ok").to_owned();
    assert_eq!(msg("date,name,amount,notes\n2026-13-40,Shop,1.00,\n"), "Data row 1: Use a valid calendar date on every row.");
    assert_eq!(msg("date,name,amount,notes\n2026-11-01,,1.00,\n"), "Data row 1: Payee is required (up to 640 bytes); notes allow up to 4000 bytes.");
    assert!(msg("date,name,amount,notes\n2026-11-01,Shop,0.00,\n").starts_with("Data row 1:"));
    assert!(msg("date,name,amount,notes\n2026-11-01,Shop,1,000.00,\n").len() > 3);
    assert_eq!(msg("date,name,amount,notes\n"), "Include a header and at least one data row.");
    assert_eq!(parse(&f, "date,name,amount,notes\n2026-11-01,\"Sh\"op,1.00,\n").0, 400);
    let (s, out) = f.route("POST", "/finance/import/parse", json!({"csv":"a,b\n1,2\n","isoCurrency":"USD"}));
    assert_eq!(s, 400, "{out}");
}

fn rows(n: i64) -> Value {
    Value::Array((1..=n).map(|i| json!({"sourceRow":i,"date":"2026-11-0".to_owned() + &i.to_string(),"name":format!("Shop {i}"),"amountCents":i * 100,"notes":"","allowDuplicate":false})).collect())
}
fn body(op: &str, revision: i64, rows: Value) -> Value {
    json!({"operationId":op,"accountId":ACCT,"isoCurrency":"USD","expectedRevision":revision,"rows":rows,"cleared":true})
}
fn setup() -> Fake {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 100_000);
    f
}
fn imported(f: &Fake) -> Vec<Value> {
    f.rows("app.finance_transactions")
}
fn balance(f: &Fake) -> i64 {
    f.rows("app.finance_accounts")[0]["balance_cents"].as_i64().unwrap()
}

#[test]
fn an_import_saved_twice_by_replay_stays_one_set_of_rows() {
    let f = setup();
    let (s, out) = f.route("POST", "/finance/import/apply", body(OP2, 0, rows(3)));
    assert_eq!((s, out), (200, json!({"status":"ok","id":format!("manual:{OP2}"),"entryCount":3,"unchanged":false})));
    assert_eq!(imported(&f).len(), 3);
    assert_eq!(balance(&f), 100_000 - 600);
    let (s, again) = f.route("POST", "/finance/import/apply", body(OP2, 0, rows(3)));
    assert_eq!((s, again["unchanged"].clone()), (200, json!(true)));
    assert_eq!(imported(&f).len(), 3, "a replay adds no row");
    assert_eq!(balance(&f), 100_000 - 600, "a replay moves no balance");
    assert_eq!(f.rows("app.finance_imports").len(), 1);
    assert_eq!(f.rows("app.finance_activity").iter().filter(|r| r["kind"] == "transaction.import").count(), 1);
    let ids: Vec<String> = imported(&f).iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, [1, 2, 3].map(|i| format!("manual:{OP2}:{i}")));
    let (s, other) = f.route("POST", "/finance/import/apply", body(OP2, 0, rows(2)));
    assert_eq!((s, other["code"].clone()), (409, json!("stale_import")), "the same id with other rows is refused");
}

#[test]
fn a_stored_duplicate_needs_a_choice_and_the_preview_names_it() {
    let f = setup();
    f.route("POST", "/finance/manual/entries", json!({"operationId":OP3,"accountId":ACCT,"name":"shop  1","date":"2026-11-01","amountCents":100,"isoCurrency":"USD","cleared":true}));
    let revision = f.rows("app.finance_accounts")[0]["ledger_revision"].as_i64().unwrap();
    let (s, p) = f.route("POST", "/finance/import/preview", body(OP2, revision, rows(2)));
    assert_eq!(s, 200, "{p}");
    assert_eq!(p["view"]["duplicateRows"], json!([1]));
    let (s, out) = f.route("POST", "/finance/import/apply", body(OP2, revision, rows(2)));
    assert_eq!((s, out["code"].clone()), (409, json!("stale_import")));
    assert_eq!(imported(&f).len(), 1, "a refused import writes nothing");
    let mut keep = rows(2);
    keep[0]["allowDuplicate"] = json!(true);
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, revision, keep)).0, 200);
    assert_eq!(imported(&f).len(), 3);
}

#[test]
fn an_old_revision_a_bad_date_and_a_wrong_account_are_refused_without_writes() {
    let f = setup();
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, 5, rows(1))).0, 409);
    let mut early = rows(1);
    early[0]["date"] = json!("2025-12-31");
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, 0, early)).0, 409);
    let mut wrong = body(OP2, 0, rows(1));
    wrong["accountId"] = json!("manual:nope");
    assert_eq!(f.route("POST", "/finance/import/apply", wrong).0, 409);
    let (s, out) = f.route("POST", "/finance/import/preview", json!({"accountId":"manual:nope","isoCurrency":"USD","rows":rows(1)}));
    assert_eq!((s, out["code"].clone()), (404, json!("manual_unavailable")));
    assert!(imported(&f).is_empty());
    assert_eq!(balance(&f), 100_000);
    let mut zero = rows(1);
    zero[0]["amountCents"] = json!(0);
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, 0, zero)).0, 400);
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, 0, json!([]))).0, 400);
    assert_eq!(f.route("POST", "/finance/import/apply", body(OP2, 0, rows(201))).0, 400);
}
