//! Private exports and the account export against the installed package and a real database.
//! Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use access_context::AccessContext;
use moss_module_host::{ai::Intelligence, runtime::{CallScope, Request}};
use moss_meetings_host::{recordings::Recordings, section};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use support::install::install_with;

const MARK: &str = "PLANTED-EXPORT-MARKER-9c21";
const K1: &str = "00000000-0000-4000-8000-000000000001";
const K2: &str = "00000000-0000-4000-8000-000000000002";
const K3: &str = "00000000-0000-4000-8000-000000000003";
const K4: &str = "00000000-0000-4000-8000-000000000004";

#[derive(Default)]
struct Script {
    replies: Mutex<Vec<String>>,
}
impl Intelligence for Script {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        let mut replies = self.replies.lock().unwrap();
        anyhow::ensure!(!replies.is_empty(), "The scripted model has no reply left");
        Ok(json!({"text": replies.remove(0)}))
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in this test")
    }
}

struct World {
    f: support::Fixture,
    app: support::install::Installed,
    model: Arc<Script>,
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        let model = Arc::new(Script::default());
        let app = install_with(&f, model.clone());
        Self { f, app, model }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, target: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {target}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// A meeting with one transcript segment and one saved summary whose text carries the marker.
    fn summarised(&self, actor: uuid::Uuid) -> String {
        let made = self.call(actor, "POST", "/records", json!({"requestKey": uuid::Uuid::new_v4(), "title": "Budget"}));
        let id = made["body"]["meeting"]["id"].as_str().unwrap().to_owned();
        let batch = json!({"requestKey": K4, "expectedVersion": 0,
            "sources": [{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],
            "events": [{"cursor":1,"segment":{"meetingId":id,"segmentId":"s1","sourceId":"mic","epoch":1,"startMs":10,"endMs":19,
                "revision":1,"text":"budget review","finality":"final","provenance":"transcription","speakerId":null}}],
            "stopCutoffMs": null});
        assert_eq!(self.call(actor, "POST", &format!("/records/{id}/transcript"), batch)["status"], 201);
        let cite = json!({"kind":"transcript","meetingId":id,"segmentId":"s1","segmentRevision":1,"startCharacter":0,"endCharacter":6});
        let reply = json!({"overview": format!("We reviewed {MARK}."), "decisions": [{"text": "Review the budget", "evidence": [cite]}],
            "openQuestions": [], "actions": [], "warnings": []});
        self.model.replies.lock().unwrap().push(reply.to_string());
        let body = json!({"requestKey": K1, "expectedOutputVersion": 0, "expectedTranscriptRevision": 1,
            "expectedNotesRevision": 0, "templateId": "general", "templateVersion": 1});
        let saved = self.call(actor, "POST", &format!("/records/{id}/outputs"), body);
        assert_eq!(saved["status"], 200, "{saved}");
        id
    }
    fn export(&self, actor: uuid::Uuid, id: &str, key: &str, version: i64) -> Value {
        self.call(actor, "POST", &format!("/records/{id}/exports"), json!({"requestKey": key, "artifactVersion": version}))
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn export_receipts_are_kept_replayed_and_private() {
    let w = World::new();
    let (f, a) = (&w.f, w.f.a);
    let id = w.summarised(a);

    // The test host has no Notes module, so the copy cannot be saved. The receipt says so.
    let first = w.export(a, &id, K2, 1);
    assert_eq!(first["status"], 200, "{first}");
    assert_eq!(first["body"]["receipt"]["writeStatus"], "failed");
    assert_eq!(first["body"]["receipt"]["errorCode"], "meeting_vault_write_failed");
    let again = w.export(a, &id, K2, 1);
    assert_eq!(again["body"], first["body"], "a replay must return the first answer");
    let reused = w.export(a, &id, K2, 2);
    assert_eq!((reused["status"].clone(), reused["body"]["code"].clone()), (json!(409), json!("meeting_export_request_conflict")));
    let missing = w.export(a, &id, K3, 9);
    assert_eq!((missing["status"].clone(), missing["body"]["code"].clone()), (json!(404), json!("meeting_output_unavailable")));
    let listed = w.call(a, "GET", &format!("/records/{id}/exports"), Value::Null);
    assert_eq!(listed["body"]["receipts"].as_array().unwrap().len(), 1, "{listed}");

    // Nobody else can list, create or replay an export for this meeting.
    for actor in [f.b, f.admin] {
        let seen = [
            w.call(actor, "GET", &format!("/records/{id}/exports"), Value::Null),
            w.export(actor, &id, K2, 1),
            w.export(actor, &id, K3, 1),
        ];
        let statuses: Vec<_> = seen.iter().map(|r| r["status"].clone()).collect();
        assert_eq!(statuses, [404, 404, 404], "{seen:?}");
    }
    let (receipts, requests): (i64, i64) = f.rt.block_on(async {
        (
            f.root.query_one("SELECT count(*) FROM app.meeting_export_receipts WHERE meeting_id=$1::text::uuid", &[&id]).await.unwrap().get(0),
            f.root.query_one("SELECT count(*) FROM app.meeting_export_requests WHERE meeting_id=$1::text::uuid", &[&id]).await.unwrap().get(0),
        )
    });
    assert_eq!((receipts, requests), (1, 1), "another person changed the export rows");

    // Without row security another person reads the rows. With it restored they do not.
    let rows_seen_by = |actor: uuid::Uuid, table: &str| -> i64 {
        f.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(&f.db, &f.access(actor)).await.unwrap();
            cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0)
        })
    };
    for table in ["app.meeting_export_receipts", "app.meeting_export_requests"] {
        assert_eq!(rows_seen_by(f.b, table), 0, "{table}: visible before the test removed protection");
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let leaked = rows_seen_by(f.b, table);
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(leaked > 0, "RED expected: {table} shows another person's rows with row security removed");
        println!("RED {table}: another person sees {leaked} row(s) with row security removed");
        assert_eq!(rows_seen_by(f.b, table), 0, "{table}: not restored");
        println!("GREEN {table}: row security restored");
    }

