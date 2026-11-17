//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use safety_core::{
    db::DataContext,
    secret::{Secret, SecretCipher},
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const NAME: &str = "PLANTED-NAME-MARKER-5b81c2";
const NOTE: &str = "PLANTED-NOTE-MARKER-9d03e7";
const AMOUNT: i64 = 7_314_159_265;
const TABLES: [&str; 3] = [
    "app.finance_accounts",
    "app.finance_transactions",
    "app.finance_activity",
];

struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Finance does not call a model")
    }
    fn embed(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Finance does not embed")
    }
}

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

struct World {
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            let ready = f.root.query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0);
            if !ready {
                f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
                f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
            }
        });
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[])).unwrap();
        // Rows left by an earlier run in this throwaway database must not reach the marker scan.
        f.rt.block_on(f.root.batch_execute(
            "DO $$ BEGIN IF to_regclass('app.finance_activity') IS NOT NULL THEN \
             TRUNCATE app.finance_activity, app.finance_transactions, app.finance_accounts CASCADE; END IF; END $$",
        ))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let wasm = std::fs::read(std::env::var("FINANCE_COMPONENT_WASM").expect("Run modules/finance/tools/check.sh")).unwrap();
        let bytes = moss_finance_host::package::pack(&root(), &wasm).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(NoModel),
                version: "0.1.0".parse().unwrap(),
                browser_dir: None,
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
            Ok,
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "finance-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        let text = self
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/finance{path}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {path}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// Rows `actor` can read straight from a table through their own policies.
    fn visible(&self, actor: Uuid, table: &str) -> i64 {
        self.f.rt.block_on(async {
            let cx = DataContext::open(&self.f.db, &self.f.access(actor)).await.unwrap();
            cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0)
        })
    }
    fn approve(&self, actor: Uuid, tool: &str, parameters: &Value) {
        self.app.services.approve_tool(&self.f.access(actor), "finance", tool, parameters).unwrap();
    }
    fn account(&self, actor: Uuid, op: Uuid, name: &str, cents: i64) -> Value {
        self.call(
            actor,
            "POST",
            "/finance/manual/accounts",
            json!({"operationId":op.to_string(),"name":name,"accountType":"checking","isoCurrency":"USD","cleared":true,"openingDate":"2026-01-01","openingBalanceCents":cents}),
        )
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_and_an_admin_cannot_see_or_change_another_persons_ledger() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let op = Uuid::new_v4();
    let made = w.account(a, op, NAME, AMOUNT);
    assert_eq!(made["status"], 200, "{made}");
    let account = made["body"]["id"].as_str().unwrap().to_owned();
    let entry = w.call(
        a,
        "POST",
        "/finance/manual/entries",
        json!({"operationId":Uuid::new_v4().to_string(),"accountId":account,"name":"Coffee","date":"2026-11-10","amountCents":-500,"isoCurrency":"USD","cleared":true,"notes":NOTE,"cleared":true}),
    );
    assert_eq!(entry["status"], 200, "{entry}");

    // Person A sees the account. Person B and the admin see nothing, by route or by table.
    assert_eq!(w.call(a, "GET", "/finance/accounts", Value::Null)["body"]["accounts"].as_array().unwrap().len(), 1);
    for other in [b, w.f.admin] {
        assert_eq!(w.call(other, "GET", "/finance/accounts", Value::Null)["body"]["accounts"], json!([]));
        for table in TABLES {
            assert_eq!(w.visible(other, table), 0, "{table}");
        }
    }
    let theirs = w.call(
        b,
        "POST",
        "/finance/manual/entries",
        json!({"operationId":Uuid::new_v4().to_string(),"accountId":account,"name":"Stolen","date":"2026-11-10","amountCents":-1,"isoCurrency":"USD","cleared":true}),
    );
    assert_eq!((theirs["status"].clone(), theirs["body"]["code"].clone()), (json!(404), json!("manual_unavailable")), "{theirs}");
    assert!(!theirs.to_string().contains(NAME), "a refusal must not show another person's account");
    println!("PASS rls: the second person and the admin read no ledger rows and cannot add to the account");

    // With the owner rule removed on every table, the same checks fail.
    let off: String = TABLES.iter().map(|t| format!("ALTER TABLE {t} DISABLE ROW LEVEL SECURITY;")).collect();
    let on: String = TABLES.iter().map(|t| format!("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;")).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&off)).unwrap();
    let open: Vec<i64> = TABLES.iter().map(|t| w.visible(w.f.admin, t)).collect();
    let leaked = w.call(b, "GET", "/finance/accounts", Value::Null);
    w.f.rt.block_on(w.f.root.batch_execute(&on)).unwrap();
    assert!(open.iter().all(|n| *n >= 1), "RED expected: the admin sees other people's rows without the rule, saw {open:?}");
    assert!(leaked.to_string().contains(&format!("manual:{op}")), "RED expected: the second person lists A's account without the rule");
    println!("RED: with row security removed the admin saw {open:?} rows and the second person listed A's account");
    for table in TABLES {
        assert_eq!(w.visible(w.f.admin, table), 0, "{table}");
    }
    assert_eq!(w.call(b, "GET", "/finance/accounts", Value::Null)["body"]["accounts"], json!([]));
    println!("GREEN: row security restored, both see 0 rows");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_same_operation_id_makes_one_account_per_person() {
    let w = World::new();
    let op = Uuid::new_v4();
    let first = w.account(w.f.a, op, "Mine", 100);
    let other = w.account(w.f.b, op, "Theirs", 200);
    assert_eq!((first["status"].clone(), other["status"].clone()), (json!(200), json!(200)));
    assert_eq!(first["body"]["id"], other["body"]["id"]);
    assert_eq!(w.account(w.f.a, op, "Mine", 100)["body"]["unchanged"], true);
    assert_eq!(w.account(w.f.a, op, "Mine", 101)["body"]["code"], "manual_conflict");
    let rows = |actor| w.call(actor, "GET", "/finance/accounts", Value::Null)["body"]["accounts"].clone();
    assert_eq!(rows(w.f.a)[0]["name"], "Mine");
    assert_eq!(rows(w.f.b)[0]["name"], "Theirs");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_chat_routes_need_an_approval_that_is_exact_and_used_once() {
    let w = World::new();
    let a = w.f.a;
    let op = Uuid::new_v4();
    let input = json!({"operationId":op.to_string(),"name":"Chat","accountType":"cash","isoCurrency":"USD","cleared":true,"openingDate":"2026-01-01","openingBalanceCents":5});
    let refused = w.call(a, "POST", "/finance/chat/manual/account-create", input.clone());
    assert_eq!(refused["status"], 500, "no approval means no write: {refused}");
    assert_eq!(w.visible(a, "app.finance_accounts"), 0);
    w.approve(a, "finance.manual.account-create", &input);
    let mut changed = input.clone();
    changed["openingBalanceCents"] = json!(6);
    assert_eq!(w.call(a, "POST", "/finance/chat/manual/account-create", changed)["status"], 500, "a different request is not approved");
    assert_eq!(w.call(a, "POST", "/finance/chat/manual/account-create", input.clone())["status"], 200);
    assert_eq!(w.visible(a, "app.finance_accounts"), 1);
    assert_eq!(w.call(a, "POST", "/finance/chat/manual/account-create", input.clone())["status"], 500, "an approval is used once");
    w.approve(w.f.b, "finance.manual.account-create", &input);
    assert_eq!(w.call(a, "POST", "/finance/chat/manual/account-create", input)["status"], 500, "another person's approval does not count");
    println!("PASS approval: exact, one-use and account-bound");
}

#[test]
#[ignore = "Only through verify-gate"]
fn names_notes_and_amounts_never_reach_job_payloads_activity_rows_or_logs() {
    let w = World::new();
    let account = w.account(w.f.a, Uuid::new_v4(), NAME, AMOUNT)["body"]["id"].as_str().unwrap().to_owned();
    let entry = |amount: i64| {
        w.call(
            w.f.a,
            "POST",
            "/finance/manual/entries",
            json!({"operationId":Uuid::new_v4().to_string(),"accountId":account,"name":NAME,"date":"2026-11-10","amountCents":amount,"isoCurrency":"USD","cleared":true,"notes":NOTE}),
        )
    };
    assert_eq!(entry(-AMOUNT / 2)["status"], 200);
    assert_eq!(entry(i64::MAX)["status"], 400, "an overflowing entry is refused");
    w.call(w.f.b, "POST", "/finance/manual/entries", json!({"operationId":Uuid::new_v4().to_string(),"accountId":account,"name":NAME,"date":"2026-11-10","amountCents":1,"isoCurrency":"USD","cleared":true,"notes":NOTE}));
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') OR table_name='finance_activity'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")), "{tables:?}");
    for table in &tables {
        for text in [NAME.to_owned(), NOTE.to_owned(), AMOUNT.to_string(), (AMOUNT / 2).to_string()] {
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&text])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds {text}");
        }
    }
    // The markers are in the ledger tables, so the scan can see them.
    for text in [NAME, NOTE] {
        let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT (SELECT count(*) FROM app.finance_accounts t WHERE to_jsonb(t)::text LIKE '%'||$1||'%')+(SELECT count(*) FROM app.finance_transactions t WHERE to_jsonb(t)::text LIKE '%'||$1||'%')", &[&text])).unwrap().get(0);
        assert!(stored >= 1, "{text} must be stored in the ledger");
    }
    let activity: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_activity WHERE owner_user_id=$1", &[&w.f.a])).unwrap().get(0);
    assert_eq!(activity, 2, "every change (account, one entry; the refusals write none) is logged, saw {activity}");
    for actor in [w.f.a, w.f.b, w.f.admin] {
        let seen = serde_json::to_string(&w.app.services.activity("finance", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!seen.contains(NAME) && !seen.contains(NOTE) && !seen.contains(&AMOUNT.to_string()));
    }
    println!("PASS privacy: scanned {} tables, the markers appear only in the ledger rows", tables.len());
}
