//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-4f1c9b";
const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const K3: &str = "33333333-3333-4333-8333-333333333333";

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Meetings has no AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Meetings has no embeddings")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("MEETINGS_COMPONENT_WASM")
            .expect("Run modules/meetings/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_meetings_keep_each_persons_records_notes_and_preferences_private() {
    let f = support::Fixture::new();
    f.rt.block_on(async {
        f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let reg = tempfile::tempdir().unwrap();
    let bytes = moss_meetings_host::package::pack(&root(), &component()).unwrap();
    let database = f.db.clone();
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        move |next| {
            Ok(Arc::new(moss_meetings_host::MeetingsPorts::new(database, next)?)
                as Arc<dyn moss_module_host::runtime::Ports>)
        },
    )
    .unwrap();
    // Meetings requires these modules; the stand-ins do nothing because this test never reaches them.
    for id in ["calendar", "people", "tasks", "notes", "memory"] {
        let (bytes, manifest) = support::install::stand_in(id, &component());
        let (key, publisher, artifact) = registry::publish_as(reg.path(), &bytes, manifest, id);
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().join(id)), &key, &publisher, &format!("{id}-test-registry"))
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    }
    let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
    let source = app
        .installer
        .refresh(
            &f.access(f.a),
            Source::Folder(reg.path().join("meetings")),
            &key,
            &publisher,
            "meetings-test-registry",
        )
        .unwrap();
    app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    let call = |actor, method: &str, path: &str, body: Value| -> Value {
        serde_json::from_str(
            &app.dispatch_extended(
                f.access(actor),
                method,
                &format!("/api/m/meetings{path}"),
                &body.to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    };

    // Create, read, rename and edit notes as person A.
    let made = call(f.a, "POST", "/records", json!({"requestKey":K1,"title":format!("Plan {MARK}")}));
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["meeting"]["id"].as_str().unwrap().to_owned();
    let replay = call(f.a, "POST", "/records", json!({"requestKey":K1,"title":format!("Plan {MARK}")}));
    assert_eq!((replay["status"].as_u64(), &replay["body"]["created"]), (Some(200), &json!(false)));
    let saved = call(f.a, "PUT", &format!("/records/{id}/notes"),
        json!({"requestKey":K1,"expectedRevision":0,"personalNotes":format!("notes {MARK}")}));
    assert_eq!(saved["status"], 200, "{saved}");
    let stale = call(f.a, "PUT", &format!("/records/{id}/notes"),
        json!({"requestKey":K2,"expectedRevision":0,"personalNotes":"later"}));
    assert_eq!(stale["status"], 409);
    assert_eq!(stale["body"]["code"], "meeting_notes_conflict");
    let renamed = call(f.a, "PUT", &format!("/records/{id}/title"),
        json!({"title":"Renamed","expectedTitle":format!("Plan {MARK}")}));
    assert_eq!((renamed["status"].as_u64(), &renamed["body"]["status"]), (Some(200), &json!("saved")), "{renamed}");

    // Person B and an administrator see nothing and change nothing.
    let foreign = |actor| {
        let mut out = vec![];
        out.push(call(actor, "GET", &format!("/records/{id}"), Value::Null)["status"].clone());
        out.push(call(actor, "GET", "/records", Value::Null)["body"]["meetings"].clone());
        out.push(call(actor, "PUT", &format!("/records/{id}/notes"),
            json!({"requestKey":K3,"expectedRevision":1,"personalNotes":"intruder"}))["status"].clone());
        out.push(call(actor, "DELETE", &format!("/records/{id}"), Value::Null)["status"].clone());
        out
    };
    let missing = call(f.b, "DELETE", "/records/99999999-9999-4999-8999-999999999999", Value::Null)["status"].clone();
    for actor in [f.b, f.admin] {
        assert_eq!(foreign(actor), vec![json!(404), json!([]), json!(404), missing.clone()]);
    }
    let still = call(f.a, "GET", &format!("/records/{id}"), Value::Null);
    assert_eq!(still["status"], 200);
    assert!(still["body"]["meeting"]["personalNotes"].as_str().unwrap().contains(MARK));

    // The same assertion must fail with row security removed, then pass once restored.
    let leaks = || call(f.b, "GET", &format!("/records/{id}"), Value::Null)["status"] == 200;
    for table in ["app.meeting_records", "app.meeting_note_writes", "app.preferences"] {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open = match table {
            "app.preferences" => {
                call(f.a, "PUT", "/preferences", json!({"summarizeOnStop":false}));
                call(f.b, "GET", "/preferences", Value::Null)["body"]["summarizeOnStop"] == false
            }
            "app.meeting_note_writes" => {
                let seen: i64 = f.rt.block_on(async {
                    let cx = safety_core::db::DataContext::open(&f.db, &f.access(f.b)).await.unwrap();
                    cx.db().query_one("SELECT count(*) FROM app.meeting_note_writes", &[]).await.unwrap().get(0)
                });
                seen > 0
            }
            _ => leaks(),
        };
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(open, "RED expected: {table} shows another person's data with row security removed");
        println!("RED {table}: another person sees the data with row security removed");
        println!("GREEN {table}: row security restored");
    }
    assert!(!leaks());
    f.rt.block_on(f.root.execute("DELETE FROM app.preferences WHERE key LIKE 'meetings.%'", &[])).unwrap();

    // Preferences are per person.
    let put = call(f.a, "PUT", "/preferences", json!({"summarizeOnStop":false}));
    assert_eq!(put["status"], 200, "{put}");
    assert_eq!(call(f.a, "GET", "/preferences", Value::Null)["body"]["summarizeOnStop"], false);
    assert_eq!(call(f.b, "GET", "/preferences", Value::Null)["body"]["summarizeOnStop"], true);
    let keys: i64 = f.rt.block_on(async {
        f.root.query_one("SELECT count(*) FROM app.preferences WHERE key LIKE 'meetings.%' AND owner_user_id=$1", &[&f.b]).await.unwrap().get(0)
    });
    assert_eq!(keys, 0, "a read or another person's save created preference rows");
}