    // The summary text stays out of queued work, activity rows and the stored receipts.
    let (jobs, activity, stored): (i64, i64, i64) = f.rt.block_on(async {
        let count = |t: &str| format!("SELECT CASE WHEN to_regclass('{t}') IS NULL THEN 0 ELSE (SELECT count(*) FROM {t} x WHERE x::text LIKE '%{MARK}%') END");
        let jobs = f.root.query_one(&count("pgboss.job"), &[]).await.unwrap().get(0);
        let act = f.root.query_one(&count("app.moss_activity_detail"), &[]).await.unwrap().get::<_, i64>(0)
            + f.root.query_one(&count("app.moss_model_activity_log"), &[]).await.unwrap().get::<_, i64>(0);
        let stored = f.root.query_one(&count("app.meeting_export_receipts"), &[]).await.unwrap().get::<_, i64>(0)
            + f.root.query_one(&count("app.meeting_export_requests"), &[]).await.unwrap().get::<_, i64>(0);
        (jobs, act, stored)
    });
    assert_eq!((jobs, activity, stored), (0, 0, 0), "summary text reached queued work, activity or export rows");
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

struct Audio {
    _dir: tempfile::TempDir,
    files: std::path::PathBuf,
    recordings: Recordings,
}
impl Audio {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let files = dir.path().join("files");
        let root = vault::Root::create(&files).unwrap();
        let recordings = Recordings::new(&root).unwrap();
        Self { _dir: dir, files, recordings }
    }
    fn put(&self, actor: uuid::Uuid, relative: &str, bytes: &[u8]) {
        let path = self.files.join(format!("meetings/{actor}/vault/{relative}"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

fn collect(f: &support::Fixture, actor: uuid::Uuid, audio: Option<&Recordings>) -> anyhow::Result<Value> {
    let access: AccessContext = f.access(actor);
    f.rt.block_on(async {
        let cx = safety_core::db::DataContext::open(&f.db, &access).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        section::collect(&cx, audio, &access).await
    })
}

#[test]
#[ignore = "Only through verify-gate"]
fn account_export_holds_every_collection_and_the_stored_audio() {
    let w = World::new();
    let (f, a) = (&w.f, w.f.a);
    let id = w.summarised(a);
    w.export(a, &id, K2, 1);
    let audio = Audio::new();
    let (manifest_import, legacy_import, pending_import) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let device = uuid::Uuid::new_v4();
    let chunks: [(&str, i32, Vec<u8>); 3] = [("packets", 0, vec![1, 2, 3, 4]), ("wav", 0, vec![9; 2000]), ("wav", 1, vec![0, 255, 7])];
    let bundle = r#"{"legacy":"bundle","n":1}"#;
    f.rt.block_on(async {
        let insert = "INSERT INTO app.meeting_recording_imports(id,owner_user_id,meeting_id,source_device_id,recording_id,fingerprint,metadata_json,ready,state,source_manifest_json,upload_expires_at) VALUES($1,$2,$3::text::uuid,$4,$5,$6,'{}',$7,'complete',$8::text,CASE WHEN $8::text IS NULL THEN NULL::timestamptz ELSE now() END)";
        let fp = "a".repeat(64);
        f.root.execute(insert, &[&manifest_import, &a, &id, &device, &"r1", &fp, &true, &Some("{\"m\":1}")]).await.unwrap();
        f.root.execute(insert, &[&legacy_import, &a, &id, &device, &"r2", &fp, &true, &None::<&str>]).await.unwrap();
        f.root.execute(insert, &[&pending_import, &a, &id, &device, &"r3", &fp, &false, &None::<&str>]).await.unwrap();
        for (kind, index, bytes) in &chunks {
            f.root
                .execute(
                    "INSERT INTO app.meeting_recording_chunks(import_id,owner_user_id,kind,chunk_index,byte_length,sha256) VALUES($1,$2,$3,$4,$5,$6)",
                    &[&manifest_import, &a, kind, index, &(bytes.len() as i32), &sha(bytes)],
                )
                .await
                .unwrap();
        }
    });
    for (kind, index, bytes) in &chunks {
        audio.put(a, &format!("meeting-recordings/{manifest_import}/{kind}/{index}.bin"), bytes);
    }
    audio.put(a, &format!("meeting-recordings/{legacy_import}/bundle.json"), bundle.as_bytes());

    let section = collect(f, a, Some(&audio.recordings)).unwrap();
    let names: std::collections::BTreeSet<_> = section_names(&section);
    assert_eq!(names.len(), 16, "{names:?}");
    assert_eq!(section["export_receipts"].as_array().unwrap().len(), 1);
    assert_eq!(section["export_requests"].as_array().unwrap().len(), 1);
    assert_eq!(section["output_artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(section["transcript_batches"].as_array().unwrap().len(), 1);
    assert_eq!(section["output_requests"].as_array().unwrap().len(), 1);

    // Audio round trip: chunks come back in order with intact bytes, the legacy bundle as text.
    let imports = section["recording_imports"].as_array().unwrap();
    assert_eq!(imports.len(), 3);
    let by = |id: uuid::Uuid| imports.iter().find(|i| i["id"] == id.to_string()).unwrap();
    let got = by(manifest_import)["chunks"].as_array().unwrap();
    let order: Vec<(String, i64)> = got.iter().map(|c| (c["kind"].as_str().unwrap().to_owned(), c["index"].as_i64().unwrap())).collect();
    assert_eq!(order, [("packets".into(), 0), ("wav".into(), 0), ("wav".into(), 1)]);
    use base64::{engine::general_purpose::STANDARD, Engine};
    for (chunk, (_, _, bytes)) in got.iter().zip(&chunks) {
        let back = STANDARD.decode(chunk["base64"].as_str().unwrap()).unwrap();
        assert_eq!(&back, bytes);
        assert_eq!(chunk["sha256"], sha(bytes));
        assert_eq!(chunk["byteLength"], bytes.len());
    }
    assert!(by(manifest_import).get("bundleJson").is_none());
    assert_eq!(by(legacy_import)["bundleJson"], bundle);
    assert!(by(legacy_import).get("chunks").is_none());
    assert!(by(pending_import).get("chunks").is_none() && by(pending_import).get("bundleJson").is_none());
    // Timestamps read as the old export wrote them, in milliseconds.
    let stamp = by(manifest_import)["createdAt"].as_str().unwrap();
    assert!(stamp.len() == 24 && stamp.ends_with('Z') && stamp.as_bytes()[19] == b'.', "{stamp}");
    assert!(by(manifest_import)["uploadExpiresAt"].is_string());
    assert!(by(legacy_import)["uploadExpiresAt"].is_null());

    // Another person's export holds none of it.
    let theirs = collect(f, f.b, Some(&audio.recordings)).unwrap();
    for name in section_names(&theirs) {
        assert_eq!(theirs[name.as_str()], json!([]), "{name} leaked to another person");
    }

    // A damaged or missing file fails the export instead of dropping the audio.
    audio.put(a, &format!("meeting-recordings/{manifest_import}/wav/1.bin"), &[0, 255, 8]);
    let err = collect(f, a, Some(&audio.recordings)).unwrap_err().to_string();
    assert!(err.contains("hash"), "{err}");
    std::fs::remove_file(audio.files.join(format!("meetings/{a}/vault/meeting-recordings/{manifest_import}/wav/1.bin"))).unwrap();
    assert!(collect(f, a, Some(&audio.recordings)).is_err());
    audio.put(a, &format!("meeting-recordings/{manifest_import}/wav/1.bin"), &chunks[2].2);
    assert!(collect(f, a, None).unwrap_err().to_string().contains("not configured"));
    assert!(collect(f, a, Some(&audio.recordings)).is_ok());
}

fn section_names(section: &Value) -> std::collections::BTreeSet<String> {
    section.as_object().unwrap().keys().cloned().collect()
}
