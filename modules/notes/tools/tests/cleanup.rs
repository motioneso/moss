//! Real legacy SQL oracle and real Wasm cleanup. Per-file ingestion is a named
//! skipped-file stand-in; filesystem walks and cleanup persistence are real.
use access_context::AccessContext;
use anyhow::{bail, Result};
use moss_module_host::{
    memory_cleanup::{MemoryCleanupPorts, MemoryCleanupSource},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use uuid::Uuid;

struct IngestionStandIn {
    next: Arc<dyn Ports>,
    source: String,
    files: Vec<String>,
    override_cleanup: Option<Value>,
}
impl Ports for IngestionStandIn {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        moss_module_host::runtime::authorize(scope.module(), port, r)?;
        match r.operation.as_str() {
            "index.sync-open" => Ok(
                json!({"sourcePath":self.source,"resolvedSourcePath":self.source,"files":self.files}),
            ),
            "index.sync-file" => Ok(json!({"status":"skipped","chunksProcessed":0})),
            "index.sync-cleanup" => {
                let request = Request {
                    operation: r.operation.clone(),
                    resource: r.resource.clone(),
                    parameters: self
                        .override_cleanup
                        .clone()
                        .unwrap_or_else(|| r.parameters.clone()),
                };
                self.next.invoke(scope, port, &request)
            }
            _ => bail!("Unexpected core operation"),
        }
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
            &std::fs::read(std::env::var_os("NOTES_CLEANUP_ORACLE").unwrap()).unwrap(),
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
        let mut manifest = moss_notes_checks::read_only_manifest().unwrap();
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
    fn reset(&self) {
        self.rt.block_on(async {
            for table in ["memory_chunks", "memory_links", "memory_file_index"] {
                self.bootstrap.execute(&format!("DELETE FROM app.{table} WHERE owner_user_id=ANY($1::uuid[])"), &[&self.actors]).await.unwrap();
            }
            self.bootstrap.execute("INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,text,line_start,line_end,content_hash,embed_model_name,embed_model_version) SELECT owner,kind,path,text,0,0,'fixture','fixture','0' FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,kind text,path text,text text)", &[&self.oracle["chunks"]]).await.unwrap();
            self.bootstrap.execute("INSERT INTO app.memory_links(owner_user_id,from_path,to_path) SELECT owner,\"from\",\"to\" FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,\"from\" text,\"to\" text)", &[&self.oracle["links"]]).await.unwrap();
            self.bootstrap.execute("INSERT INTO app.memory_file_index(owner_user_id,source_kind,source_path,file_hash,chunk_count,embed_model_name,embed_model_version) SELECT owner,kind,path,hash,1,'fixture','0' FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,kind text,path text,hash text)", &[&self.oracle["index"]]).await.unwrap();
        });
    }
    fn sql(&self, sql: &str) {
        self.rt.block_on(self.bootstrap.batch_execute(sql)).unwrap();
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
    fn cleanup(
        &self,
        db: Database,
        actor: Uuid,
        source: &str,
        files: Vec<String>,
        override_cleanup: Option<Value>,
        roots: bool,
    ) -> Result<String> {
        let source_config = MemoryCleanupSource {
            source_kind: "notes".into(),
            preference_key: "notes-source-path".into(),
            roots: if roots {
                self.actors
                    .iter()
                    .map(|a| {
                        (
                            *a,
                            vec![PathBuf::from(self.oracle["root"].as_str().unwrap())
                                .parent()
                                .unwrap()
                                .into()],
                        )
                    })
                    .collect()
            } else {
                BTreeMap::new()
            },
        };
        let adapter = Arc::new(
            MemoryCleanupPorts::new(
                db,
                BTreeMap::from([(("notes".into(), "source".into()), source_config)]),
                Arc::new(DenyPorts),
            )
            .unwrap(),
        );
        self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "notes-cleanup-check"),
            Arc::new(IngestionStandIn {
                next: adapter,
                source: source.into(),
                files,
                override_cleanup,
            }),
            "job",
            r#"{"queue":"notes.sync","parameters":{}}"#,
        )
    }
    fn walked(&self) -> Vec<String> {
        serde_json::from_value(self.oracle["walked"].clone()).unwrap()
    }
    fn root(&self) -> &str {
        self.oracle["root"].as_str().unwrap()
    }
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn compiled_cleanup_matches_legacy_and_rolls_back_the_whole_sweep() {
    let f = Fixture::open();
    for case in f.oracle["cases"].as_array().unwrap() {
        f.reset();
        let actor: Uuid = case["actor"].as_str().unwrap().parse().unwrap();
        let source = case["source"].as_str().unwrap();
        f.source(actor, json!(source));
        f.cleanup(
            f.database(case["role"].as_str().unwrap()),
            actor,
            source,
            serde_json::from_value(case["files"].clone()).unwrap(),
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            f.snapshot(),
            case["expected"],
            "Legacy cleanup row mismatch: {case}"
        );
    }
    for role in ["app", "worker"] {
        let db = f.database(role);
        let actor = f.actors[0];
        f.reset();
        f.source(actor, json!(f.root()));
        // Failure at the final table must restore already deleted chunks/links and
        // every selected file, rather than leaving a partially completed sweep.
        f.sql("CREATE FUNCTION app.js92_refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late cleanup refusal'; END $$; CREATE TRIGGER js92_cleanup_refusal BEFORE DELETE ON app.memory_file_index FOR EACH ROW EXECUTE FUNCTION app.js92_refuse_cleanup()");
        let result = f.cleanup(db.clone(), actor, f.root(), f.walked(), None, true);
        f.sql("DROP TRIGGER js92_cleanup_refusal ON app.memory_file_index; DROP FUNCTION app.js92_refuse_cleanup()");
        assert!(result.is_err());
        assert_eq!(
            f.snapshot(),
            f.oracle["baseline"],
            "Cleanup did not roll back the entire sweep"
        );
        for invalid in [
            json!({"sourcePath":f.root(),"walkedPaths":[],"actorUserId":f.actors[1]}),
            json!({"sourcePath":f.root(),"walkedPaths":["/outside.md"]}),
            json!({"sourcePath":format!("{}-other",f.root()),"walkedPaths":[]}),
        ] {
            assert!(f
                .cleanup(db.clone(), actor, f.root(), f.walked(), Some(invalid), true)
                .is_err());
            assert_eq!(f.snapshot(), f.oracle["baseline"]);
        }
        f.source(actor, Value::Null);
        assert!(f
            .cleanup(db.clone(), actor, f.root(), f.walked(), None, true)
            .is_err());
        f.source(actor, json!(f.oracle["empty"]));
        assert!(f
            .cleanup(db.clone(), actor, f.root(), f.walked(), None, true)
            .is_err());
        let empty = f.oracle["empty"].as_str().unwrap();
        f.source(actor, json!(empty));
        f.cleanup(
            db.clone(),
            actor,
            empty,
            vec![format!("{empty}/gone.md")],
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            f.snapshot(),
            f.oracle["baseline"],
            "An empty host walk must retain the index"
        );
        f.source(actor, json!(f.root()));
        assert!(f
            .cleanup(db.clone(), actor, f.root(), f.walked(), None, false)
            .is_err());
        assert_eq!(f.snapshot(), f.oracle["baseline"]);
        // An omitted original walk must still preserve currently present files.
        f.cleanup(
            db,
            actor,
            f.root(),
            f.walked(),
            Some(json!({"sourcePath":f.root(),"walkedPaths":[]})),
            true,
        )
        .unwrap();
        let rows = f.snapshot();
        assert!(rows["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row[0] == actor.to_string()
                && row[1] == "notes"
                && row[2] == format!("{}/keep.md", f.root())));
    }
    println!("PASS 12 real legacy/compiled cleanup row comparisons; both roles; real walk; unlink/root/input admission; late-delete rollback");
}

fn privacy_probe(
    f: &Fixture,
    db: &Database,
    actor: Uuid,
    owner: Uuid,
    table: &str,
) -> (usize, u64) {
    f.rt.block_on(async {
        let cx = DataContext::open(db, &AccessContext::new(actor, "notes-cleanup-privacy"))
            .await
            .unwrap();
        let read = cx
            .db()
            .query(
                &format!("SELECT owner_user_id FROM app.{table} WHERE owner_user_id=$1"),
                &[&owner],
            )
            .await
            .unwrap()
            .len();
        let deleted = cx
            .db()
            .execute(
                &format!("DELETE FROM app.{table} WHERE owner_user_id=$1"),
                &[&owner],
            )
            .await
            .unwrap();
        (read, deleted) // Drop rolls back the negative-control deletions.
    })
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn cleanup_privacy_detects_removed_rls_and_owner_predicates() {
    let f = Fixture::open();
    for role in ["app", "worker"] {
        let db = f.database(role);
        f.reset();
        for table in ["memory_chunks", "memory_links", "memory_file_index"] {
            for actor in [f.actors[1], f.actors[2]] {
                assert_eq!(privacy_probe(&f, &db, actor, f.actors[0], table), (0, 0));
            }
            f.sql(&format!(
                "ALTER TABLE app.{table} DISABLE ROW LEVEL SECURITY"
            ));
            let exposed: Vec<_> = [f.actors[1], f.actors[2]]
                .iter()
                .map(|actor| privacy_probe(&f, &db, *actor, f.actors[0], table))
                .collect();
            f.sql(&format!("ALTER TABLE app.{table} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{table} FORCE ROW LEVEL SECURITY"));
            assert!(
                exposed
                    .iter()
                    .all(|(read, deleted)| *read > 0 && *deleted > 0),
                "Privacy assertion did not detect removed RLS"
            );
            for actor in [f.actors[1], f.actors[2]] {
                assert_eq!(privacy_probe(&f, &db, actor, f.actors[0], table), (0, 0));
            }
        }
        f.source(f.actors[0], json!(f.root()));
        for table in ["memory_chunks", "memory_links", "memory_file_index"] {
            f.sql(&format!(
                "ALTER TABLE app.{table} DISABLE ROW LEVEL SECURITY"
            ));
        }
        let outcome = f.cleanup(db, f.actors[0], f.root(), f.walked(), None, true);
        let after = f.snapshot();
        for table in ["memory_chunks", "memory_links", "memory_file_index"] {
            f.sql(&format!("ALTER TABLE app.{table} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{table} FORCE ROW LEVEL SECURITY"));
        }
        outcome.unwrap();
        for key in ["chunks", "links", "index"] {
            let others = |value: &Value| {
                value[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|row| row[0] != f.actors[0].to_string())
                    .cloned()
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                others(&after),
                others(&f.oracle["baseline"]),
                "cleanup owner predicate failed under removed RLS"
            );
        }
    }
    println!("PASS both roles: unrelated owner/admin read/delete assertions fail with each memory RLS removed, pass restored; compiled cleanup protects other accounts even with memory RLS removed");
}
