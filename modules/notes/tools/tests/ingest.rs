//! Compiled sync guest + real MemoryIngestPorts/CleanupPorts against the
//! legacy ingest oracle. Document embeddings replicate the legacy stub
//! provider byte-for-byte; no real model or managed publication is claimed.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    memory_cleanup::{MemoryCleanupPorts, MemoryCleanupSource},
    memory_ingest::{DocumentEmbeddings, MemoryIngestPorts, MemoryIngestSource},
    runtime::{CallScope, DenyPorts, Host, Limits},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use uuid::Uuid;

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
            .extend(
                ["index.sync-open", "index.sync-file", "index.sync-cleanup"]
                    .map(String::from),
            );
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
            .block_on(
                self.bootstrap
                    .query_one(self.oracle["snapshotSql"].as_str().unwrap(), &[&self.actors]),
            )
            .unwrap()
            .get(0)
    }
    fn source(&self, actor: Uuid, value: Value) {
        self.rt.block_on(self.bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json", &[&actor, &value])).unwrap();
    }
    fn run(&self, db: Database, actor: Uuid) -> Result<String> {
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
                Arc::new(Stub),
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
        self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "notes-ingest-check"),
            ingest,
            "job",
            r#"{"queue":"notes.sync","parameters":{}}"#,
        )
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
        let first: Value = serde_json::from_str(&f.run(db.clone(), actor).unwrap()).unwrap();
        assert_eq!(first["ingested"], 3, "{role}: {first}");
        assert_eq!(first["errors"], 0);
        assert_eq!(
            f.snapshot(),
            f.oracle["expected"],
            "Rust ingestion rows differ from the legacy ingest for role {role}"
        );
        let second: Value = serde_json::from_str(&f.run(db.clone(), actor).unwrap()).unwrap();
        assert_eq!(second["skipped"], 3, "{role}: unchanged files must skip: {second}");
        assert_eq!(f.snapshot(), f.oracle["expected"]);
        // Another owner running the same guest sees none of the first owner's rows.
        let other = f.actors[1];
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
            assert!(rows.is_empty(), "another owner read ingested chunks");
        });
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
