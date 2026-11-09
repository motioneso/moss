//! Compiled sync guest + real MemoryIngestPorts/CleanupPorts against the
//! legacy ingest oracle. Document embeddings reproduce the legacy stub
//! provider from the same hash rule, and the gate compares a hash of each
//! saved embedding. No real model or managed publication is claimed.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    context::ContextPorts,
    memory_cleanup::{MemoryCleanupPorts, MemoryCleanupSource},
    memory_ingest::{DocumentEmbeddings, MemoryIngestPorts, MemoryIngestSource},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

struct MutatingStub {
    file: PathBuf,
}
impl DocumentEmbeddings for MutatingStub {
    fn model_name(&self) -> &str {
        "stub"
    }
    fn model_version(&self) -> &str {
        "0"
    }
    fn embed_document(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        if text.contains("Small plain note") {
            std::fs::write(&self.file, "Changed while embedding.\n").unwrap();
        }
        Stub.embed_document(scope, text)
    }
}

struct Stub;
impl DocumentEmbeddings for Stub {
    fn model_name(&self) -> &str {
        "stub"
    }
    fn model_version(&self) -> &str {
        "0"
    }
    fn embed_document(&self, _: &CallScope, text: &str) -> Result<Vec<f64>> {
        let hash = Sha256::digest(text.as_bytes());
        Ok((0..768)
            .map(|i| (hash[i % hash.len()] as f64 / 255.0) * 2.0 - 1.0)
            .collect())
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    bootstrap: tokio_postgres::Client,
    oracle: Value,
    actors: Vec<Uuid>,
    host: Host,
    wasm: Vec<u8>,
    manifest: Arc<moss_module_host::manifest::Manifest>,
}
impl Fixture {
    fn open() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let oracle: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("NOTES_INGEST_ORACLE").unwrap()).unwrap(),
        )
        .unwrap();
        let actors = serde_json::from_value(oracle["actors"].clone()).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let bootstrap = rt.block_on(async {
            let (client, connection) = tokio_postgres::connect(
                &std::env::var("JS55_BOOTSTRAP_URL").unwrap(),
                tokio_postgres::NoTls,
            )
            .await
            .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            client
        });
        let mut manifest = moss_notes_checks::manifest().unwrap();
        manifest
            .capabilities
            .iter_mut()
            .find(|c| c.port == "vault")
            .unwrap()
            .operations
            .extend(["index.sync-open", "index.sync-file", "index.sync-cleanup"].map(String::from));
        manifest.capabilities.extend(serde_json::from_value::<Vec<_>>(json!([
            {"port":"context","operations":["read","uuid"],"resources":["call","new"]},
            {"port":"jobs","operations":["enqueue-after-commit","enqueue-options"],"resources":["notes.sync"]}
        ])).unwrap());
        manifest
            .jobs
            .insert("notes.sync".into(), Default::default());
        Self {
            rt,
            bootstrap,
            oracle,
            actors,
            host: Host::new(Limits::default()).unwrap(),
            wasm: std::fs::read(std::env::var_os("NOTES_TOOL_COMPONENT").unwrap()).unwrap(),
            manifest: Arc::new(manifest),
        }
    }
    fn database(&self, role: &str) -> Database {
        let (url, role) = if role == "app" {
            ("JS55_APP_URL", RuntimeRole::App)
        } else {
            ("JS55_WORKER_URL", RuntimeRole::Worker)
        };
        self.rt
            .block_on(Database::connect(&std::env::var(url).unwrap(), 2, role))
            .unwrap()
    }
    fn snapshot(&self) -> Value {
        self.rt
            .block_on(self.bootstrap.query_one(
                self.oracle["snapshotSql"].as_str().unwrap(),
                &[&self.actors],
            ))
            .unwrap()
            .get(0)
    }
    fn source(&self, actor: Uuid, value: Value) {
        self.rt.block_on(self.bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json", &[&actor, &value])).unwrap();
    }
    fn run(&self, db: Database, actor: Uuid, parameters: Value) -> Result<String> {
        self.run_emb(db, actor, parameters, Arc::new(Stub))
    }
    fn run_emb(
        &self,
        db: Database,
        actor: Uuid,
        parameters: Value,
        embeddings: Arc<dyn DocumentEmbeddings>,
    ) -> Result<String> {
        let ports = self.ingest_ports(db, embeddings);
        self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "notes-ingest-check"),
            ports,
            "job",
            &json!({"queue":"notes.sync","parameters":parameters}).to_string(),
        )
    }
    fn ingest_ports(
        &self,
        db: Database,
        embeddings: Arc<dyn DocumentEmbeddings>,
    ) -> Arc<dyn Ports> {
        let parent = PathBuf::from(self.oracle["parent"].as_str().unwrap());
        let roots: BTreeMap<Uuid, Vec<PathBuf>> = self
            .actors
            .iter()
            .map(|a| (*a, vec![parent.clone()]))
            .collect();
        let cleanup = Arc::new(
            MemoryCleanupPorts::new(
                db.clone(),
                BTreeMap::from([(
                    ("notes".into(), "source".into()),
                    MemoryCleanupSource {
                        source_kind: "notes".into(),
                        preference_key: "notes-source-path".into(),
                        roots: roots.clone(),
                    },
                )]),
                Arc::new(DenyPorts),
            )
            .unwrap(),
        );
        let ingest = Arc::new(
            MemoryIngestPorts::new(
                db,
                embeddings,
                BTreeMap::from([(
                    ("notes".into(), "source".into()),
                    MemoryIngestSource {
                        source_kind: "notes".into(),
                        preference_key: "notes-source-path".into(),
                        roots,
                    },
                )]),
                cleanup,
            )
            .unwrap(),
        );
        ingest
    }
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn compiled_ingest_matches_legacy_and_skips_unchanged() {
    let f = Fixture::open();
    for role in ["app", "worker"] {
        let db = f.database(role);
        let actor = f.actors[0];
        f.source(actor, json!(f.oracle["root"]));
        // The long fixture exceeds one run's chunk budget, so the first run
        // must defer and the continuations must finish the file.
        let mut result: Value =
            serde_json::from_str(&f.run(db.clone(), actor, json!({})).unwrap()).unwrap();
        assert_eq!(result["deferred"], true, "{role}: {result}");
        for _ in 0..6 {
            if result["deferred"] != true {
                break;
            }
            let continuation = result["continuation"].clone();
            result =
                serde_json::from_str(&f.run(db.clone(), actor, continuation).unwrap()).unwrap();
        }
        assert_ne!(
            result["deferred"], true,
            "{role}: continuations did not finish"
        );
        assert_eq!(result["errors"], 0);
        assert_eq!(
            f.snapshot(),
            f.oracle["expected"],
            "Rust ingestion rows differ from the legacy ingest for role {role}"
        );
        let second: Value =
            serde_json::from_str(&f.run(db.clone(), actor, json!({})).unwrap()).unwrap();
        assert_eq!(
            second["skipped"], 5,
            "{role}: unchanged files must skip: {second}"
        );
        assert_eq!(f.snapshot(), f.oracle["expected"]);
        // A managed snapshot key is refused for that file, and the refusal
        // leaves the already indexed file untouched.
        let first_file = f.oracle["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p.as_str().unwrap().ends_with("/a.md"))
            .unwrap()
            .clone();
        let refused: Value = serde_json::from_str(
            &f.run(
                db.clone(),
                actor,
                json!({"filePath": first_file, "chunkOffset": 0, "fileHash": "", "snapshotKey": "managed-key"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(refused["errors"], 1, "{role}: {refused}");
        assert_eq!(f.snapshot(), f.oracle["expected"]);
        // A request naming a different folder fails at open, before any file.
        assert!(f
            .run(db.clone(), actor, json!({"sourcePath": f.oracle["parent"]}),)
            .is_err());
        // A file changed while its chunks are being embedded is refused, and
        // its previously indexed rows stay in place.
        let small = PathBuf::from(f.oracle["root"].as_str().unwrap()).join("c.md");
        let original = std::fs::read(&small).unwrap();
        // An unchanged indexed file skips embedding. Change its bytes first
        // so the mutating embedder actually reaches the write-time recheck.
        std::fs::write(&small, "Small plain note.\nChanged before embedding.\n").unwrap();
        let changed: Value = serde_json::from_str(
            &f.run_emb(
                db.clone(),
                actor,
                json!({"filePath": small.to_string_lossy(), "chunkOffset": 0, "fileHash": ""}),
                Arc::new(MutatingStub {
                    file: small.clone(),
                }),
            )
            .unwrap(),
        )
        .unwrap();
        std::fs::write(&small, original).unwrap();
        assert_eq!(changed["errors"], 1, "{role}: {changed}");
        assert_eq!(f.snapshot(), f.oracle["expected"]);
        // Positive control for the privacy checks below: the owner does read
        // their own ingested chunks through the same direct query.
        f.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(
                &db,
                &AccessContext::new(actor, "notes-ingest-owner"),
            )
            .await
            .unwrap();
            let rows = cx
                .db()
                .query(
                    "SELECT text FROM app.memory_chunks WHERE owner_user_id=$1",
                    &[&actor],
                )
                .await
                .unwrap();
            assert!(!rows.is_empty(), "owner read no ingested chunks");
        });
        // Direct database checks: another owner and an unrelated instance
        // admin each read none of the first owner's chunks.
        for other in [f.actors[1], f.actors[2]] {
            f.rt.block_on(async {
                let cx = safety_core::db::DataContext::open(
                    &db,
                    &AccessContext::new(other, "notes-ingest-privacy"),
                )
                .await
                .unwrap();
                let rows = cx
                    .db()
                    .query(
                        "SELECT text FROM app.memory_chunks WHERE owner_user_id=$1",
                        &[&actor],
                    )
                    .await
                    .unwrap();
                assert!(rows.is_empty(), "another account read ingested chunks");
            });
        }
        // Reset for the next role.
        f.rt.block_on(async {
            for table in ["memory_chunks", "memory_links", "memory_file_index"] {
                f.bootstrap
                    .execute(
                        &format!("DELETE FROM app.{table} WHERE owner_user_id=ANY($1::uuid[])"),
                        &[&f.actors],
                    )
                    .await
                    .unwrap();
            }
        });
    }
    println!("PASS compiled ingestion matches legacy rows for both roles; unchanged files skip; another owner reads no chunks");
}

struct CapturedQueue {
    next: Arc<dyn Ports>,
    jobs: Arc<Mutex<Vec<Value>>>,
    fail: bool,
}
impl Ports for CapturedQueue {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "jobs" {
            moss_module_host::runtime::authorize(scope.module(), port, request)?;
            assert_eq!(request.operation, "enqueue-options");
            assert_eq!(request.resource, "notes.sync");
            let params = request.parameters["params"].as_object().unwrap();
            assert_eq!(params.len(), 1, "Private checkpoint leaked into a job");
            let id: Uuid = serde_json::from_value(params["checkpointId"].clone()).unwrap();
            assert_eq!(request.parameters["idempotencyKey"], json!(id));
            // Real typed queue-schema admission, rather than merely inspecting JSON.
            let specs = moss_module_host::jobs::specs(scope.module());
            assert!(specs[0]
                .params_schema
                .as_ref()
                .unwrap()
                .accepts(&request.parameters["params"]));
            self.jobs.lock().unwrap().push(request.parameters.clone());
            anyhow::ensure!(!self.fail, "Synthetic queue publication refusal");
            return Ok(json!({"id":Uuid::new_v4()}));
        }
        self.next.invoke(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
impl Fixture {
    fn durable_call(
        &self,
        db: Database,
        actor: Uuid,
        kind: &str,
        payload: Value,
        fail: bool,
    ) -> (Result<String>, Vec<Value>) {
        let jobs = Arc::new(Mutex::new(Vec::new()));
        // A fresh port chain for every call proves checkpoints survive worker restart.
        let queue = Arc::new(CapturedQueue {
            next: self.ingest_ports(db.clone(), Arc::new(Stub)),
            jobs: jobs.clone(),
            fail,
        });
        let ports = Arc::new(
            TransactionalDatabasePorts::new(
                db,
                Arc::new(ContextPorts::new(Arc::new(AfterCommitJobs::new(queue)))),
            )
            .unwrap(),
        );
        let mut manifest = (*self.manifest).clone();
        manifest.jobs.insert(
            "notes.sync".into(),
            serde_json::from_value(json!({"checkpointId":{"kind":"id"}})).unwrap(),
        );
        let result = self.host.call(
            &self.wasm,
            Arc::new(manifest),
            AccessContext::new(actor, "durable-notes-sync"),
            ports,
            kind,
            &payload.to_string(),
        );
        let captured = jobs.lock().unwrap().clone();
        (result, captured)
    }
    fn checkpoint_access(&self, db: &Database, actor: Uuid, id: Uuid) -> [u64; 3] {
        self.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(
                db,
                &AccessContext::new(actor, "checkpoint-privacy"),
            )
            .await
            .unwrap();
            cx.db()
                .batch_execute(&format!(
                    "SET LOCAL ROLE {}",
                    moss_module_host::database::runtime_role("notes")
                ))
                .await
                .unwrap();
            let read = cx
                .db()
                .query(
                    "SELECT checkpoint FROM app.notes_sync_checkpoints WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap()
                .len();
            let update = cx
                .db()
                .execute(
                    "UPDATE app.notes_sync_checkpoints SET checkpoint='{}'::jsonb WHERE id=$1",
                    &[&id],
                )
                .await
                .unwrap();
            let delete = cx
                .db()
                .execute("DELETE FROM app.notes_sync_checkpoints WHERE id=$1", &[&id])
                .await
                .unwrap();
            // Roll back the mutation probes, even with RLS removed.
            [read as u64, update, delete]
        })
    }
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn durable_checkpoints_resume_real_ingestion_and_detect_missing_privacy() {
    let f = Fixture::open();
    for role in ["app", "worker"] {
        let db = f.database(role);
        let actor = f.actors[0];
        f.source(actor, f.oracle["root"].clone());
        let (requested, queued) = f.durable_call(
            db.clone(),
            actor,
            "api",
            json!({"name":"requestNotesSync","parameters":{}}),
            false,
        );
        let requested: Value = serde_json::from_str(&requested.unwrap()).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(
            requested["checkpointId"],
            queued[0]["params"]["checkpointId"]
        );
        let mut params = queued[0]["params"].clone();
        let initial: Uuid = serde_json::from_value(requested["checkpointId"].clone()).unwrap();
        let mut deferred = 0;
        for _ in 0..8 {
            for other in [f.actors[1], f.actors[2]] {
                let (denied, jobs) = f.durable_call(
                    db.clone(),
                    other,
                    "job",
                    json!({"queue":"notes.sync","parameters":params}),
                    false,
                );
                assert!(
                    denied.is_err(),
                    "Another account resumed a private checkpoint"
                );
                assert!(jobs.is_empty());
            }
            let (out, jobs) = f.durable_call(
                db.clone(),
                actor,
                "job",
                json!({"queue":"notes.sync","parameters":params}),
                false,
            );
            let out: Value = serde_json::from_str(&out.unwrap()).unwrap();
            assert!(out.get("continuation").is_none());
            assert_eq!(out["errors"], 0);
            if out["deferred"] != true {
                assert!(jobs.is_empty());
                break;
            }
            deferred += 1;
            assert_eq!(jobs.len(), 1);
            params = jobs[0]["params"].clone();
        }
        assert!(deferred > 0, "Long-file continuation was never exercised");
        assert_eq!(
            f.snapshot(),
            f.oracle["expected"],
            "Durable sync differs from legacy rows"
        );
        // Both reads and mutations must fail without the owner; removing RLS
        // must make that exact assertion false, then restoring it must pass.
        for other in [f.actors[1], f.actors[2]] {
            assert_eq!(
                f.checkpoint_access(&db, actor, initial),
                [1, 1, 1],
                "Owner positive control failed"
            );
            assert_eq!(f.checkpoint_access(&db, other, initial), [0, 0, 0]);
            f.rt.block_on(f.bootstrap.batch_execute(
                "ALTER TABLE app.notes_sync_checkpoints DISABLE ROW LEVEL SECURITY",
            ))
            .unwrap();
            let exposed = f.checkpoint_access(&db, other, initial);
            f.rt.block_on(
                f.bootstrap.batch_execute(
                    "ALTER TABLE app.notes_sync_checkpoints ENABLE ROW LEVEL SECURITY",
                ),
            )
            .unwrap();
            assert_eq!(
                exposed,
                [1, 1, 1],
                "Removal control did not expose all three operations"
            );
            assert!(std::panic::catch_unwind(|| assert_eq!(
                exposed,
                [0, 0, 0],
                "checkpoint privacy assertion failed without RLS"
            ))
            .is_err());
            assert_eq!(f.checkpoint_access(&db, other, initial), [0, 0, 0]);
        }
        // Queue publication is a named stand-in. Its failure happens AFTER
        // checkpoint commit, so the captured UUID must still be resumable.
        let (failed, jobs) = f.durable_call(
            db.clone(),
            actor,
            "api",
            json!({"name":"requestNotesSync","parameters":{}}),
            true,
        );
        assert!(failed.is_err());
        assert_eq!(jobs.len(), 1);
        let (retry, _) = f.durable_call(
            db.clone(),
            actor,
            "job",
            json!({"queue":"notes.sync","parameters":jobs[0]["params"]}),
            false,
        );
        let retry: Value = serde_json::from_str(&retry.unwrap()).unwrap();
        assert_eq!(retry["skipped"], 5);
        assert_eq!(f.snapshot(), f.oracle["expected"]);
        f.rt.block_on(async {
            for table in [
                "memory_chunks",
                "memory_links",
                "memory_file_index",
                "notes_sync_checkpoints",
            ] {
                f.bootstrap
                    .execute(
                        &format!("DELETE FROM app.{table} WHERE owner_user_id=ANY($1::uuid[])"),
                        &[&f.actors],
                    )
                    .await
                    .unwrap();
            }
        });
    }
    println!("PASS durable compiled sync: restart between pages, legacy row parity, UUID-only queue requests, post-commit publication failure retry, both runtime roles; owner/admin read-update-delete assertions fail without RLS and pass restored. Embeddings and queue publication are named stand-ins.");
}
