//! Database proofs for the Email adapter. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_email_host::{store, understand};
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
            // The delete rule the host adds when it installs the Email package.
            let mut root = root;
            let tx = root.transaction().await.unwrap();
            moss_module_host::rls::emit_owner_delete(&tx, "app.email_messages").await.unwrap();
            tx.commit().await.unwrap();
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
            let out = if resource == "email.suppression"
                || resource == "email.triage-feedback"
                || resource.starts_with("email.understand")
            {
                understand::run(&cx, &request).await.unwrap()
            } else {
                store::run(&cx, &request).await.unwrap()
            };
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

#[test]
#[ignore = "Only through verify-gate"]
fn a_large_mailbox_pages_under_the_response_limit_without_gaps_or_repeats() {
    let f = Fixture::new();
    let excerpt = "x".repeat(500);
    f.rt.block_on(async {
        f.root
            .execute(
                "INSERT INTO app.email_messages(id,connector_account_id,owner_user_id,sender,recipients,subject,snippet,body_excerpt,received_at,external_id)
                 SELECT gen_random_uuid(),$1,$2,'s',ARRAY['r'],'Bulk '||n,'snip',$3,now() - (n || ' seconds')::interval,'bulk-'||n
                 FROM generate_series(1,2400) n",
                &[&f.account_a, &f.a, &excerpt],
            )
            .await
            .unwrap();
    });
    let mut ids = std::collections::BTreeSet::new();
    let mut offset = 0;
    loop {
        let page = f.call(f.a, "get", "email.messages", json!({"limit":200,"offset":offset}));
        let rows = page.as_array().unwrap();
        assert!(page.to_string().len() < 1024 * 1024 / 2, "a page must stay well under the limit");
        for row in rows {
            assert!(ids.insert(row["id"].as_str().unwrap().to_string()), "repeated row");
        }
        if rows.len() < 200 {
            break;
        }
        offset += 200;
    }
    assert_eq!(ids.len(), 2400);
    // The old unbounded read would not fit one host answer.
    let all = f.call(f.a, "get", "email.messages", json!({}));
    assert!(all.to_string().len() > 1024 * 1024, "the fixture must be big enough to prove the point");
}

fn prune_params(f: &Fixture, keep: &[&str]) -> Value {
    json!({"action":"prune","connectorAccountId":f.account_a.to_string(),"prefix":"imap:",
           "since":"2026-01-01T00:00:00.000Z","keep":keep})
}

fn count(f: &Fixture, actor: Uuid) -> usize {
    f.call(actor, "get", "email.messages", json!({})).as_array().unwrap().len()
}

