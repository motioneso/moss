//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{Limits, Host},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-7d2e41";

/// Commitments declares no model port. This stub only satisfies the host's configuration.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Commitments does not call a model")
    }
    fn embed(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Commitments does not embed")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("COMMITMENTS_COMPONENT_WASM")
            .expect("Run modules/commitments/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Reads as the app role with the actor set, so row security applies as it does at run time.
fn rows_as(
    f: &support::Fixture,
    actor: uuid::Uuid,
    sql: &str,
) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) =
            tokio_postgres::connect(&std::env::var("JS48_APP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.execute("SELECT set_config('app.actor_user_id', $1, true)", &[&actor.to_string()]).await.unwrap();
        let rows = tx.query(sql, &[]).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
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
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_commitments_host::package::pack(&root(), &component()).unwrap();
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
            |next| Ok(next),
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "commitments-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(self.f.access(actor), method, &format!("/api/m/commitments{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    }
    /// Saves one suggestion straight into the table, because no create route exists yet.
    fn seed(&self, owner: uuid::Uuid, signature: &str, title: &str, status: &str, resolution: Option<&str>, age_minutes: i32) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        let resolution = resolution.map_or("NULL".to_string(), |r| format!("'{r}'"));
        self.f.rt.block_on(self.f.root.batch_execute(&format!(
            "INSERT INTO app.commitment_candidates(id,owner_user_id,candidate_signature,kind,title,confidence,status,resolution_ref,source_count,last_seen_at)
             VALUES('{id}','{owner}','{signature}','promise','{title}','high','{status}'::app.commitment_candidate_status,{resolution},1,now() - interval '{age_minutes} minutes');
             INSERT INTO app.commitment_candidate_sources(candidate_id,owner_user_id,source_kind,source_ref,evidence_excerpt)
             VALUES('{id}','{owner}','email','ref-{signature}','I will send the report');"
        ))).unwrap();
        id
    }
    fn seed_state(&self, owner: uuid::Uuid, kind: &str) {
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.commitment_extraction_state(owner_user_id,source_kind,last_extracted_at) VALUES($1,$2,now())",
            &[&owner, &kind],
        )).unwrap();
    }
    fn add_user(&self) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Commitments Parity',false)",
            &[&id, &format!("{id}@example.test")],
        )).unwrap();
        id
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn commitments_routes_work_and_a_second_person_is_refused() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let first = w.seed(a, "sig-one", MARK, "pending_review", None, 1);
    let resolved = w.seed(a, "sig-two", "Already resolved", "accepted", Some("task:abc"), 2);
    let driver = w.seed(a, "sig-three", "Not owed", "explicit_non_action", None, 3);

    let list = w.call(a, "GET", "/candidates", json!(null));
    assert_eq!(list["status"], 200, "{list}");
    assert_eq!(list["body"].as_array().unwrap().len(), 3);
    assert_eq!(list["body"][0]["id"], first.to_string(), "newest first");
    let one = w.call(a, "GET", &format!("/candidates/{first}"), json!(null));
    assert_eq!(one["body"]["evidence"].as_array().unwrap().len(), 1, "{one}");
    println!("PASS list and read: three suggestions, one with its saved evidence");

    // The second person sees nothing, through the routes or the database.
    assert_eq!(w.call(b, "GET", "/candidates", json!(null))["body"], json!([]));
    assert_eq!(w.call(b, "GET", &format!("/candidates/{first}"), json!(null))["status"], 404);
    let theirs = w.call(b, "PATCH", &format!("/candidates/{first}/status"), json!({"status":"rejected"}));
    assert_eq!(theirs["status"], 404, "{theirs}");
    assert!(rows_as(&w.f, b, "SELECT id FROM app.commitment_candidates").is_empty());
    assert_eq!(rows_as(&w.f, a, "SELECT id FROM app.commitment_candidates").len(), 3);
    println!("PASS rls: the second person reads and changes no suggestions");

    // With the owner rule removed, the second person can read them. The rule is put back.
    w.f.rt.block_on(w.f.root.execute("DROP POLICY commitment_candidates_app_runtime ON app.commitment_candidates", &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(
        "CREATE POLICY commitment_candidates_app_runtime ON app.commitment_candidates FOR ALL TO jarvis_app_runtime USING (true) WITH CHECK (true)",
        &[],
    )).unwrap();
    let leaked = rows_as(&w.f, b, "SELECT id FROM app.commitment_candidates");
    w.f.rt.block_on(w.f.root.execute("DROP POLICY commitment_candidates_app_runtime ON app.commitment_candidates", &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(
        "CREATE POLICY commitment_candidates_app_runtime ON app.commitment_candidates FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id())",
        &[],
    )).unwrap();
    assert_eq!(leaked.len(), 3, "without the policy the second person must see the suggestions");
    assert!(rows_as(&w.f, b, "SELECT id FROM app.commitment_candidates").is_empty());
    println!("PASS rls: removing the policy lets the second person in, restoring it shuts them out");

    // A resolved suggestion stays resolved through a status change and a suppress.
    let kept = |id: uuid::Uuid| -> Option<String> {
        rows_as(&w.f, a, &format!("SELECT resolution_ref FROM app.commitment_candidates WHERE id = '{id}'"))[0].get(0)
    };
    assert_eq!(kept(resolved).as_deref(), Some("task:abc"));
    let changed = w.call(a, "PATCH", &format!("/candidates/{resolved}/status"), json!({"status":"rejected"}));
    assert_eq!(changed["body"]["hasResolutionRef"], true, "{changed}");
    let suppressed = w.call(a, "POST", &format!("/candidates/{resolved}/suppress"), json!({"suppressedBy":driver.to_string()}));
    assert_eq!(suppressed["body"]["status"], "explicit_non_action", "{suppressed}");
    assert_eq!(suppressed["body"]["hasResolutionRef"], true);
    assert_eq!(kept(resolved).as_deref(), Some("task:abc"));
    assert!(changed["body"].get("resolutionRef").is_none());
    println!("PASS resolved stays resolved: the saved reference survives a status change and a suppress");

    // Resolve is refused as the old route does, and saves nothing.
    let refused = w.call(a, "POST", &format!("/candidates/{first}/resolve"), json!({"resolutionRef":"task:new"}));
    assert_eq!(refused["status"], 503, "{refused}");
    assert_eq!(kept(first), None);

    // The marker reaches no job payload, no activity row and no second-person answer.
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")],
    )).unwrap().get(0);
    assert_eq!(jobs, 0);
    let events: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM app.commitment_candidate_events WHERE detail::text LIKE $1", &[&format!("%{MARK}%")],
    )).unwrap().get(0);
    assert_eq!(events, 0);
    assert!(!w.call(b, "GET", "/candidates", json!(null)).to_string().contains(MARK));
    println!("PASS privacy: the marker is in no job payload, no activity row and no second-person answer");
    let _ = Host::new(Limits::default()).unwrap();
    let _ = AccessContext::new(a, "commitments-proof");
}

