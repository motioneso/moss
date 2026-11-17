//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use moss_module_host::network::{Outbound, Response, Transport};
use moss_standins::plaid::{PlaidConfig, PlaidStandIn};
use safety_core::{
    db::DataContext,
    secret::{Secret, SecretCipher, SecretFields},
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

const CLIENT: &str = "client-invented";
const SECRET: &str = "secret-invented-8a41";
const TOKEN_MARK: &str = "BANKTOKEN-7c2e";
const PRIVATE_MARK: &str = "BANKTEXT-31fa";
const BANK_TABLES: [&str; 4] = [
    "app.finance_items",
    "app.finance_bank_links",
    "app.finance_link_sessions",
    "app.finance_balance_snapshots",
];

/// Answers every bank call from the stand-in, as the real network would from Plaid.
struct PlaidTransport(Arc<PlaidStandIn>);
impl Transport for PlaidTransport {
    fn send(&self, r: Outbound<'_>) -> anyhow::Result<Response> {
        let (status, body) = self.0.handle(r.url.host_str().unwrap(), r.url.path(), &r.body.clone().unwrap_or(json!({})));
        Ok(Response { status, body: serde_json::to_vec(&body)? })
    }
}

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
    plaid: Arc<PlaidStandIn>,
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
             TRUNCATE app.finance_activity, app.finance_transactions, app.finance_accounts, app.finance_budget_policy, app.finance_budget_assignments, app.finance_budget_drafts, app.finance_budget_draft_lines, app.finance_targets, app.finance_bill_plans, app.finance_bill_occurrences, app.finance_bill_adjustments, app.finance_bill_suggestion_dismissals, app.finance_flex_policies, app.finance_card_policies, app.finance_card_assignments CASCADE; END IF; END $$",
        ))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let wasm = std::fs::read(std::env::var("FINANCE_COMPONENT_WASM").expect("Run modules/finance/tools/check.sh")).unwrap();
        let bytes = moss_finance_host::package::pack(&root(), &wasm).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let plaid = Arc::new(PlaidStandIn::new(PlaidConfig {
            client_id: CLIENT.into(),
            secret: SECRET.into(),
            marker: TOKEN_MARK.into(),
            private_marker: PRIVATE_MARK.into(),
        }));
        moss_module_host::network::set_test_transport(Some(Arc::new(PlaidTransport(plaid.clone()))));
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
        Self { f, app, plaid, _dirs: (dir, reg) }
    }
    fn call(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        let text = self
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/finance{path}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {path}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// Like `call`, but a host failure comes back as an error value.
    fn call_raw(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Result<Value, String> {
        self.app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/finance{path}"), &body.to_string())
            .map(|t| serde_json::from_str(&t).unwrap())
            .map_err(|e| format!("{e:?}"))
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
    // Every legacy ledger table carries the owner-only rules, and a write for someone else is refused.
    let (total, covered): (i64, i64) = {
        let row = w.f.rt.block_on(w.f.root.query_one(
            "SELECT count(*), count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity AND \
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname='app' AND p.tablename=t.tablename AND p.policyname LIKE 'moss_legacy_%')=4) \
             FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename AND c.relnamespace='app'::regnamespace \
             WHERE t.schemaname='app' AND t.tablename LIKE 'finance\\_%' AND t.tablename NOT IN ('finance_bank_links','finance_link_sessions') \
             AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema='app' AND k.table_name=t.tablename AND k.column_name='owner_user_id')",
            &[],
        )).unwrap();
        (row.get(0), row.get(1))
    };
    assert!(total >= 20 && total == covered, "{covered} of {total} ledger tables carry owner-only rules");
    let forged = w.f.rt.block_on(async {
        let cx = DataContext::open(&w.f.db, &w.f.access(b)).await.unwrap();
        cx.db()
            .execute(
                "INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params) VALUES ($1, gen_random_uuid(), now(), 'user', 'x', '{}')",
                &[&w.f.a],
            )
            .await
    });
    assert!(forged.is_err(), "a write carrying another person's owner id must be refused");
    println!("PASS rls: {total} ledger tables carry owner-only rules, a forged owner is refused");
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

impl World {
    /// The administrator saves the Plaid keys, through the host's own configuration door.
    fn keys(&self) {
        self.app
            .services
            .set_credential(
                &access_context::AccessContext::new(Uuid::nil(), "configure"),
                "finance",
                "plaid-keys",
                &SecretFields::new().with("clientId", Secret::new(CLIENT)).with("clientSecret", Secret::new(SECRET)),
            )
            .unwrap();
    }
    fn post(&self, actor: Uuid, path: &str) -> Value {
        self.call(actor, "POST", path, json!({}))
    }
    /// The person finishes the bank's own page. Moss then polls and picks the result up.
    fn connect(&self, actor: Uuid) -> Value {
        let started = self.post(actor, "/finance/connect/start");
        assert_eq!(started["status"], 200, "{started}");
        for link in self.plaid.open_links() {
            self.plaid.complete_link(&link);
        }
        let polled = self.post(actor, "/finance/connect/poll");
        assert_eq!(polled["body"]["completed"], 1, "{polled}");
        polled
    }
    fn items(&self, actor: Uuid) -> Vec<String> {
        self.f
            .rt
            .block_on(self.f.root.query(
                "SELECT item_id||':'||status||':'||coalesce(last_error,'') FROM app.finance_items WHERE owner_user_id=$1 ORDER BY item_id",
                &[&actor],
            ))
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }
    fn count(&self, sql: &str, actor: Uuid) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[&actor])).unwrap().get(0)
    }
    fn run_jobs(&self) {
        let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
        for _ in 0..5 {
            self.app.installer.run_job(&worker).unwrap();
        }
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_bank_connects_syncs_fails_and_reconnects() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    // Without saved keys the start is refused cleanly.
    let none = w.post(a, "/finance/connect/start");
    assert_eq!((none["status"].clone(), none["body"]["code"].clone()), (json!(502), json!("bank_unavailable")), "{none}");
    w.keys();

    // A connects. The poll before the bank page is finished sees nothing to do.
    w.plaid.paginate();
    let started = w.post(a, "/finance/connect/start");
    assert!(started["body"]["hostedLinkUrl"].as_str().unwrap().starts_with("https://secure.sandbox.plaid.com/hl/"), "{started}");
    let early = w.post(a, "/finance/connect/poll");
    assert_eq!((early["body"]["pending"].clone(), early["body"]["completed"].clone()), (json!(1), json!(0)), "{early}");
    for link in w.plaid.open_links() {
        w.plaid.complete_link(&link);
    }
    let done = w.post(a, "/finance/connect/poll");
    assert_eq!(done["body"]["completed"], 1, "{done}");
    assert_eq!(w.items(a), ["item-0:connected:"]);
    assert_eq!(w.count("SELECT count(*) FROM app.finance_accounts WHERE owner_user_id=$1 AND item_id='item-0'", a), 2);
    assert_eq!(w.count("SELECT count(*) FROM app.finance_transactions WHERE owner_user_id=$1", a), 2, "two pages of transactions");
    assert_eq!(w.count("SELECT count(*) FROM app.finance_balance_snapshots WHERE owner_user_id=$1", a), 2);
    assert_eq!(w.count("SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%finance.sync-run'", a), 1, "the six-hour sweep is scheduled");
    println!("PASS connect: A's bank connected, 2 accounts, 2 transactions over 2 pages, sweep scheduled");

    // B connects while the bank changes a page mid-read. The sync restarts and still finishes.
    w.plaid.mutate_once();
    w.connect(b);
    assert_eq!(w.items(b), ["item-1:connected:"]);
    assert_eq!(w.count("SELECT count(*) FROM app.finance_transactions WHERE owner_user_id=$1", b), 2);
    // Later changes arrive as a modified and a removed transaction.
    w.plaid.queue_changes(vec![json!({"transaction_id":"tx-item-1-2","account_id":"acc-1-1","date":"2026-11-01","amount":9.5,"iso_currency_code":"USD","name":"Changed","merchant_name":null,"personal_finance_category":{"primary":"FOOD_AND_DRINK"},"pending":false,"pending_transaction_id":null})], vec!["tx-item-1-1".into()]);
    let again = w.post(b, "/finance/sync/run-now");
    assert_eq!((again["body"]["items"][0]["modified"].clone(), again["body"]["items"][0]["removed"].clone()), (json!(1), json!(1)), "{again}");
    assert_eq!(w.count("SELECT count(*) FROM app.finance_transactions WHERE owner_user_id=$1", b), 1);
    println!("PASS sync: a mid-read change restarted the read, then a modified and a removed transaction applied");

    // A's bank asks for a new sign-in. The scheduled sweep stores that and B's bank is untouched.
    w.plaid.fail_item(0, "ITEM_LOGIN_REQUIRED");
    w.f.rt.block_on(w.f.root.execute("UPDATE moss_queue.schedules SET next_at=now()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%finance.sync-run'", &[&a])).unwrap();
    w.run_jobs();
    assert_eq!(w.items(a), ["item-0:reauth-required:ITEM_LOGIN_REQUIRED"]);
    assert_eq!(w.items(b), ["item-1:connected:"]);
    assert_eq!(w.count("SELECT count(*) FROM app.finance_transactions WHERE owner_user_id=$1", a), 2, "a failed bank keeps what it had");
    assert_eq!(w.count("SELECT count(*) FROM app.finance_activity WHERE owner_user_id=$1 AND kind='bank.sync-failed'", a), 1);
    let repeat = w.post(a, "/finance/sync/run-now");
    assert_eq!(repeat["body"]["items"][0]["status"], "reauth-required", "{repeat}");
    assert_eq!(w.count("SELECT count(*) FROM app.finance_activity WHERE owner_user_id=$1 AND kind='bank.sync-failed'", a), 1, "a repeated failure is noted once");
    println!("PASS failed bank: A is reauth-required after the sweep, B is still connected, A's data is kept");

    // Starting again reconnects that same bank instead of adding another.
    let again = w.post(a, "/finance/connect/start");
    assert_eq!(again["status"], 200, "{again}");
    for link in w.plaid.open_links() {
        w.plaid.complete_link(&link);
    }
    let polled = w.post(a, "/finance/connect/poll");
    assert_eq!(polled["body"]["completed"], 1, "{polled}");
    assert_eq!(w.items(a), ["item-0:connected:"], "same bank, same row");
    assert_eq!(w.count("SELECT count(*) FROM app.finance_activity WHERE owner_user_id=$1 AND kind='bank.reconnect'", a), 1);
    let ok = w.post(a, "/finance/sync/run-now");
    assert_eq!(ok["body"]["items"][0]["status"], "connected", "{ok}");
    println!("PASS reconnect: A's bank signed in again, one bank row, sync works");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_and_an_admin_cannot_see_or_use_another_persons_bank() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    w.keys();
    w.connect(a);
    // A starts a second link and leaves it open, so a pending session row exists.
    assert_eq!(w.post(a, "/finance/connect/start")["status"], 200);
    for other in [b, w.f.admin] {
        for table in BANK_TABLES {
            assert_eq!(w.visible(other, table), 0, "{table}");
        }
        let polled = w.post(other, "/finance/connect/poll");
        assert_eq!((polled["body"]["pending"].clone(), polled["body"]["completed"].clone()), (json!(0), json!(0)), "{polled}");
        assert_eq!(w.post(other, "/finance/sync/run-now")["body"]["items"], json!([]));
    }
    let own: Vec<i64> = BANK_TABLES.iter().map(|t| w.visible(a, t)).collect();
    assert!(own.iter().all(|n| *n >= 1), "A sees their own rows, saw {own:?}");
    let forged = w.f.rt.block_on(async {
        let cx = DataContext::open(&w.f.db, &w.f.access(b)).await.unwrap();
        cx.db().execute("INSERT INTO app.finance_bank_links (owner_user_id, item_id, slot) VALUES ($1, 'item-x', 's0')", &[&a]).await
    });
    assert!(forged.is_err(), "a bank row carrying another person's owner id must be refused");
    println!("PASS rls: B and the admin read no bank rows and cannot poll or sync A's bank");

    let off: String = BANK_TABLES.iter().map(|t| format!("ALTER TABLE {t} DISABLE ROW LEVEL SECURITY;")).collect();
    let on: String = BANK_TABLES.iter().map(|t| format!("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;")).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&off)).unwrap();
    let open: Vec<i64> = BANK_TABLES.iter().map(|t| w.visible(w.f.admin, t)).collect();
    let synced = w.post(b, "/finance/sync/run-now");
    w.f.rt.block_on(w.f.root.batch_execute(&on)).unwrap();
    assert!(open.iter().all(|n| *n >= 1), "RED expected: the admin sees bank rows without the rule, saw {open:?}");
    assert_ne!(synced["body"]["items"], json!([]), "RED expected: B's sync reaches A's bank without the rule");
    println!("RED: with row security removed the admin saw {open:?} bank rows and B's sync reached A's bank");
    for table in BANK_TABLES {
        assert_eq!(w.visible(w.f.admin, table), 0, "{table}");
    }
    assert_eq!(w.post(b, "/finance/sync/run-now")["body"]["items"], json!([]));
    println!("GREEN: row security restored, both see 0 bank rows");
}

