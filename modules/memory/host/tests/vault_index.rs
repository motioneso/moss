//! The compiled Memory guest running its index jobs against the real vault index host port,
//! a real database and a counting fake embedding model. Rows written by the TypeScript ingest
//! come from the gate's seed step. Only through scripts/run-gate.sh.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    context::ContextPorts,
    memory_ingest::DocumentEmbeddings,
    memory_vault::MemoryVaultPorts,
    runtime::{CallScope, Host, Limits, Ports, Request},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

/// Embeds with a hash and counts calls, so a test can tell when work was skipped.
struct Counting {
    name: &'static str,
    calls: Arc<AtomicUsize>,
}
impl DocumentEmbeddings for Counting {
    fn model_name(&self) -> &str {
        self.name
    }
    fn model_version(&self) -> &str {
        "0"
    }
    fn embed_document(&self, _: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let hash = Sha256::digest(text.as_bytes());
        Ok((0..768)
            .map(|i| (hash[i % hash.len()] as f64 / 255.0) * 2.0 - 1.0)
            .collect())
    }
}

/// Stands in for the queue. It records every request and never runs a job.
#[derive(Default)]
struct Queue(Mutex<Vec<(String, String, Value)>>);
impl Ports for Queue {
    fn invoke(&self, _: &CallScope, port: &str, r: &Request) -> Result<Value> {
        self.0
            .lock()
            .unwrap()
            .push((port.into(), r.operation.clone(), r.parameters.clone()));
        Ok(json!({"id": Uuid::new_v4(), "deferred": true}))
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    bootstrap: tokio_postgres::Client,
    base: PathBuf,
    actors: Vec<Uuid>,
    legacy_note: String,
    wasm: Vec<u8>,
    manifest: Arc<moss_module_host::manifest::Manifest>,
    host: Host,
}
impl Fixture {
    fn open() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
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
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
        Self {
            rt,
            bootstrap,
            base: PathBuf::from(std::env::var("MEMORY_INDEX_BASE").unwrap()),
            actors: serde_json::from_str(&std::env::var("MEMORY_INDEX_ACTORS").unwrap()).unwrap(),
            legacy_note: std::env::var("MEMORY_INDEX_LEGACY_NOTE").unwrap(),
            wasm: moss_memory_host::package::component(&core).unwrap(),
            manifest: Arc::new(moss_memory_host::package::manifest().unwrap()),
            host: Host::new(Limits::default()).unwrap(),
        }
    }

    /// A new set of ports each time, which is what a restarted server builds.
    fn ports(&self, name: &'static str, calls: &Arc<AtomicUsize>, queue: Arc<Queue>) -> Arc<dyn Ports> {
        let db = self
            .rt
            .block_on(Database::connect(
                &std::env::var("JS55_APP_URL").unwrap(),
                4,
                RuntimeRole::App,
            ))
            .unwrap();
        Arc::new(
            MemoryVaultPorts::new(
                db,
                Arc::new(Counting { name, calls: calls.clone() }),
                ("memory".into(), "vault-index".into()),
                self.base.clone(),
                vec!["notes/generated".into()],
                vec![],
                Arc::new(ContextPorts::new(queue)),
            )
            .unwrap(),
        )
    }

    fn job(&self, actor: Uuid, ports: Arc<dyn Ports>, queue: &str, parameters: Value) -> String {
        self.host
            .call(
                &self.wasm,
                self.manifest.clone(),
                AccessContext::new(actor, "memory-index-check"),
                ports,
                "job",
                &json!({"queue":queue,"parameters":parameters}).to_string(),
            )
            .unwrap()
    }

    /// Runs one whole sweep the way the queue would, page after page.
    fn sweep(&self, actor: Uuid, name: &'static str, calls: &Arc<AtomicUsize>) {
        let queue = Arc::new(Queue::default());
        let ports = self.ports(name, calls, queue);
        let mut offset = 0;
        loop {
            let out: Value = serde_json::from_str(&self.job(
                actor,
                ports.clone(),
                "memory.vault-ingest-sweep",
                json!({"offset":offset}),
            ))
            .unwrap();
            assert_eq!(out["failed"], 0, "{out}");
            if out["more"] != true {
                return;
            }
            offset += 20;
        }
    }

