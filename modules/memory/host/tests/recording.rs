//! Recording memory proofs. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_memory_host::ports::{Embedder, MemoryPorts};
use moss_memory_host::recording::{RecordingAuthority, SourceState};
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const MARKER: &str = "Synthetic zebra-lantern marker 7731";
const CHANGED: &str =
    "This recording's memory has changed or is being removed; refresh its saved state before continuing";

fn unit() -> Vec<f64> {
    (0..768).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}

struct Same;
impl Embedder for Same {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(unit())
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        Ok((unit(), ("stand-in".into(), "1".into())))
    }
}

/// Meetings' answers, changeable by the test.
#[derive(Default)]
struct Meetings {
    sources: Mutex<HashMap<String, SourceState>>,
    cleaning: Mutex<HashMap<String, Option<String>>>,
}
impl Meetings {
    fn set(&self, id: &str, side: &str) {
        self.sources.lock().unwrap().insert(
            id.into(),
            SourceState {
                generation: 1,
                version: 1,
                side: side.into(),
                actor_generation: 1,
            },
        );
    }
}
impl RecordingAuthority for Meetings {
    fn current(&self, _: &str, id: &str) -> Option<SourceState> {
        self.sources.lock().unwrap().get(id).cloned()
    }
    fn cleaning(&self, _: &str, op: &str, source: Option<&str>) -> bool {
        self.cleaning
            .lock()
            .unwrap()
            .get(op)
            .is_some_and(|scope| scope.as_deref() == source)
    }
    fn sealed(&self, _: &str, op: &str) -> bool {
        self.cleaning.lock().unwrap().contains_key(op)
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    a: Uuid,
    b: Uuid,
    meetings: Arc<Meetings>,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Rec A',false),($2,$4,'Rec B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        Self {
            rt,
            root,
            db,
            a,
            b,
            meetings: Arc::new(Meetings::default()),
        }
    }

    fn call(
        &self,
        actor: Uuid,
        authority: Option<Arc<dyn RecordingAuthority>>,
        parameters: Value,
    ) -> Result<Value, (u64, String)> {
        let mut ports =
            MemoryPorts::new(self.db.clone(), Arc::new(Same), Arc::new(DenyPorts)).unwrap();
        if let Some(a) = authority {
            ports = ports.with_authority(a);
        }
        let ports: Arc<dyn Ports> = Arc::new(ports);
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
        let wasm = moss_memory_host::package::component(&core).unwrap();
        let manifest = moss_memory_host::package::manifest().unwrap();
        let payload = json!({"name": "recordingMemory", "parameters": parameters}).to_string();
        let out = Host::new(Limits::default()).unwrap().call(
            &wasm,
            Arc::new(manifest),
            AccessContext::new(actor, "recording-proof"),
            ports,
            "api",
            &payload,
        );
        let answer: Value = serde_json::from_str(&out.expect("the guest finished")).unwrap();
        match answer.get("error") {
            Some(e) => Err((e["statusCode"].as_u64().unwrap(), e["error"].as_str().unwrap().to_owned())),
            None => Ok(answer["ok"].clone()),
        }
    }

    fn as_a(&self, parameters: Value) -> Value {
        let sent = parameters.to_string();
        self.call(self.a, Some(self.meetings.clone()), parameters)
            .unwrap_or_else(|e| panic!("{e:?} for {sent}"))
    }

    fn source(&self, id: &str, key: &str) -> Value {
        json!({"sourceModuleId":"meetings","sourceId":id,"sourceVersion":1,"itemKey":key})
    }

    fn prepare(&self, input: Value) -> Value {
        self.as_a(json!({"action":"prepare","input":input}))["proposal"].clone()
    }

    fn apply(&self, proposal: &Value) -> Value {
        self.as_a(json!({"action":"apply","proposalId":proposal["id"]}))
    }

    fn count(&self, sql: &str, owner: Uuid) -> i64 {
        self.rt
            .block_on(self.root.query_one(sql, &[&owner]))
            .unwrap()
            .get(0)
    }
}

fn request_id() -> String {
    Uuid::new_v4().to_string()
}

