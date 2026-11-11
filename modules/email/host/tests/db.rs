//! Database proofs for the Email adapter. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_email_host::store;
use moss_module_host::runtime::Request;
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    a: Uuid,
    b: Uuid,
    account_a: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b, account_a) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Mail A',false),($2,$4,'Mail B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            root.execute(
                "INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,scopes,status,encrypted_secret,created_at,updated_at)
                 VALUES($1,'google',$2,ARRAY['https://www.googleapis.com/auth/gmail.modify'],'active','{}'::jsonb,now(),now())",
                &[&account_a, &a],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        Self { rt, root, db, a, b, account_a }
    }

    /// One committed call as `actor`.
    fn call(&self, actor: Uuid, op: &str, resource: &str, parameters: Value) -> Value {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "email-proof"))
                .await
                .unwrap();
            let request = Request {
                operation: op.into(),
                resource: resource.into(),
                parameters,
            };
            let out = store::run(&cx, &request).await.unwrap();
            cx.commit().await.unwrap();
            out
        })
    }

    /// The fixture writer for tests: a cached message as the account's owner.
    fn cache(&self, external: &str, subject: &str) -> Value {
        self.call(
            self.a,
            "set",
            "email.cache-write",
            json!({"action":"insert","connectorAccountId":self.account_a.to_string(),"externalId":external,
                   "fields":{"sender":"sender@example.test","recipients":["me@example.test"],"subject":subject,
                             "receivedAt":"2026-01-02T03:04:05.678Z","snippet":"snip","bodyExcerpt":"body","signals":{"a":1}}}),
        )
    }

    fn sql(&self, statement: &str) {
        self.rt.block_on(self.root.batch_execute(statement)).unwrap();
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn insert_returns_the_old_shape_and_a_repeat_replaces_the_content() {
    let f = Fixture::new();
    let message = f.cache("ext-1", "First");
    assert_eq!(message["ownerUserId"], f.a.to_string());
    assert_eq!(message["receivedAt"], "2026-01-02T03:04:05.678Z");
    assert_eq!(message["recipients"], json!(["me@example.test"]));
    assert_eq!(message["summary"], Value::Null);
    assert_eq!(message.as_object().unwrap().len(), 13);
    let again = f.cache("ext-1", "Renamed");
    assert_eq!(again["id"], message["id"]);
    let rows = f.call(f.a, "get", "email.messages", json!({}));
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["subject"], "Renamed");
    let detail = f.call(f.a, "get", "email.messages", json!({"id":message["id"]}));
    assert_eq!(detail[0]["id"], message["id"]);
}

#[test]
#[ignore = "Only through verify-gate"]
fn list_is_newest_first() {
    let f = Fixture::new();
    f.cache("old", "Old");
    f.call(f.a, "set", "email.cache-write",
        json!({"action":"insert","connectorAccountId":f.account_a.to_string(),"externalId":"new",
               "fields":{"sender":"s","subject":"New","receivedAt":"2026-02-01T00:00:00.000Z"}}));
    let rows = f.call(f.a, "get", "email.messages", json!({}));
    assert_eq!(rows[0]["subject"], "New");
    assert_eq!(rows[1]["subject"], "Old");
}