    fn rows(&self, actor: Uuid) -> Vec<(String, String)> {
        self.rt
            .block_on(self.bootstrap.query(
                "SELECT source_path, embed_model_name FROM app.memory_file_index WHERE owner_user_id=$1 AND source_kind='vault' ORDER BY source_path",
                &[&actor],
            ))
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    fn chunk_paths(&self, actor: Uuid) -> Vec<String> {
        self.rt
            .block_on(self.bootstrap.query(
                "SELECT DISTINCT source_path FROM app.memory_chunks WHERE owner_user_id=$1 AND source_kind='vault' ORDER BY 1",
                &[&actor],
            ))
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn write(&self, actor: Uuid, relative: &str, text: &str) {
        let path = self.base.join(actor.to_string()).join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

fn note(id: &str) -> String {
    format!("notes/generated/{id}/v1.md")
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn a_sweep_handles_changed_unchanged_deleted_and_moved_files() {
    let f = Fixture::open();
    let actor = f.actors[1];
    let calls = Arc::new(AtomicUsize::new(0));
    let (a, b, c) = (
        note("aaaaaaaa-0000-4000-8000-000000000001"),
        note("bbbbbbbb-0000-4000-8000-000000000002"),
        note("cccccccc-0000-4000-8000-000000000003"),
    );
    f.write(actor, &a, "# Alpha\n\nAlpha body text.\n");
    f.write(actor, &b, "# Bravo\n\nBravo body text.\n");
    f.write(actor, &c, "# Charlie\n\nCharlie body text.\n");
    // Folders that are never indexed, and a file that is not Markdown.
    f.write(actor, "attachments/x.md", "# Hidden attachment\n");
    f.write(actor, "exports/y.md", "# Hidden export\n");
    f.write(actor, "notes/generated/readme.txt", "not markdown\n");

    f.sweep(actor, "fake-a", &calls);
    let first = calls.load(Ordering::SeqCst);
    assert!(first >= 3, "new files must be embedded");
    let paths: Vec<_> = f.rows(actor).into_iter().map(|r| r.0).collect();
    assert_eq!(paths, [a.clone(), b.clone(), c.clone()]);

    // Unchanged files are not embedded again, even with fresh ports (a restart).
    f.sweep(actor, "fake-a", &calls);
    assert_eq!(calls.load(Ordering::SeqCst), first);

    // Only the changed file is embedded again.
    f.write(actor, &b, "# Bravo\n\nBravo body text, now different.\n");
    f.sweep(actor, "fake-a", &calls);
    assert_eq!(calls.load(Ordering::SeqCst), first + 1);

    // A deleted file loses its rows.
    std::fs::remove_file(f.base.join(actor.to_string()).join(&c)).unwrap();
    f.sweep(actor, "fake-a", &calls);
    assert_eq!(f.chunk_paths(actor), [a.clone(), b.clone()]);
    assert_eq!(f.rows(actor).len(), 2);

    // A moved file is indexed at the new path and dropped from the old one.
    let moved = note("dddddddd-0000-4000-8000-000000000004");
    let from = f.base.join(actor.to_string()).join(&a);
    f.write(actor, &moved, &std::fs::read_to_string(&from).unwrap());
    std::fs::remove_file(from).unwrap();
    f.sweep(actor, "fake-a", &calls);
    let paths: Vec<_> = f.rows(actor).into_iter().map(|r| r.0).collect();
    assert_eq!(paths, [b.clone(), moved.clone()]);
    assert_eq!(f.chunk_paths(actor), [b, moved]);
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn a_new_model_name_re_embeds_once_and_a_restart_does_not() {
    let f = Fixture::open();
    let actor = f.actors[2];
    let calls = Arc::new(AtomicUsize::new(0));
    f.write(actor, &note("eeeeeeee-0000-4000-8000-000000000005"), "# Echo\n\nEcho text.\n");
    f.sweep(actor, "fake-a", &calls);
    f.sweep(actor, "fake-a", &calls);
    let before = calls.load(Ordering::SeqCst);
    f.sweep(actor, "fake-b", &calls);
    assert!(calls.load(Ordering::SeqCst) > before, "a new model name must re-embed");
    assert!(f.rows(actor).iter().all(|r| r.1 == "fake-b"));
    let after = calls.load(Ordering::SeqCst);
    f.sweep(actor, "fake-b", &calls);
    assert_eq!(calls.load(Ordering::SeqCst), after, "a restart must not re-embed");
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn rows_written_by_the_typescript_ingest_are_honoured_and_stay_private() {
    let f = Fixture::open();
    let owner = f.actors[0];
    let calls = Arc::new(AtomicUsize::new(0));
    let before = f.rows(owner);
    assert_eq!(before.len(), 1, "the seed step must have indexed one note");
    assert_eq!(before[0].0, f.legacy_note);
    let ingested = |f: &Fixture| -> String {
        f.rt.block_on(f.bootstrap.query_one(
            "SELECT ingested_at::text FROM app.memory_file_index WHERE owner_user_id=$1 AND source_path=$2",
            &[&owner, &f.legacy_note],
        ))
        .unwrap()
        .get(0)
    };
    let stamp = ingested(&f);
    // The TypeScript stub model is named "stub", version "0".
    f.sweep(owner, "stub", &calls);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "TypeScript rows must be honoured");
    assert_eq!(ingested(&f), stamp);
    assert_eq!(f.rows(owner), before);
    // Another account's index never shows this account's note.
    assert!(f.rows(f.actors[1]).iter().all(|r| r.0 != f.legacy_note));
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn a_tick_registers_one_schedule_and_one_sweep() {
    let f = Fixture::open();
    let queue = Arc::new(Queue::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let ports = f.ports("fake-a", &calls, queue.clone());
    f.job(f.actors[1], ports.clone(), "memory.vault-ingest-tick", json!({}));
    f.job(f.actors[1], ports, "memory.vault-ingest-tick", json!({}));
    let seen = queue.0.lock().unwrap();
    let schedules: Vec<_> = seen.iter().filter(|c| c.1 == "schedule").collect();
    assert_eq!(schedules.len(), 2);
    assert!(schedules.iter().all(|c| c.2["key"] == "memory-vault-ingest" && c.2["cron"] == "*/15 * * * *"));
}