#[test]
#[ignore = "Only through verify-gate"]
fn apply_change_undo_restore_and_side_flip_keep_one_fact() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    f.meetings.set(&id, "work");
    let source = f.source(&id, "first");
    let proposed = f.prepare(json!({"kind":"apply","requestId":request_id(),"source":source,"text":"Synthetic exact original idea"}));
    assert!(proposed["before"].is_null());
    let first = f.apply(&proposed);
    assert_eq!(first["status"], "applied");
    assert_eq!(first["receipt"]["state"], "applied");
    assert_eq!(
        first["receipt"]["fact"]["text"],
        "Synthetic exact original idea"
    );
    assert_eq!(f.apply(&proposed)["status"], "unchanged");

    let receipt = &first["receipt"];
    let change = f.prepare(
        json!({"kind":"change","requestId":request_id(),"receiptId":receipt["id"],
        "expectedRevision":receipt["revision"],"expectedFactRevision":receipt["fact"]["revision"],
        "text":"Synthetic owner correction retained byte-exactly"}),
    );
    assert_eq!(change["before"]["text"], "Synthetic exact original idea");
    let changed = f.apply(&change);
    assert_eq!(
        changed["receipt"]["fact"]["text"],
        "Synthetic owner correction retained byte-exactly"
    );
    assert_eq!(changed["receipt"]["fact"]["corrected"], true);
    assert_eq!(
        f.count(&format!("SELECT count(*) FROM app.memory_facts WHERE owner_user_id = $1 AND id = '{}'::uuid AND status = 'superseded'", first["receipt"]["fact"]["id"].as_str().unwrap()), f.a),
        1
    );

    let receipt = &changed["receipt"];
    let undo = f.prepare(
        json!({"kind":"undo","requestId":request_id(),"receiptId":receipt["id"],
        "expectedRevision":receipt["revision"],"expectedFactRevision":receipt["fact"]["revision"]}),
    );
    let undone = f.apply(&undo);
    assert_eq!(undone["receipt"]["state"], "undone");
    assert_eq!(undone["receipt"]["fact"]["status"], "inactive");

    let receipt = &undone["receipt"];
    let restore = f.prepare(
        json!({"kind":"restore","requestId":request_id(),"receiptId":receipt["id"],
        "expectedRevision":receipt["revision"],"expectedFactRevision":receipt["fact"]["revision"]}),
    );
    let restored = f.apply(&restore);
    assert_eq!(
        restored["receipt"]["fact"]["text"],
        "Synthetic owner correction retained byte-exactly"
    );

    f.meetings.set(&id, "personal");
    let receipt = &restored["receipt"];
    let flip = f.prepare(
        json!({"kind":"reconcile_side","requestId":request_id(),"receiptId":receipt["id"],
        "expectedRevision":receipt["revision"],"expectedFactRevision":receipt["fact"]["revision"]}),
    );
    let flipped = f.apply(&flip);
    assert_eq!(flipped["receipt"]["side"], "personal");
    assert_eq!(
        flipped["receipt"]["fact"]["id"],
        restored["receipt"]["fact"]["id"]
    );

    // A stale revision is the old conflict error.
    let stale = f.call(f.a, Some(f.meetings.clone()), json!({"action":"prepare","input":{
        "kind":"undo","requestId":request_id(),"receiptId":receipt["id"],
        "expectedRevision":receipt["revision"],"expectedFactRevision":receipt["fact"]["revision"]}}));
    assert_eq!(
        stale.unwrap_err(),
        (
            409,
            "This recording memory has changed; refresh its current review".to_owned()
        )
    );
}

#[test]
#[ignore = "Only through verify-gate"]
fn without_meetings_connected_every_change_is_refused() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    let refused = f.call(
        f.a,
        None,
        json!({"action":"prepare","input":{"kind":"apply","requestId":request_id(),"source":f.source(&id,"first"),"text":"Synthetic"}}),
    );
    assert_eq!(refused.unwrap_err(), (409, CHANGED.to_owned()));
    assert_eq!(
        f.count(
            "SELECT count(*) FROM app.memory_recording_receipts WHERE owner_user_id = $1",
            f.a
        ),
        0
    );
}

