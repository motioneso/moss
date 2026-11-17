//! Database proofs for the Connectors adapter. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_connectors_host::{connector_cipher, store};
use moss_module_host::runtime::Request;
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const SENTINEL: &str = "SENTINEL-PASSWORD-7f3a";

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Conn A',true),($2,$4,'Conn B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        Self { rt, root, db, a, b }
    }

    /// One committed call as `actor`.
    fn call(&self, actor: Uuid, op: &str, resource: &str, parameters: Value) -> Value {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "connectors-proof"))
                .await
                .unwrap();
            let cipher = connector_cipher(KEY).unwrap();
            let request = Request {
                operation: op.into(),
                resource: resource.into(),
                parameters,
            };
            let out = store::run(&cx, &cipher, &request).await.unwrap();
            cx.commit().await.unwrap();
            out
        })
    }

    fn create(&self, actor: Uuid) -> Value {
        self.call(
            actor,
            "set",
            "connectors.account-write",
            json!({"action":"create","providerId":"google","scopes":["https://www.googleapis.com/auth/calendar"],
                   "status":"active","tokenPayload":{"password":SENTINEL,"refreshToken":SENTINEL}}),
        )
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn create_seals_the_secret_and_returns_only_the_safe_summary() {
    let f = Fixture::new();
    let account = f.create(f.a);
    assert_eq!(account["hasSecret"], true);
    assert_eq!(account["ownerUserId"], f.a.to_string());
    assert!(account.get("encryptedSecret").is_none());
    let id: Uuid = account["id"].as_str().unwrap().parse().unwrap();
    let stored: Value = f.rt.block_on(f.root.query_one(
        "SELECT encrypted_secret FROM app.connector_accounts WHERE id=$1",
        &[&id],
    )).unwrap().get(0);
    let raw = stored.to_string();
    assert!(!raw.contains(SENTINEL), "secret stored in the clear");
    let cipher = connector_cipher(KEY).unwrap();
    let opened = cipher
        .decrypt_json(&cipher.parse_envelope(&stored).unwrap())
        .unwrap();
    assert_eq!(opened.value["password"], SENTINEL);
}

#[test]
#[ignore = "Only through verify-gate"]
fn no_response_carries_the_secret() {
    let f = Fixture::new();
    let account = f.create(f.a);
    let id = account["id"].as_str().unwrap();
    f.call(f.a, "set", "connectors.account-write", json!({"action":"update","id":id,"tokenPayload":{"password":SENTINEL}}));
    let mut seen = vec![account.to_string()];
    for (resource, parameters) in [
        ("connectors.providers", json!({})),
        ("connectors.accounts", json!({})),
        ("connectors.accounts", json!({"id":id})),
        ("connectors.admin-accounts", json!({})),
        ("connectors.diagnostics", json!({"limit":11})),
        ("connectors.feature-grants", json!({"accountId":id})),
    ] {
        seen.push(f.call(f.a, "get", resource, parameters).to_string());
    }
    seen.push(f.call(f.a, "set", "connectors.account-write", json!({"action":"revoke","id":id})).to_string());
    for text in &seen {
        assert!(!text.contains(SENTINEL), "secret reached a response: {text}");
    }
}

fn foreign_reach(f: &Fixture, id: &str) -> Result<(), String> {
    let seen = f.call(f.b, "get", "connectors.accounts", json!({"id":id}));
    let listed = f.call(f.b, "get", "connectors.accounts", json!({}));
    let updated = f.call(f.b, "set", "connectors.account-write", json!({"action":"update","id":id,"scopes":["x"]}));
    let revoked = f.call(f.b, "set", "connectors.account-write", json!({"action":"revoke","id":id}));
    let granted = f.call(f.b, "set", "connectors.feature-grants", json!({"accountId":id,"value":{"email":false},"audit":[]}));
    if seen.as_array().map_or(true, |rows| !rows.is_empty())
        || listed.as_array().map_or(true, |rows| !rows.is_empty())
        || !updated.is_null()
        || !revoked.is_null()
        || !granted.is_null()
    {
        return Err("foreign person reached the account".into());
    }
    Ok(())
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_read_update_revoke_or_grant() {
    let f = Fixture::new();
    let id = f.create(f.a)["id"].as_str().unwrap().to_string();
    foreign_reach(&f, &id).unwrap();
    // Remove the protection, expect the same checks to fail, then restore it.
    let table = "app.connector_accounts";
    f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
    let red = foreign_reach(&f, &id);
    f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
    println!("RED without row security: {red:?}");
    assert!(red.is_err(), "proof did not notice removed row-level security");
    // The unprotected run changed the first account, so a fresh one proves the restored rules.
    let id = f.create(f.a)["id"].as_str().unwrap().to_string();
    foreign_reach(&f, &id).unwrap();
    let mine = f.call(f.a, "get", "connectors.accounts", json!({"id":id}));
    assert_eq!(mine[0]["scopes"], json!(["https://www.googleapis.com/auth/calendar"]));
    assert_eq!(mine[0]["status"], "active");
}

#[test]
#[ignore = "Only through verify-gate"]
fn grants_save_and_write_one_audit_row_per_changed_feature() {
    let f = Fixture::new();
    let id = f.create(f.a)["id"].as_str().unwrap().to_string();
    assert!(f.call(f.a, "get", "connectors.feature-grants", json!({"accountId":id})).is_null());
    f.call(f.a, "set", "connectors.feature-grants", json!({"accountId":id,"value":{"email":false,"calendar":true},
        "audit":[{"feature":"email","enabled":false}]}));
    let stored = f.call(f.a, "get", "connectors.feature-grants", json!({"accountId":id}));
    assert_eq!(stored, json!({"email":false,"calendar":true}));
    let rows = f.rt.block_on(f.root.query(
        "SELECT action, target_type, target_id, metadata FROM app.admin_audit_events WHERE target_id=$1",
        &[&id],
    )).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, String>(0), "connector.feature_grant.set");
    assert_eq!(rows[0].get::<_, Value>(3), json!({"feature":"email","enabled":false}));
}

#[test]
#[ignore = "Only through verify-gate"]
fn update_clears_revoked_state_and_admin_list_checks_the_admin() {
    let f = Fixture::new();
    let id = f.create(f.a)["id"].as_str().unwrap().to_string();
    let revoked = f.call(f.a, "set", "connectors.account-write", json!({"action":"revoke","id":id}));
    assert_eq!(revoked["status"], "revoked");
    assert!(revoked["revokedAt"].is_string());
    let back = f.call(f.a, "set", "connectors.account-write", json!({"action":"update","id":id,"status":"active"}));
    assert_eq!(back["status"], "active");
    assert!(back["revokedAt"].is_null());
    assert_eq!(f.call(f.a, "get", "connectors.admin-accounts", json!({}))["status"], "ok");
    assert_eq!(f.call(f.b, "get", "connectors.admin-accounts", json!({}))["status"], "forbidden");
}

#[test]
#[ignore = "Only through verify-gate"]
fn sync_counts_keep_numbers_only_and_an_uppercase_id_is_not_found() {
    let f = Fixture::new();
    let account = f.create(f.a);
    let id = account["id"].as_str().unwrap().to_owned();
    let uuid: Uuid = id.parse().unwrap();
    for counts in [
        json!({"emailUpserted": {"accessToken": SENTINEL}, "emailFailures": 2, "emailErrorDetail": {"status": SENTINEL, "reason": "late", "operation": null}}),
        json!({"emailErrorDetail": {"status": 429, "reason": {"x": SENTINEL}, "operation": {"x": SENTINEL}}}),
    ] {
        f.rt.block_on(f.root.execute(
            "UPDATE app.connector_accounts SET last_sync_counts=$2 WHERE id=$1",
            &[&uuid, &counts],
        ))
        .unwrap();
        let rows = f.call(f.a, "get", "connectors.accounts", json!({}));
        assert!(!rows.to_string().contains(SENTINEL), "{rows}");
    }
    f.rt.block_on(f.root.execute(
        "UPDATE app.connector_accounts SET last_sync_counts=$2 WHERE id=$1",
        &[&uuid, &json!({"emailFailures": 2, "emailErrorDetail": {"status": null, "reason": "late", "operation": null}})],
    ))
    .unwrap();
    let rows = f.call(f.a, "get", "connectors.accounts", json!({}));
    assert_eq!(rows[0]["lastSyncCounts"]["emailFailures"], 2);
    assert_eq!(rows[0]["lastSyncCounts"]["emailErrorDetail"], json!({"status": null, "reason": "late", "operation": null}));
    // Another spelling of the same id is not found for writes, so no guard can be skipped.
    let upper = id.to_uppercase();
    for (resource, extra) in [("connectors.account-write", json!({"action":"update","scopes":["x"]})), ("connectors.account-write", json!({"action":"revoke"}))] {
        let mut params = extra;
        params["id"] = json!(upper);
        let out = f.call(f.a, "set", resource, params);
        assert_eq!(out, Value::Null, "{out}");
    }
    let rows = f.call(f.a, "get", "connectors.accounts", json!({"id": id}));
    assert_eq!(rows[0]["status"], "active");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_write_a_monitor_health_row_for_another_persons_account() {
    let f = Fixture::new();
    let id = f.create(f.a)["id"].as_str().unwrap().to_owned();
    let key = format!("connector.{id}.monitor_status");
    let rows_for = |f: &Fixture| -> i64 {
        f.rt.block_on(f.root.query_one("SELECT count(*) FROM app.preferences WHERE key=$1", &[&key]))
            .unwrap()
            .get(0)
    };
    let params = json!({"accountId": id, "record": {"state": "ok"}});
    let own = f.call(f.a, "set", "connectors.monitor-status", params.clone());
    assert_eq!(own, json!({"saved": true}));
    assert_eq!(rows_for(&f), 1);
    let refused = f.call(f.b, "set", "connectors.monitor-status", params.clone());
    assert_eq!(refused, Value::Null, "another person wrote a health row: {refused}");
    assert_eq!(rows_for(&f), 1);
    // With the protection removed the same call writes, so the check above notices.
    f.rt.block_on(f.root.batch_execute(
        "ALTER TABLE app.connector_accounts NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts DISABLE ROW LEVEL SECURITY;",
    ))
    .unwrap();
    let leaked = f.call(f.b, "set", "connectors.monitor-status", params);
    f.rt.block_on(f.root.batch_execute(
        "ALTER TABLE app.connector_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts FORCE ROW LEVEL SECURITY;",
    ))
    .unwrap();
    assert_eq!(leaked, json!({"saved": true}), "the proof did not notice the missing protection");
    assert_eq!(rows_for(&f), 2);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_write_an_outlook_health_row_for_another_persons_account() {
    let f = Fixture::new();
    let made = f.call(
        f.a,
        "set",
        "connectors.account-write",
        json!({"action":"create","providerId":"outlook-browser-calendar","scopes":["calendar.readonly"],
               "status":"active","tokenPayload":{"kind":"browser-binding"}}),
    );
    let id = made["id"].as_str().unwrap().to_owned();
    let key = format!("connector.{id}.outlook_calendar_health");
    let rows_for = |f: &Fixture| -> i64 {
        f.rt.block_on(f.root.query_one("SELECT count(*) FROM app.preferences WHERE key=$1", &[&key]))
            .unwrap()
            .get(0)
    };
    let params = json!({"accountId": id, "value": {"state": "current"}});
    assert_eq!(f.call(f.a, "set", "connectors.outlook-health", params.clone()), json!({"saved": true}));
    assert_eq!(rows_for(&f), 1);
    let refused = f.call(f.b, "set", "connectors.outlook-health", params.clone());
    assert_eq!(refused, json!({"saved": false}), "another person wrote a health row: {refused}");
    assert_eq!(rows_for(&f), 1);
    // A Google account is never an Outlook source, even for its owner.
    let google = f.create(f.a)["id"].as_str().unwrap().to_owned();
    let other = f.call(f.a, "set", "connectors.outlook-health", json!({"accountId": google, "value": {"state": "current"}}));
    assert_eq!(other, json!({"saved": false}));
    // With the protection removed the same call writes, so the check above notices.
    f.rt.block_on(f.root.batch_execute(
        "ALTER TABLE app.connector_accounts NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts DISABLE ROW LEVEL SECURITY;",
    ))
    .unwrap();
    let leaked = f.call(f.b, "set", "connectors.outlook-health", params);
    f.rt.block_on(f.root.batch_execute(
        "ALTER TABLE app.connector_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts FORCE ROW LEVEL SECURITY;",
    ))
    .unwrap();
    assert_eq!(leaked, json!({"saved": true}), "the proof did not notice the missing protection");
    assert_eq!(rows_for(&f), 2);
}