#[test]
#[ignore = "Only through verify-gate"]
fn prune_removes_only_unlisted_in_window_mail_of_the_owner() {
    let f = Fixture::new();
    f.cache("imap:INBOX:1:1", "Kept");
    f.cache("imap:INBOX:1:2", "Gone");
    f.cache("gmail-3", "Other source");
    // An older message outside the window stays even when it is unlisted.
    f.call(f.a, "set", "email.cache-write",
        json!({"action":"insert","connectorAccountId":f.account_a.to_string(),"externalId":"imap:INBOX:1:3",
               "fields":{"sender":"s@example.test","recipients":["me@example.test"],"subject":"Old",
                         "receivedAt":"2020-01-01T00:00:00.000Z","snippet":"x"}}));
    let out = f.call(f.a, "set", "email.cache-write", prune_params(&f, &["imap:INBOX:1:1"]));
    assert_eq!(out["deleted"], 1);
    let left: Vec<String> = f.call(f.a, "get", "email.messages", json!({})).as_array().unwrap()
        .iter().map(|m| m["subject"].as_str().unwrap().to_string()).collect();
    assert!(left.contains(&"Kept".into()) && left.contains(&"Other source".into()) && left.contains(&"Old".into()));
    assert!(!left.contains(&"Gone".into()));
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_prune_and_the_delete_rule_has_teeth() {
    let f = Fixture::new();
    let first: Uuid = f.cache("imap:INBOX:1:1", "Private one")["id"].as_str().unwrap().parse().unwrap();
    let second: Uuid = f.cache("imap:INBOX:1:2", "Private two")["id"].as_str().unwrap().parse().unwrap();
    // Without a share the second person cannot even see the mail.
    let refused = f.call(f.b, "set", "email.cache-write", prune_params(&f, &[]));
    assert_eq!(refused["deleted"], 0, "another person deleted mail: {refused}");
    assert_eq!(count(&f, f.a), 2);
    // A view share lets the second person see the mail, so only the delete rule stands in the way.
    for id in [first, second] {
        f.sql(&format!(
            "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('email_message','{id}','{}','{}','view')",
            f.a, f.b
        ));
    }
    let shared = f.call(f.b, "set", "email.cache-write", prune_params(&f, &[]));
    assert_eq!(shared["deleted"], 0, "a view share let another person delete mail: {shared}");
    assert_eq!(count(&f, f.a), 2);
    // With the delete rule loosened, the same call deletes, so the checks above notice.
    f.sql("DROP POLICY moss_module_delete ON app.email_messages");
    f.sql("CREATE POLICY moss_module_delete ON app.email_messages FOR DELETE TO jarvis_app_runtime, jarvis_worker_runtime USING (true)");
    let leaked = f.call(f.b, "set", "email.cache-write", prune_params(&f, &[]));
    println!("RED without the delete rule: {leaked}");
    assert_eq!(leaked["deleted"], 2, "the proof did not notice a missing delete rule");
    assert_eq!(count(&f, f.a), 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_share_never_grants_delete() {
    let f = Fixture::new();
    let id: Uuid = f.cache("imap:INBOX:1:1", "Shared")["id"].as_str().unwrap().parse().unwrap();
    f.sql(&format!(
        "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('email_message','{id}','{}','{}','manage')",
        f.a, f.b
    ));
    let refused = f.call(f.b, "set", "email.cache-write", prune_params(&f, &[]));
    assert_eq!(refused["deleted"], 0);
    assert_eq!(count(&f, f.a), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn keys_report_sizes_and_an_overwrite_keeps_what_was_understood() {
    let f = Fixture::new();
    let account = f.account_a.to_string();
    f.call(f.a, "set", "email.cache-write",
        json!({"action":"insert","connectorAccountId":account,"externalId":"imap:INBOX:1:1",
               "fields":{"sender":"s@example.test","recipients":["me@example.test"],"subject":"First",
                         "receivedAt":"2026-01-02T00:00:00.000Z","snippet":"s","summary":"Understood","signals":{"urgent":true},
                         "externalMetadata":{"sizeBytes":100}}}));
    let keys = f.call(f.a, "get", "email.cache-keys", json!({"connectorAccountId":account,"externalIds":["imap:INBOX:1:1","imap:INBOX:1:9"]}));
    assert_eq!(keys, json!([{"externalId":"imap:INBOX:1:1","sizeBytes":100,"historyId":null,"analysisAttempts":0,"finished":false}]));
    assert_eq!(f.call(f.b, "get", "email.cache-keys", json!({"connectorAccountId":account,"externalIds":["imap:INBOX:1:1"]})), json!([]));
    // A sync overwrite carries no summary or signals, and the earlier ones stay.
    let again = f.call(f.a, "set", "email.cache-write",
        json!({"action":"insert","connectorAccountId":account,"externalId":"imap:INBOX:1:1",
               "fields":{"sender":"s@example.test","recipients":["me@example.test"],"subject":"Second",
                         "receivedAt":"2026-01-02T00:00:00.000Z","snippet":"t","externalMetadata":{"sizeBytes":200}}}));
    assert_eq!(again["subject"], "Second");
    assert_eq!(again["summary"], "Understood");
    assert_eq!(again["signals"], json!({"urgent":true}));
}

fn sent_mail(f: &Fixture, external: &str, to: &str) {
    f.call(
        f.a,
        "set",
        "email.cache-write",
        json!({"action":"insert","connectorAccountId":f.account_a.to_string(),"externalId":external,
               "fields":{"sender":"Me <me@example.test>","recipients":[to],"subject":"Sent",
                         "receivedAt":"2026-01-01T00:00:00.000Z","snippet":"s","bodyExcerpt":"b"}}),
    );
}

fn pending(f: &Fixture, actor: Uuid) -> Value {
    f.call(actor, "get", "email.understand", json!({"limit":50}))
}

#[test]
#[ignore = "Only through verify-gate"]
fn pending_mail_carries_the_local_day_own_addresses_and_known_senders() {
    let f = Fixture::new();
    sent_mail(&f, "s1", "Friend <friend@example.test>");
    sent_mail(&f, "s2", "friend@example.test");
    f.cache("e1", "Hello");
    let batch = pending(&f, f.a);
    assert_eq!(batch["today"].as_str().unwrap().len(), 10);
    assert!(batch["ownAddresses"].as_array().unwrap().iter().any(|a| a == "friend@example.test"));
    let m = batch["messages"].as_array().unwrap().iter().find(|m| m["subject"] == "Hello").unwrap();
    assert_eq!(m["receivedDay"], "2026-01-02");
    assert_eq!(m["attempts"], 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_stored_result_leaves_the_pending_list_and_failures_stop_at_five() {
    let f = Fixture::new();
    let id = f.cache("e2", "Result")["id"].as_str().unwrap().to_string();
    let other = f.cache("e3", "Failing")["id"].as_str().unwrap().to_string();
    let has = |b: &Value, id: &str| b["messages"].as_array().unwrap().iter().any(|m| m["id"] == id);
    assert!(has(&pending(&f, f.a), &id));
    f.call(f.a, "set", "email.understand", json!({"action":"result","id":id,"summary":"A summary",
        "signals":{"actionability":{"category":"fyi"},"confidence":0.8}}));
    assert!(!has(&pending(&f, f.a), &id));
    for n in 1..=5 {
        assert!(has(&pending(&f, f.a), &other), "still pending before failure {n}");
        f.call(f.a, "set", "email.understand", json!({"action":"fail","id":other}));
    }
    assert!(!has(&pending(&f, f.a), &other));
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_new_mail_revision_resets_attempts_and_the_judgement_stamp() {
    let f = Fixture::new();
    let put = |history: &str| {
        f.call(f.a, "set", "email.cache-write",
            json!({"action":"insert","connectorAccountId":f.account_a.to_string(),"externalId":"rev",
                   "fields":{"sender":"x@example.test","recipients":[],"subject":"Rev",
                             "receivedAt":"2026-01-02T00:00:00.000Z","externalMetadata":{"historyId":history}}}))
    };
    let id = put("1")["id"].as_str().unwrap().to_string();
    f.call(f.a, "set", "email.understand", json!({"action":"fail","id":id}));
    f.sql(&format!("UPDATE app.email_messages SET judgement_requested_at = now() WHERE id = '{id}'"));
    put("1");
    let row = |col: &str| f.rt.block_on(f.root.query_one(&format!("SELECT {col}::text FROM app.email_messages WHERE id = '{id}'"), &[])).unwrap().get::<_, Option<String>>(0);
    assert_eq!(row("analysis_attempts").as_deref(), Some("1"));
    assert!(row("judgement_requested_at").is_some());
    put("2");
    assert_eq!(row("analysis_attempts").as_deref(), Some("0"));
    assert!(row("judgement_requested_at").is_none());
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_neither_sees_nor_changes_the_mail_being_understood() {
    let f = Fixture::new();
    let id = f.cache("e4", "Private")["id"].as_str().unwrap().to_string();
    assert!(pending(&f, f.b)["messages"].as_array().unwrap().is_empty());
    let out = f.call(f.b, "set", "email.understand", json!({"action":"result","id":id,"summary":"Stolen","signals":{}}));
    assert_eq!(out["changed"], 0);
    let own = pending(&f, f.a);
    assert!(own["messages"].as_array().unwrap().iter().any(|m| m["id"] == id.as_str()));
}

fn signature() -> String {
    "ab".repeat(32)
}

#[test]
#[ignore = "Only through verify-gate"]
fn suppression_counts_dismissals_keeps_evidence_and_resets_only_existing_rows() {
    let f = Fixture::new();
    let sig = signature();
    f.call(f.a, "set", "email.suppression", json!({"action":"reset","signature":sig}));
    assert_eq!(f.call(f.a, "get", "email.suppression", json!({"signatures":[sig]})), json!([]));
    f.call(f.a, "set", "email.suppression", json!({"action":"dismiss","signature":sig}));
    f.call(f.a, "set", "email.suppression", json!({"action":"dismiss","signature":sig}));
    f.call(f.a, "set", "email.suppression", json!({"action":"deadline","signature":sig,"key":"d1"}));
    f.call(f.a, "set", "email.suppression", json!({"action":"context","signature":sig,"key":"c1"}));
    let rows = f.call(f.a, "get", "email.suppression", json!({"signatures":[sig]}));
    assert_eq!(rows[0]["dismissalCount"], 2);
    assert_eq!(rows[0]["deadlineEvidenceKeys"], json!(["d1"]));
    assert_eq!(rows[0]["contextMessageKeys"], json!(["c1"]));
    f.call(f.a, "set", "email.suppression", json!({"action":"reset","signature":sig}));
    let rows = f.call(f.a, "get", "email.suppression", json!({"signatures":[sig]}));
    assert_eq!(rows[0]["dismissalCount"], 0);
    assert_eq!(rows[0]["deadlineEvidenceKeys"], json!([]));
}

#[test]
#[ignore = "Only through verify-gate"]
fn feedback_keeps_a_capped_subject_prefix_and_counts_per_domain() {
    let f = Fixture::new();
    f.call(f.a, "set", "email.triage-feedback", json!({"verdict":"accepted","actionability":"needs_reply",
        "sender":"Ann <ann@Shop.Example>","subject":"s".repeat(300)}));
    f.call(f.a, "set", "email.triage-feedback", json!({"verdict":"rejected","actionability":"needs_reply","sender":"ann@shop.example"}));
    let counts = f.call(f.a, "get", "email.triage-feedback", json!({}));
    assert_eq!(counts, json!([{"domain":"shop.example","accepted":1,"rejected":1}]));
    let len: i32 = f.rt.block_on(f.root.query_one("SELECT max(char_length(subject_prefix)) FROM app.email_triage_feedback", &[])).unwrap().get(0);
    assert_eq!(len, 120);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_sees_none_of_the_suppression_or_feedback_and_the_check_has_teeth() {
    let f = Fixture::new();
    let sig = signature();
    f.call(f.a, "set", "email.suppression", json!({"action":"dismiss","signature":sig}));
    f.call(f.a, "set", "email.triage-feedback", json!({"verdict":"accepted","actionability":"fyi","sender":"a@one.example"}));
    let list = |actor| f.call(actor, "get", "email.suppression", json!({"signatures":[sig]}));
    let counts = |actor| f.call(actor, "get", "email.triage-feedback", json!({}));
    assert_eq!(list(f.b), json!([]));
    assert_eq!(counts(f.b), json!([]));
    f.sql("ALTER TABLE app.email_action_suppression NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.email_action_suppression DISABLE ROW LEVEL SECURITY;
           ALTER TABLE app.email_triage_feedback NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.email_triage_feedback DISABLE ROW LEVEL SECURITY;");
    let leaked = (list(f.b) != json!([])) && (counts(f.b) != json!([]));
    f.sql("ALTER TABLE app.email_action_suppression ENABLE ROW LEVEL SECURITY; ALTER TABLE app.email_action_suppression FORCE ROW LEVEL SECURITY;
           ALTER TABLE app.email_triage_feedback ENABLE ROW LEVEL SECURITY; ALTER TABLE app.email_triage_feedback FORCE ROW LEVEL SECURITY;");
    assert!(leaked, "with the protection removed the second person must see the rows");
}