#[test]
#[ignore = "Only through verify-gate"]
fn bad_input_gets_the_old_messages() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    f.meetings.set(&id, "work");
    let long = "x".repeat(2049);
    for text in ["", "   ", long.as_str()] {
        let out = f.call(
            f.a,
            Some(f.meetings.clone()),
            json!({"action":"prepare","input":{
            "kind":"apply","requestId":request_id(),"source":f.source(&id,"k"),"text":text}}),
        );
        assert_eq!(
            out.unwrap_err(),
            (
                400,
                "Recording facts require nonempty text of at most 2048 UTF-8 bytes".to_owned()
            )
        );
    }
    let out = f.call(f.a, Some(f.meetings.clone()), json!({"action":"inspect","source":{"sourceModuleId":"notes","sourceId":id,"sourceVersion":1,"itemKey":"k"}}));
    assert_eq!(
        out.unwrap_err(),
        (404, "This recording memory is unavailable".to_owned())
    );
}

#[test]
#[ignore = "Only through verify-gate"]
fn cleanup_deletes_the_facts_no_recording_supports_and_export_reads_back() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    f.meetings.set(&id, "work");
    let proposal = f.prepare(
        json!({"kind":"apply","requestId":request_id(),"source":f.source(&id,"k"),"text":MARKER}),
    );
    let applied = f.apply(&proposal);
    let fact_id = applied["receipt"]["fact"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let exported = f.as_a(json!({"action":"export"}));
    assert_eq!(exported["receipts"].as_array().unwrap().len(), 1);
    assert_eq!(exported["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(exported["factVersions"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.count(
            "SELECT count(*) FROM app.memory_search_documents WHERE owner_user_id = $1",
            f.a
        ) > 0,
        true
    );

    let op = Uuid::new_v4().to_string();
    // Cleanup is refused until Meetings opens the operation.
    let early = f.call(f.a, Some(f.meetings.clone()), json!({"action":"cleanup","operationId":op,"source":{"sourceModuleId":"meetings","sourceId":id}}));
    assert_eq!(early.unwrap_err().0, 409);
    f.meetings
        .cleaning
        .lock()
        .unwrap()
        .insert(op.clone(), Some(id.to_string()));
    let source = json!({"sourceModuleId":"meetings","sourceId":id});
    // An operation opened for one recording cannot clean another recording or the account.
    let other = Uuid::new_v4().to_string();
    let wrong = f.call(f.a, Some(f.meetings.clone()), json!({"action":"cleanup","operationId":op,"source":{"sourceModuleId":"meetings","sourceId":other}}));
    assert_eq!(wrong.unwrap_err().0, 409);
    let wide = f.call(f.a, Some(f.meetings.clone()), json!({"action":"cleanup","operationId":op}));
    assert_eq!(wide.unwrap_err().0, 409);
    let done = f.as_a(json!({"action":"cleanup","operationId":op,"source":source}));
    assert_eq!(done["status"], "complete");
    assert_eq!(
        f.count(&format!("SELECT count(*) FROM app.memory_facts WHERE owner_user_id = $1 AND id = '{fact_id}'::uuid AND status = 'active'"), f.a),
        0
    );
    f.as_a(json!({"action":"assertComplete","operationId":op,"source":source}));
    f.as_a(json!({"action":"retireSource","operationId":op,"source":source}));
    assert_eq!(
        f.count(
            "SELECT count(*) FROM app.memory_recording_receipts WHERE owner_user_id = $1",
            f.a
        ),
        0
    );
}