#[test]
#[ignore = "Only through verify-gate"]
fn update_changes_only_the_named_fields() {
    let f = Fixture::new();
    let id = f.cache("ext-1", "Keep")["id"].as_str().unwrap().to_string();
    let out = f.call(f.a, "set", "email.cache-write",
        json!({"action":"update","id":id,"fields":{"summary":"Short","signals":{"b":2}}}));
    assert_eq!(out["summary"], "Short");
    assert_eq!(out["signals"], json!({"b":2}));
    assert_eq!(out["subject"], "Keep");
    assert_eq!(out["snippet"], "snip");
    let missing = f.call(f.a, "set", "email.cache-write",
        json!({"action":"update","id":Uuid::new_v4().to_string(),"fields":{"summary":"x"}}));
    assert_eq!(missing, Value::Null);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_malformed_id_is_not_found_and_a_foreign_account_is_refused() {
    let f = Fixture::new();
    assert_eq!(f.call(f.a, "get", "email.messages", json!({"id":"not-a-uuid"})), json!([]));
    let refused = f.call(f.b, "set", "email.cache-write",
        json!({"action":"insert","connectorAccountId":f.account_a.to_string(),"externalId":"x",
               "fields":{"sender":"s","subject":"t","receivedAt":"2026-01-01T00:00:00.000Z"}}));
    assert_eq!(refused, json!({"rejected":true}));
    assert_eq!(f.call(f.a, "get", "email.messages", json!({})), json!([]));
}

fn foreign_reach(f: &Fixture, id: &str) -> Result<(), String> {
    let seen = f.call(f.b, "get", "email.messages", json!({"id":id}));
    let listed = f.call(f.b, "get", "email.messages", json!({}));
    let updated = f.call(f.b, "set", "email.cache-write",
        json!({"action":"update","id":id,"fields":{"subject":"hijacked"}}));
    if seen.as_array().map_or(true, |rows| !rows.is_empty())
        || listed.as_array().map_or(true, |rows| !rows.is_empty())
        || !updated.is_null()
    {
        return Err("foreign person reached the message".into());
    }
    Ok(())
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_read_or_change_the_message() {
    let f = Fixture::new();
    let id = f.cache("ext-1", "Private")["id"].as_str().unwrap().to_string();
    foreign_reach(&f, &id).unwrap();
    // Remove the protection, expect the same checks to fail, then restore it.
    let table = "app.email_messages";
    f.sql(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"));
    let red = foreign_reach(&f, &id);
    f.sql(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"));
    println!("RED without row security: {red:?}");
    assert!(red.is_err(), "proof did not notice removed row-level security");
    // The unprotected run changed the subject, so a fresh message proves the restored rules.
    let id = f.cache("ext-2", "Private again")["id"].as_str().unwrap().to_string();
    foreign_reach(&f, &id).unwrap();
    assert_eq!(f.call(f.a, "get", "email.messages", json!({"id":id}))[0]["subject"], "Private again");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_shared_message_is_readable_by_the_grantee_and_writable_only_with_manage() {
    let f = Fixture::new();
    let id = f.cache("ext-1", "Shared")["id"].as_str().unwrap().to_string();
    let uuid: Uuid = id.parse().unwrap();
    assert_eq!(f.call(f.b, "get", "email.messages", json!({"id":id})), json!([]));
    f.sql(&format!(
        "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('email_message','{uuid}','{}','{}','view')",
        f.a, f.b
    ));
    let seen = f.call(f.b, "get", "email.messages", json!({"id":id}));
    assert_eq!(seen[0]["subject"], "Shared");
    assert_eq!(f.call(f.b, "get", "email.messages", json!({})).as_array().unwrap().len(), 1);
    let blocked = f.call(f.b, "set", "email.cache-write",
        json!({"action":"update","id":id,"fields":{"subject":"edited"}}));
    assert_eq!(blocked, Value::Null, "a view share must not allow a write");
    f.sql(&format!("UPDATE app.shares SET level='manage' WHERE resource_id='{uuid}' AND grantee_user_id='{}'", f.b));
    let edited = f.call(f.b, "set", "email.cache-write",
        json!({"action":"update","id":id,"fields":{"subject":"edited"}}));
    assert_eq!(edited["subject"], "edited");
    // Removing the share removes the access. Without the share rule the read would still work
    // only if row-level security were off, which the previous test proves is noticed.
    f.sql(&format!("DELETE FROM app.shares WHERE resource_id='{uuid}' AND grantee_user_id='{}'", f.b));
    assert_eq!(f.call(f.b, "get", "email.messages", json!({"id":id})), json!([]));
    assert_eq!(f.call(f.a, "get", "email.messages", json!({"id":id}))[0]["subject"], "edited");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_share_with_the_protection_removed_would_leak_so_the_check_has_teeth() {
    let f = Fixture::new();
    let id = f.cache("ext-1", "Unshared")["id"].as_str().unwrap().to_string();
    let table = "app.email_messages";
    f.sql(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"));
    let leaked = f.call(f.b, "get", "email.messages", json!({"id":id}));
    f.sql(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"));
    assert_eq!(leaked.as_array().unwrap().len(), 1, "an unshared message was not exposed without row security");
    assert_eq!(f.call(f.b, "get", "email.messages", json!({"id":id})), json!([]));
}

#[test]
#[ignore = "Only through verify-gate"]
fn preferences_default_save_and_stay_private() {
    let f = Fixture::new();
    let keys = json!(["email.signal_create_tasks","email.signal_auto_send","email.task_creation_mode"]);
    assert_eq!(f.call(f.a, "get", "email.preferences", json!({"keys":keys})), json!({}));
    let after = f.call(f.a, "set", "email.preferences",
        json!({"values":{"email.signal_auto_send":true,"email.task_creation_mode":"auto_safe"}}));
    assert_eq!(after["email.signal_auto_send"], true);
    assert_eq!(after["email.task_creation_mode"], "auto_safe");
    let again = f.call(f.a, "set", "email.preferences", json!({"values":{"email.signal_auto_send":false}}));
    assert_eq!(again["email.signal_auto_send"], false);
    let revision: i32 = f.rt.block_on(f.root.query_one(
        "SELECT revision FROM app.preferences WHERE owner_user_id=$1 AND key='email.signal_auto_send'", &[&f.a])).unwrap().get(0);
    assert_eq!(revision, 2);
    assert_eq!(f.call(f.b, "get", "email.preferences", json!({"keys":keys})), json!({}));
}

#[test]
#[ignore = "Only through verify-gate"]
fn source_switch_keeps_other_entries_and_draft_policy_round_trips() {
    let f = Fixture::new();
    assert_eq!(f.call(f.a, "get", "email.source-behaviors", json!({})), json!({}));
    f.sql(&format!(
        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES('{}','sourceBehaviors','{{\"calendar.briefings\":false}}')", f.a));
    f.call(f.a, "set", "email.source-behaviors", json!({"enabled":false}));
    assert_eq!(f.call(f.a, "get", "email.source-behaviors", json!({})), json!({"enabled":false}));
    let stored: Value = f.rt.block_on(f.root.query_one(
        "SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key='sourceBehaviors'", &[&f.a])).unwrap().get(0);
    assert_eq!(stored, json!({"calendar.briefings":false,"email.briefings":false}));
    assert_eq!(f.call(f.a, "get", "email.draft-policy", json!({})), json!({}));
    f.call(f.a, "set", "email.draft-policy", json!({"tier":"trusted_auto"}));
    assert_eq!(f.call(f.a, "get", "email.draft-policy", json!({})), json!({"tier":"trusted_auto"}));
    assert_eq!(f.call(f.b, "get", "email.draft-policy", json!({})), json!({}));
}