#[test]
#[ignore = "Only through verify-gate"]
fn bank_tokens_and_private_text_never_reach_job_rows_activity_rows_or_finance_tables() {
    let w = World::new();
    w.keys();
    w.connect(w.f.a);
    assert_eq!(w.post(w.f.a, "/finance/connect/start")["status"], 200);
    let jobs: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query("SELECT to_jsonb(t)::text FROM moss_queue.jobs t WHERE to_jsonb(t)::text LIKE '%finance.%'", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(jobs.iter().any(|j| j.contains("finance.connect-poll")), "a delayed connect poll was queued");
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') OR table_name LIKE 'finance\\_%'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    let secrets = [TOKEN_MARK, SECRET, CLIENT, "access-sandbox", "public-sandbox", "link-sandbox"];
    for table in &tables {
        for text in secrets {
            // A pending connection must keep its one-use link token to be polled.
            if text == "link-sandbox" && table.ends_with("finance_link_sessions") {
                continue;
            }
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&text])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds {text}");
        }
    }
    for table in tables.iter().filter(|t| t.starts_with("moss_queue.") || t.contains("activity") || t.contains("log")) {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&PRIVATE_MARK])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds private bank text");
    }
    // The private text is in the ledger rows, so the scan above could have found it.
    let stored: i64 = w.count("SELECT (SELECT count(*) FROM app.finance_accounts WHERE owner_user_id=$1 AND name LIKE '%BANKTEXT%')+(SELECT count(*) FROM app.finance_transactions WHERE owner_user_id=$1 AND name LIKE '%BANKTEXT%')", w.f.a);
    assert!(stored >= 2, "the marker is stored in the ledger, saw {stored}");
    for actor in [w.f.a, w.f.b, w.f.admin] {
        let seen = serde_json::to_string(&w.app.services.activity("finance", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!seen.contains(PRIVATE_MARK) && !seen.contains(TOKEN_MARK));
    }
    // Plaid saw the keys and the token, which is how the host proves it attached them.
    assert!(w.plaid.seen().iter().any(|s| s.path == "/transactions/sync" && s.body["access_token"].as_str().is_some_and(|t| t.contains(TOKEN_MARK))));
    println!("PASS privacy: {} job rows and {} tables hold no token or key, the private text only sits in ledger rows", jobs.len(), tables.len());
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_chat_bank_routes_need_an_approval_that_is_exact_and_used_once() {
    let w = World::new();
    w.keys();
    let refused = w.post(w.f.a, "/finance/chat/connect/start");
    assert_eq!(refused["status"], 500, "no approval means no link: {refused}");
    assert!(w.plaid.seen().is_empty(), "a refused call reaches no bank");
    w.approve(w.f.a, "finance.connect.start", &json!({}));
    assert_eq!(w.post(w.f.a, "/finance/chat/connect/start")["status"], 200);
    assert_eq!(w.post(w.f.a, "/finance/chat/connect/start")["status"], 500, "an approval is used once");
    println!("PASS approval: chat bank connect is exact and one-use");
}

const BUDGET_TABLES: [&str; 4] = [
    "app.finance_budget_policy",
    "app.finance_budget_assignments",
    "app.finance_budget_drafts",
    "app.finance_budget_draft_lines",
];

#[test]
#[ignore = "Only through verify-gate"]
fn the_budget_is_private_drafts_use_stored_records_and_an_uncertain_save_saves_nothing() {
    const PAYEE: &str = "PLANTED-PAYEE-MARKER-41ac90";
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let account = w.account(a, Uuid::new_v4(), NAME, 5_000_000)["body"]["id"].as_str().unwrap().to_owned();
    let configured = w.call(a, "POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(configured["status"], 200, "{configured}");
    let spend = |month: &str, cents: i64, name: &str| {
        let made = w.call(
            a,
            "POST",
            "/finance/manual/entries",
            json!({"operationId":Uuid::new_v4().to_string(),"accountId":account,"name":name,"date":format!("{month}-10"),
                "amountCents":cents,"isoCurrency":"USD","cleared":true,"categoryId":"groceries"}),
        );
        assert_eq!(made["status"], 200, "{made}");
    };
    for (month, cents) in [("2026-06", 30_000), ("2026-07", 31_234), ("2026-08", 32_000)] {
        spend(month, cents, PAYEE);
    }

    // The draft's figures come from those stored rows.
    let built = w.call(a, "POST", "/finance/budget/draft/build", json!({}));
    assert_eq!((built["status"].clone(), built["body"]["built"].clone()), (json!(200), json!(true)), "{built}");
    let draft = w.call(a, "GET", "/finance/budget/draft", Value::Null)["body"].clone();
    let line = &draft["draft"]["groups"][0]["lines"][0];
    assert_eq!((line["categoryKey"].clone(), line["basisMonthlyCents"].clone(), line["planCents"].clone()), (json!("groceries"), json!(31_078), json!(31_500)));
    println!("PASS draft: three stored months of 30000, 31234 and 32000 gave a monthly basis of 31078 and a plan of 31500");

    // A review taken now goes stale when the ledger changes, and the save then writes nothing.
    let status = w.call(a, "GET", "/finance/budget/status?month=2026-11", Value::Null);
    let current = status["body"]["currentMonth"].as_str().unwrap().to_owned();
    let status = w.call(a, "GET", &format!("/finance/budget/status?month={current}"), Value::Null)["body"].clone();
    let assign = |expected: &Value, cents: i64, previous: i64| {
        json!({"month":current,"categoryId":"dining","amountCents":cents,"previousCents":previous,
            "expectedRevision":expected["revision"],"expectedFingerprint":expected["fingerprint"]})
    };
    let first = assign(&status, 10_731, 0);
    spend("2026-08", 700, "Another");
    let counts = || (w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_budget_assignments", &[])).unwrap().get::<_, i64>(0),
        w.f.rt.block_on(w.f.root.query_one("SELECT max(revision) FROM app.finance_budget_policy", &[])).unwrap().get::<_, i64>(0));
    let before = counts();
    let stale = w.call(a, "POST", "/finance/budget/assign", first.clone());
    assert_eq!((stale["status"].clone(), stale["body"]["code"].clone()), (json!(409), json!("stale_budget")), "{stale}");
    assert_eq!(before, counts(), "a refused save must change no row and not move the revision");
    println!("PASS uncertain save: the stale review was refused with a 409 and the stored rows and revision stayed as they were");

    // A fresh review saves, and a second save holding the same review is refused.
    let fresh = w.call(a, "GET", &format!("/finance/budget/status?month={current}"), Value::Null)["body"].clone();
    let one = assign(&fresh, 10_731, 0);
    let two = json!({"month":current,"categoryId":"fuel","amountCents":5_000,"previousCents":0,
        "expectedRevision":fresh["revision"],"expectedFingerprint":fresh["fingerprint"]});
    assert_eq!(w.call(a, "POST", "/finance/budget/assign", one)["status"], 200);
    assert_eq!(w.call(a, "POST", "/finance/budget/assign", two)["body"]["code"], "stale_budget");
    assert_eq!(counts().0, 1);

    // A host failure part way through a start rolls every earlier write back.
    let draft_id = draft["draft"]["id"].clone();
    let latest = w.call(a, "GET", "/finance/budget/draft", Value::Null)["body"].clone();
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.finance_budget_assignments ADD CONSTRAINT js309_block CHECK (category_id <> 'groceries') NOT VALID")).unwrap();
    let before = counts();
    let broken = w.call_raw(a, "POST", "/finance/budget/draft/start", json!({"draftId":draft_id,"expectedRevision":latest["revision"],"expectedFingerprint":latest["fingerprint"]}));
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.finance_budget_assignments DROP CONSTRAINT js309_block")).unwrap();
    assert!(broken.is_err() || broken.as_ref().unwrap()["status"] != 200, "the failing start must not succeed: {broken:?}");
    assert_eq!(before, counts(), "a start that fails part way saves nothing, not even the revision bump");
    let status: String = w.f.rt.block_on(w.f.root.query_one("SELECT status FROM app.finance_budget_drafts LIMIT 1", &[])).unwrap().get(0);
    assert_eq!(status, "open");
    println!("PASS uncertain save: a failure part way through starting the draft left no assignment, no revision change and the draft open");

    // The second person and the admin see none of it.
    for other in [b, w.f.admin] {
        for table in BUDGET_TABLES {
            assert_eq!(w.visible(other, table), 0, "{table}");
        }
    }
    let theirs = w.call(b, "GET", &format!("/finance/budget/status?month={current}"), Value::Null);
    assert_eq!(theirs["body"]["setupRequired"], true, "{theirs}");
    assert!(!theirs.to_string().contains("31500") && !theirs.to_string().contains("10731"));
    let stolen = w.call(b, "POST", "/finance/budget/assign", assign(&fresh, 1, 0));
    assert!(stolen["status"].as_i64().unwrap() >= 400, "{stolen}");
    assert_eq!(counts().0, 1);
    println!("PASS rls: the second person and the admin read no budget rows, see no budget and cannot save into it");

    // With the owner rule removed the same reads fail.
    let off: String = BUDGET_TABLES.iter().map(|t| format!("ALTER TABLE {t} DISABLE ROW LEVEL SECURITY;")).collect();
    let on: String = BUDGET_TABLES.iter().map(|t| format!("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;")).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&off)).unwrap();
    let open: Vec<i64> = BUDGET_TABLES.iter().map(|t| w.visible(w.f.admin, t)).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&on)).unwrap();
    assert!(open.iter().all(|n| *n >= 1), "RED expected: the admin sees budget rows without the rule, saw {open:?}");
    println!("RED: with row security removed the admin saw {open:?} budget rows");
    for table in BUDGET_TABLES {
        assert_eq!(w.visible(w.f.admin, table), 0, "{table}");
    }
    println!("GREEN: row security restored, the admin sees 0 budget rows");

    // Private text never reaches the queue, the activity rows, the logs or the activity feed.
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
    for table in &tables {
        for text in [PAYEE.to_owned(), NAME.to_owned(), "31078".to_owned(), "31500".to_owned(), "10731".to_owned()] {
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&text])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds {text}");
        }
    }
    let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_transactions t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&PAYEE])).unwrap().get(0);
    assert!(stored >= 3, "the payee marker must be stored in the ledger so the scan can see it");
    let kinds: Vec<String> = w.f.rt.block_on(w.f.root.query("SELECT DISTINCT kind FROM app.finance_activity WHERE kind LIKE 'budget.%'", &[])).unwrap().iter().map(|r| r.get(0)).collect();
    assert!(kinds.contains(&"budget.assign".to_owned()) && kinds.contains(&"budget.configure".to_owned()), "{kinds:?}");
    println!("PASS privacy: scanned {} tables, budget activity rows {kinds:?} hold ids only", tables.len());
}