fn bare_count(f: &Fixture, actor: Uuid) -> i64 {
    use safety_core::db::DataContext;
    f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &AccessContext::new(actor, "recording-proof"))
            .await
            .unwrap();
        let mut total = 0;
        for t in [
            "memory_recording_receipts",
            "memory_recording_proposals",
            "memory_recording_fact_versions",
        ] {
            total += cx
                .db()
                .query_one(&format!("SELECT count(*) FROM app.{t}"), &[])
                .await
                .unwrap()
                .get::<_, i64>(0);
        }
        cx.commit().await.unwrap();
        total
    })
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_reach_the_first_persons_recording_memory_and_the_check_has_teeth() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    f.meetings.set(&id, "work");
    let source = f.source(&id, "k");
    let proposal =
        f.prepare(json!({"kind":"apply","requestId":request_id(),"source":source,"text":MARKER}));
    f.apply(&proposal);

    let b = |p: Value| f.call(f.b, Some(f.meetings.clone()), p);
    let seen = b(json!({"action":"inspect","source":source})).unwrap();
    assert!(
        seen.is_null() || seen["receipt"].is_null() || seen["id"].is_null(),
        "B saw A's receipt: {seen}"
    );
    let exported = b(json!({"action":"export"})).unwrap();
    assert_eq!(exported["receipts"], json!([]));
    assert_eq!(exported["factVersions"], json!([]));
    assert_eq!(exported["proposals"], json!([]));
    assert!(b(json!({"action":"apply","proposalId":proposal["id"]})).is_err());
    assert_eq!(bare_count(&f, f.b), 0);

    let tables = [
        "memory_recording_receipts",
        "memory_recording_proposals",
        "memory_recording_fact_versions",
    ];
    for t in tables {
        f.rt.block_on(
            f.root
                .batch_execute(&format!("ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
    }
    let leaked = bare_count(&f, f.b);
    for t in tables {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY"))).unwrap();
    }
    assert!(
        leaked > 0,
        "without row security B sees nothing, so the check proves nothing"
    );
    assert_eq!(bare_count(&f, f.b), 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn fact_text_never_reaches_jobs_or_activity_rows() {
    let f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    f.meetings.set(&id, "work");
    let proposal = f.prepare(
        json!({"kind":"apply","requestId":request_id(),"source":f.source(&id,"k"),"text":MARKER}),
    );
    f.apply(&proposal);
    let like = format!("%{MARKER}%");
    for table in [
        "pgboss.job",
        "app.moss_activity_detail",
        "app.moss_model_activity_log",
        "app.admin_audit_events",
        "app.jarvis_action_audit_log",
        "app.task_activity",
    ] {
        let sql = format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE $1");
        let found =
            f.rt.block_on(f.root.query_one(&sql, &[&like]))
                .map(|r| r.get::<_, i64>(0));
        if let Ok(n) = found {
            assert_eq!(n, 0, "{table} holds the fact text");
        }
    }
    // The text is stored where it belongs, so a zero above is not an empty search.
    assert!(
        f.rt.block_on(f.root.query_one(
            "SELECT count(*) FROM app.memory_facts WHERE object_text LIKE $1",
            &[&like]
        ))
        .unwrap()
        .get::<_, i64>(0)
            > 0
    );
}

/// Runs the old TypeScript service against the same database.
fn old_code(args: &[String]) -> Value {
    let out = std::process::Command::new("pnpm")
        .args(["exec", "tsx", "modules/memory/tools/recording-roundtrip.ts"])
        .args(args)
        .current_dir("../../..")
        .env("JARVIS_GATE_RUN", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "old code failed: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    serde_json::from_str(text.lines().last().unwrap()).unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn rows_written_by_the_old_code_read_in_rust_and_the_reverse() {
    let f = Fixture::new();
    let a = f.a.to_string();

    // The old code writes; Rust reads the receipt and the export, and both match what the old code reads.
    let wrote = old_code(&["write".into(), a.clone(), "written by the old code".into()]);
    let ts_source = wrote["sourceId"].as_str().unwrap().to_owned();
    f.meetings.set(&ts_source, "work");
    let seen = f.as_a(json!({"action":"inspect","source":f.source(&ts_source,"shared")}))["receipt"].clone();
    assert_eq!(seen["fact"]["text"], "written by the old code");
    assert_eq!(seen["state"], "applied");
    let old = old_code(&["read".into(), a.clone(), ts_source.clone()]);
    assert_eq!(seen, old["receipt"], "Rust reads the old receipt differently");
    assert_eq!(f.as_a(json!({"action":"export"})), old["exported"], "export differs");

    // Rust writes; the old code reads the receipt and the export, and both match what Rust reads.
    let made = old_code(&["meeting".into(), a.clone()]);
    let source_id = made["sourceId"].as_str().unwrap().to_owned();
    f.meetings.set(&source_id, "work");
    let proposal = f.prepare(json!({"kind":"apply","requestId":request_id(),
        "source":f.source(&source_id,"shared"),"text":"written by rust"}));
    f.apply(&proposal);
    let read = old_code(&["read".into(), a, source_id.clone()]);
    let mine = f.as_a(json!({"action":"inspect","source":f.source(&source_id,"shared")}))["receipt"].clone();
    assert_eq!(read["receipt"], mine, "the old code reads the Rust receipt differently");
    assert_eq!(read["receipt"]["fact"]["text"], "written by rust");
    assert_eq!(read["exported"], f.as_a(json!({"action":"export"})), "export differs");
}
