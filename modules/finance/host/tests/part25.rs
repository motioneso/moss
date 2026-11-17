//! Part 25 real installed-package proofs. Run only through scripts/run-gate.sh.
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
const MERCHANT: &str = "PLANTED-MERCHANT-MARKER-62d9b0";
const OFFICIAL: &str = "PLANTED-OFFICIAL-MARKER-b7712c";
const OTHER: &str = "PLANTED-OTHERROW-MARKER-77aa01";
const MIRRORS: [&str; 2] = ["app.finance_shared_accounts", "app.finance_shared_transactions"];

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
             TRUNCATE app.finance_activity, app.finance_transactions, app.finance_accounts, app.finance_budget_policy, app.finance_budget_assignments, app.finance_budget_drafts, app.finance_budget_draft_lines CASCADE; END IF; END $$",
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
            if table.ends_with("finance_bank_links") || table.ends_with("finance_link_sessions") {
                cx.db().batch_execute(&format!("SET LOCAL ROLE {}", moss_module_host::database::runtime_role("finance"))).await.unwrap();
            }
            cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0)
        })
    }
}


impl World {
    /// A bank-style account with one transaction, written straight to the tables as a sync would.
    fn seed_bank(&self, owner: Uuid, account: &str, name: &str, note: &str, cents: i64) {
        self.f.rt.block_on(async {
            self.f.root.execute(
                "INSERT INTO app.finance_accounts (owner_user_id, account_id, item_id, name, official_name, type, subtype, mask, balance_cents, iso_currency, updated_at) \
                 VALUES ($1,$2,'item-x',$3,$4,'depository','checking','1234',$5,'USD','2026-11-10T08:00:00Z')",
                &[&owner, &account, &name, &OFFICIAL, &cents],
            ).await.unwrap();
            self.f.root.execute(
                "INSERT INTO app.finance_transactions (owner_user_id, id, account_id, date, amount_cents, iso_currency, name, merchant, pending, notes) \
                 VALUES ($1,$2,$3,'2026-11-05',2500,'USD','Card purchase',$4,false,$5)",
                &[&owner, &format!("tx-{account}"), &account, &MERCHANT, &note],
            ).await.unwrap();
        });
    }
    fn share(&self, actor: Uuid, account: &str, on: bool) -> Value {
        self.call(actor, "POST", "/finance/accounts/shared", json!({"accountId":account,"shared":on}))
    }
    fn forged_mirror_write(&self, actor: Uuid, owner: Uuid) -> bool {
        self.f.rt.block_on(async {
            let cx = DataContext::open(&self.f.db, &self.f.access(actor)).await.unwrap();
            cx.db().execute(
                "INSERT INTO app.finance_shared_accounts (owner_user_id, account_id, name, type, balance_cents, iso_currency, updated_at) VALUES ($1,'forged','x','depository',1,'USD','x')",
                &[&owner],
            ).await.is_ok()
        })
    }
    fn mirror_rows_changed_by(&self, actor: Uuid) -> u64 {
        self.f.rt.block_on(async {
            let cx = DataContext::open(&self.f.db, &self.f.access(actor)).await.unwrap();
            let updated = cx.db().execute("UPDATE app.finance_shared_accounts SET name='hijacked'", &[]).await.unwrap();
            let deleted = cx.db().execute("DELETE FROM app.finance_shared_transactions", &[]).await.unwrap();
            updated + deleted
        })
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_shared_account_shows_the_other_person_only_what_sharing_allows() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    w.seed_bank(a, "acct-a", NAME, NOTE, AMOUNT);
    assert_eq!(w.share(a, "acct-a", true)["status"], 200);

    // The other person sees the shared account by route and the copy by table, never the ledger.
    let seen = w.call(b, "GET", "/finance/accounts", Value::Null);
    let list = seen["body"]["accounts"].as_array().unwrap();
    assert_eq!((list.len(), list[0]["ownerUserId"].clone()), (1, json!(a.to_string())), "{seen}");
    let month = w.call(b, "GET", "/finance/transactions?month=2026-11", Value::Null);
    assert_eq!(month["body"]["transactions"].as_array().unwrap().len(), 1, "{month}");
    for text in [NOTE, OFFICIAL] {
        assert!(!format!("{seen}{month}").contains(text), "{text} reached the other person");
    }
    for table in ["app.finance_accounts", "app.finance_transactions"] {
        assert_eq!(w.visible(b, table), 0, "{table} must stay private");
    }
    assert_eq!(w.visible(b, MIRRORS[0]), 1);
    assert_eq!(w.visible(b, MIRRORS[1]), 1);
    for table in MIRRORS {
        let held: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%' OR to_jsonb(t)::text LIKE '%'||$2||'%'"), &[&NOTE, &OFFICIAL])).unwrap().get(0);
        assert_eq!(held, 0, "{table} holds a private field");
    }

    // The other person cannot forge, change or delete the owner's shared copy.
    assert!(!w.forged_mirror_write(b, a), "a forged owner must be refused");
    assert_eq!(w.mirror_rows_changed_by(b), 0, "another person's copy must not change");
    println!("PASS sharing: the other person reads only the shared copy and cannot write it");

    // RED: with row-level security off on the ledger and the copy, the same checks fail.
    let off = |on: bool| {
        let verb = if on { "ENABLE" } else { "DISABLE" };
        for t in ["app.finance_accounts", "app.finance_transactions", MIRRORS[0], MIRRORS[1]] {
            w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {t} NO FORCE ROW LEVEL SECURITY; ALTER TABLE {t} {verb} ROW LEVEL SECURITY"))).unwrap();
        }
    };
    off(false);
    let leaked = w.visible(b, "app.finance_accounts");
    let forged = w.forged_mirror_write(b, a);
    let hijack = w.mirror_rows_changed_by(b);
    off(true);
    for t in ["app.finance_accounts", "app.finance_transactions", MIRRORS[0], MIRRORS[1]] {
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {t} FORCE ROW LEVEL SECURITY"))).unwrap();
    }
    assert!(leaked >= 1 && forged && hijack >= 1, "the checks cannot fail: leaked={leaked} forged={forged} hijack={hijack}");
    // GREEN: protection restored.
    assert_eq!(w.visible(b, "app.finance_accounts"), 0);
    assert!(!w.forged_mirror_write(b, a));
    println!("PASS sharing: seen failing with protection removed (leak {leaked}, forged write {forged}, changed {hijack}), passing once restored");

    // Stopping removes the copy.
    assert_eq!(w.share(a, "acct-a", false)["status"], 200);
    assert_eq!((w.visible(b, MIRRORS[0]), w.visible(b, MIRRORS[1])), (0, 0));
    assert_eq!(w.call(b, "GET", "/finance/accounts", Value::Null)["body"]["accounts"], json!([]));
}

#[test]
#[ignore = "Only through verify-gate"]
fn export_holds_only_the_callers_rows_and_sharing_leaves_no_private_text_in_logs_jobs_or_activity() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    w.seed_bank(a, "acct-a", NAME, NOTE, AMOUNT);
    w.seed_bank(b, "acct-b", OTHER, OTHER, 777);
    w.f.rt.block_on(w.f.root.execute("UPDATE app.finance_transactions SET name=$1 WHERE owner_user_id=$2", &[&OTHER, &b])).unwrap();
    w.share(a, "acct-a", true);
    w.share(b, "acct-b", true);