const PART24_TABLES: [&str; 7] = [
    "app.finance_bill_occurrences",
    "app.finance_bill_adjustments",
    "app.finance_targets",
    "app.finance_bill_plans",
    "app.finance_flex_policies",
    "app.finance_card_policies",
    "app.finance_card_assignments",
];

#[test]
#[ignore = "Only through verify-gate"]
fn bills_targets_flex_and_card_reserves_are_private_and_leave_no_private_text() {
    const BILL: &str = "PLANTED-BILL-MARKER-6e0b7d";
    const CENTS: i64 = 4_271_828;
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let account = w.account(a, Uuid::new_v4(), NAME, 50_000_000)["body"]["id"].as_str().unwrap().to_owned();
    let card_op = Uuid::new_v4();
    let card = w.call(a, "POST", "/finance/manual/accounts", json!({"operationId":card_op.to_string(),"name":"Card","accountType":"credit",
        "isoCurrency":"USD","cleared":true,"openingDate":"2026-01-01","openingBalanceCents":0}))["body"]["id"].as_str().unwrap().to_owned();
    let configured = w.call(a, "POST", "/finance/budget/configure", json!({"isoCurrency":"USD","acknowledgeLegacy":false}));
    assert_eq!(configured["status"], 200, "{configured}");
    let status = |actor: Uuid| w.call(actor, "GET", "/finance/budget/status?month=2026-11", Value::Null)["body"].clone();
    let current = status(a)["currentMonth"].as_str().unwrap().to_owned();
    let review = |extra: Value| {
        let s = w.call(a, "GET", &format!("/finance/budget/status?month={current}"), Value::Null)["body"].clone();
        let mut body = json!({"month":current,"expectedRevision":s["revision"],"expectedFingerprint":s["fingerprint"]});
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        body
    };

    let bill_id = Uuid::new_v4().to_string();
    let bill = review(json!({"id":bill_id,"name":BILL,"accountId":account,"categoryId":"groceries",
        "amountCents":CENTS,"anchorDate":format!("{current}-20"),"cadence":"monthly"}));
    let made = w.call(a, "POST", "/finance/bills", bill.clone());
    assert_eq!(made["status"], 200, "{made}");
    // The same review is now stale, so a second save writes nothing.
    let again = w.call(a, "POST", "/finance/bills", bill);
    assert_eq!((again["status"].clone(), again["body"]["code"].clone()), (json!(409), json!("stale_budget")), "{again}");
    let target = w.call(a, "POST", "/finance/targets", review(json!({"categoryId":"dining","kind":"monthly","amountCents":CENTS})));
    assert_eq!(target["status"], 200, "{target}");
    let enrolled = w.call(a, "POST", "/finance/cards/save", review(json!({"accountId":card,"action":"enroll","availableCents":0})));
    assert_eq!(enrolled["status"], 200, "{enrolled}");
    let pool = w.call(a, "POST", "/finance/flex/configure", review(json!({"mode":"flex","flexIds":["groceries","transport"],"nonMonthlyIds":[]})));
    assert_eq!(pool["status"], 200, "{pool}");
    let due = format!("{current}-20");
    let moved = w.call(a, "POST", "/finance/bills/adjust", review(json!({"planId":bill_id,"dueDate":due,"plannedDate":format!("{current}-21"),"amountCents":CENTS+1})));
    assert_eq!(moved["status"], 200, "{moved}");
    let skipped = w.call(a, "POST", "/finance/bills/decide", review(json!({"planId":bill_id,"dueDate":due,"state":"skipped"})));
    assert_eq!(skipped["status"], 200, "{skipped}");
    let listed = w.call(a, "GET", &format!("/finance/bills?from={current}-01&to={current}-28"), Value::Null);
    assert!(listed.to_string().contains(BILL), "{listed}");
    let counts: Vec<i64> = PART24_TABLES.iter().map(|t| w.visible(a, t)).collect();
    assert_eq!(counts, vec![1; PART24_TABLES.len()], "exact rows per table for the owner");
    println!("PASS bills: a bill, a target and a card reserve were saved, and a repeated save with a stale review was refused with a 409");

    for other in [b, w.f.admin] {
        for table in PART24_TABLES {
            assert_eq!(w.visible(other, table), 0, "{table}");
        }
    }
    let theirs = w.call(b, "GET", &format!("/finance/bills?from={current}-01&to={current}-28"), Value::Null);
    assert!(!theirs.to_string().contains(BILL) && !theirs.to_string().contains("4271828"), "{theirs}");
    let stolen = w.call(b, "POST", "/finance/targets/remove", json!({"month":current,"categoryId":"dining","expectedRevision":0,"expectedFingerprint":"x"}));
    assert!(stolen["status"].as_i64().unwrap() >= 400, "{stolen}");
    println!("PASS rls: the second person and the admin read no bill, target, flexible pool or card rows and cannot change them");

    let off: String = PART24_TABLES.iter().map(|t| format!("ALTER TABLE {t} DISABLE ROW LEVEL SECURITY;")).collect();
    let on: String = PART24_TABLES.iter().map(|t| format!("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;")).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&off)).unwrap();
    let open: Vec<i64> = PART24_TABLES.iter().map(|t| w.visible(w.f.admin, t)).collect();
    w.f.rt.block_on(w.f.root.batch_execute(&on)).unwrap();
    assert_eq!(open, vec![1; PART24_TABLES.len()], "RED expected: the admin sees rows without the rule, saw {open:?}");
    println!("RED: with row security removed the admin saw {open:?} part 24 rows");
    for table in PART24_TABLES {
        assert_eq!(w.visible(w.f.admin, table), 0, "{table}");
    }
    println!("GREEN: row security restored, the admin sees 0 part 24 rows");

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
    for table in &tables {
        for text in [BILL.to_owned(), "4271828".to_owned()] {
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&text])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds {text}");
        }
    }
    let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.finance_bill_plans t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&BILL])).unwrap().get(0);
    assert_eq!(stored, 1, "the bill name must be stored in the plan so the scan can see it");
    let kinds: Vec<String> = w.f.rt.block_on(w.f.root.query("SELECT DISTINCT kind FROM app.finance_activity WHERE kind LIKE 'bill.%' OR kind LIKE 'target.%' OR kind LIKE 'card.%'", &[])).unwrap().iter().map(|r| r.get(0)).collect();
    assert!(kinds.contains(&"bill.create".to_owned()) && kinds.contains(&"target.set".to_owned()) && kinds.contains(&"card.enroll".to_owned()), "{kinds:?}");
    println!("PASS privacy: scanned {} tables, part 24 activity rows {kinds:?} hold ids only", tables.len());
}