/// Fills the {name} markers in a step list with one side's ids.
fn fill(steps: &[Value], vars: &[(&str, uuid::Uuid)]) -> Vec<Value> {
    let mut text = serde_json::to_string(steps).unwrap();
    for (name, id) in vars {
        text = text.replace(&format!("{{{name}}}"), &id.to_string());
    }
    serde_json::from_str(&text).unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn rust_answers_match_the_old_routes_step_for_step() {
    let w = World::new();
    let old_actor = w.add_user();
    let new_actor = w.add_user();
    let seeded = |actor| {
        (
            w.seed(actor, "p-one", "Send the report", "pending_review", None, 1),
            w.seed(actor, "p-two", "Already resolved", "accepted", Some("task:abc"), 2),
            w.seed(actor, "p-three", "Not owed", "explicit_non_action", None, 3),
            w.seed(actor, "p-four", "Snoozed and over", "snoozed", None, 4),
        )
    };
    let (o, n) = (seeded(old_actor), seeded(new_actor));
    for actor in [old_actor, new_actor] {
        w.seed_state(actor, "notes");
    }
    let ids = |x: (uuid::Uuid, uuid::Uuid, uuid::Uuid, uuid::Uuid)| [("a", x.0), ("b", x.1), ("c", x.2), ("d", x.3)];
    let steps: Vec<Value> = vec![
        json!({"method":"GET","url":"/api/commitments/candidates"}),
        json!({"method":"GET","url":"/api/commitments/candidates?status=accepted"}),
        json!({"method":"GET","url":"/api/commitments/candidates?status=bogus"}),
        json!({"method":"GET","url":"/api/commitments/candidates/{a}"}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{a}/status","body":{"status":"snoozed","snoozedUntil":"2099-01-01T00:00:00.000Z"}}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{a}/status","body":{"status":"accepted"}}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{a}/status","body":{"status":"expired"}}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{a}/status","body":{"snoozedUntil":"2099-01-01T00:00:00.000Z"}}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{a}/status","body":{"status":"snoozed","snoozedUntil":"not a date"}}),
        json!({"method":"PATCH","url":"/api/commitments/candidates/{b}/status","body":{"status":"rejected"}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{a}/resolve","body":{"resolutionRef":"task:new"}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{a}/resolve","body":{}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{a}/suppress","body":{"suppressedBy":"{c}"}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{b}/suppress","body":{"suppressedBy":"{a}"}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{b}/suppress","body":{"suppressedBy":"99999999-9999-4999-8999-999999999999"}}),
        json!({"method":"POST","url":"/api/commitments/candidates/{b}/suppress","body":{}}),
        json!({"method":"GET","url":"/api/commitments/candidates/99999999-9999-4999-8999-999999999999"}),
        json!({"method":"GET","url":"/api/commitments/candidates"}),
        json!({"method":"POST","url":"/api/commitments/extract","body":{"sourceKind":"chat"}}),
        json!({"method":"POST","url":"/api/commitments/extract","body":{"sourceKind":"notes"}}),
        json!({"method":"POST","url":"/api/commitments/extract","body":{"sourceKind":"mail"}}),
        json!({"method":"POST","url":"/api/commitments/extract","body":{}}),
        json!({"method":"POST","url":"/api/commitments/extract","body":{"sourceKind":7}}),
        json!({"method":"GET","url":"/api/commitments/extraction-state"}),
    ];
    let old = replay::old_routes(old_actor, &fill(&steps, &ids(o)), &json!({}));
    let mut new = vec![];
    for step in fill(&steps, &ids(n)) {
        let url = step["url"].as_str().unwrap().replace("/api/commitments", "");
        let body = if step.get("body").is_some() { step["body"].clone() } else { json!(null) };
        let answer = w.call(new_actor, step["method"].as_str().unwrap(), &url, body);
        new.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    let (mut old, mut new) = (old, new);
    old.iter_mut().for_each(replay::mask);
    new.iter_mut().for_each(replay::mask);
    assert_eq!(new, old);
    println!("PASS parity: {} steps match the old routes", steps.len());
}

/// Turns the owner rule on a table into "anyone may read", asks the question, then puts it back.
fn leak_check(w: &World, table: &str, policy: &str, roles: &str, who: uuid::Uuid) -> usize {
    let (drop, restore) = (
        format!("DROP POLICY {policy} ON {table}"),
        format!(
            "CREATE POLICY {policy} ON {table} FOR ALL TO {roles} USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id())"
        ),
    );
    let open = format!(
        "CREATE POLICY {policy} ON {table} FOR ALL TO {roles} USING (true) WITH CHECK (true)"
    );
    w.f.rt.block_on(w.f.root.execute(&drop, &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(&open, &[])).unwrap();
    let seen = rows_as(&w.f, who, &format!("SELECT 1 FROM {table}")).len();
    w.f.rt.block_on(w.f.root.execute(&drop, &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(&restore, &[])).unwrap();
    seen
}

#[test]
#[ignore = "Only through verify-gate"]
fn extraction_state_and_judgements_stay_private_and_jobs_carry_ids_only() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    w.seed_state(a, "notes");
    w.f.rt.block_on(w.f.root.execute(
        "INSERT INTO app.commitment_email_thread_judgements(owner_user_id,thread_ref,last_judged_external_id,outcome) VALUES($1,$2,'e1','item')",
        &[&a, &MARK],
    )).unwrap();

    let mine = w.call(a, "GET", "/extraction-state", json!(null));
    assert_eq!(mine["body"].as_array().unwrap().len(), 1, "{mine}");
    assert_eq!(w.call(b, "GET", "/extraction-state", json!(null))["body"], json!([]));
    assert!(rows_as(&w.f, b, "SELECT 1 FROM app.commitment_extraction_state").is_empty());
    assert!(rows_as(&w.f, b, "SELECT 1 FROM app.commitment_email_thread_judgements").is_empty());
    println!("PASS rls: the second person sees no extraction state and no thread judgements");

    // Each protection is removed in turn, the second person gets in, and the protection is put back.
    let state = leak_check(&w, "app.commitment_extraction_state", "commitment_extraction_state_app_runtime", "jarvis_app_runtime", b);
    assert_eq!(state, 1, "without the policy the second person must see the state");
    let judged = leak_check(&w, "app.commitment_email_thread_judgements", "commitment_email_thread_judgements_owner", "jarvis_app_runtime, jarvis_worker_runtime", b);
    assert_eq!(judged, 1, "without the policy the second person must see the judgements");
    assert!(rows_as(&w.f, b, "SELECT 1 FROM app.commitment_extraction_state").is_empty());
    assert!(rows_as(&w.f, b, "SELECT 1 FROM app.commitment_email_thread_judgements").is_empty());
    println!("PASS rls: removing either policy lets the second person in, restoring it shuts them out");

    // The extract request names a source and carries no text, even when text is sent along.
    let queued = w.call(a, "POST", "/extract", json!({"sourceKind":"notes","text":MARK}));
    assert_eq!((queued["status"].as_i64(), &queued["body"]), (Some(202), &json!({"queued":true})), "{queued}");
    let payloads: Vec<String> = w.f.rt.block_on(w.f.root.query(
        "SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%commitments-extraction'", &[],
    )).unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(payloads.len(), 1, "one waiting request: {payloads:?}");
    assert!(payloads[0].contains("notes") && !payloads[0].contains(MARK), "{}", payloads[0]);
    let again = w.call(a, "POST", "/extract", json!({"sourceKind":"notes"}));
    assert_eq!(again["status"], 202);
    let count: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM moss_queue.jobs WHERE queue LIKE '%commitments-extraction'", &[],
    )).unwrap().get(0);
    assert_eq!(count, 1, "asking twice folds into one waiting job");
    let everywhere: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")],
    )).unwrap().get(0);
    assert_eq!(everywhere, 0);
    println!("PASS jobs: the extract job carries the source kind only, and asking twice queues one job");
    let _ = AccessContext::new(a, "commitments-proof");
}

#[test]
#[ignore = "Only through verify-gate"]
fn saved_commitment_renders_the_reusable_review_card() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let w = World::new();
    let id = w.seed(w.f.a, "stored-card", "Stored review <budget> & draft", "pending_review", None, 1);
    for action in ["accept", "reject", "snooze"] {
        let prepared = w.app.installer.call("commitments", w.f.access(w.f.a), "api", &json!({
            "name":"prepareCommitmentAction", "parameters":{"candidateId":id,"action":action,"snoozedUntil":"2026-12-01T00:00:00Z"}
        }).to_string()).unwrap();
        let mut render = Command::new("node")
            .arg(root().join("modules/commitments/tools/render-stored-card.mjs"))
            .args([id.to_string(), action.to_owned()]).stdin(Stdio::piped()).spawn().unwrap();
        render.stdin.take().unwrap().write_all(prepared.as_bytes()).unwrap();
        assert!(render.wait().unwrap().success(), "stored record must render through the packaged card");
    }
    assert_eq!(w.call(w.f.a, "GET", &format!("/candidates/{id}"), json!(null))["body"]["status"], "pending_review");
}