    let out = w.call(a, "GET", "/finance/transactions/export", Value::Null);
    assert_eq!(out["status"], 200, "{out}");
    let csv = out["body"]["csv"].as_str().unwrap();
    assert_eq!(out["body"]["totalCount"], 1);
    assert!(csv.contains("tx-acct-a") && !csv.contains(OTHER) && !csv.contains("tx-acct-b"), "the export holds another person's row");
    assert!(!csv.contains(NOTE), "notes are not exported");
    println!("PASS export: holds only the caller's own rows even when the other person shares theirs");

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
        for text in [NAME, NOTE, MERCHANT, OFFICIAL, OTHER, &AMOUNT.to_string()] {
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&text])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds {text}");
        }
    }
    for actor in [a, b, w.f.admin] {
        let seen = serde_json::to_string(&w.app.services.activity("finance", &w.f.access(actor)).unwrap()).unwrap();
        for text in [NAME, NOTE, MERCHANT, OFFICIAL, &AMOUNT.to_string()] {
            assert!(!seen.contains(text), "the activity feed shows {text}");
        }
    }
    // The markers are stored, so the scan can see them.
    let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_transactions t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&NOTE])).unwrap().get(0);
    assert!(stored >= 1);
    let shared_rows: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_activity WHERE kind='account.share'", &[])).unwrap().get(0);
    assert_eq!(shared_rows, 2, "each sharing change is logged once");
    println!("PASS privacy: scanned {} tables, sharing leaves no private text outside the ledger and its allowed copy", tables.len());
}
