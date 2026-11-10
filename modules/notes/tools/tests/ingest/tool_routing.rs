//! Installed generic tool dispatch into the real Notes guest. The outer WAT
//! probe forwards a tools.run request; it is not chat or an approval screen.
//! Queue delivery is manual and embeddings use the parent fixture's named stub.
use super::*;
use moss_module_host::{
    ai::Intelligence,
    memory_search::{MemorySearchPorts, QueryEmbeddings},
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::Source,
    services::ServicePorts,
    sql::LegacyInventory,
    store::Installer,
};
use safety_core::secret::{Secret, SecretCipher};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountCalls {
    count: Arc<AtomicUsize>,
    next: Arc<dyn Ports>,
}
impl Ports for CountCalls {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        self.count.fetch_add(1, Ordering::SeqCst);
        self.next.invoke(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI in this fixture")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Embeddings use the named test adapter")
    }
}
impl QueryEmbeddings for Stub {
    fn embed_query(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.embed_document(scope, text)
    }
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn installed_tool_dispatch_writes_syncs_and_searches_with_account_approvals() {
    let f = Fixture::open();
    let owner = f.actors[0];
    let other = f.actors[1];
    let admin = AccessContext::new(f.actors[2], "notes-tool-install");
    let probe = include_str!("../../../../../rust-spike/module-host/sample/module.wat")
        .replace("moss:module/kv@", "moss:module/tools@");
    for role in ["app", "worker"] {
        f.rt.block_on(
            f.bootstrap
                .batch_execute("DELETE FROM moss_modules.catalog"),
        )
        .unwrap();
        let db = f.database(role);
        let root = PathBuf::from(f.oracle["parent"].as_str().unwrap())
            .join(format!("tool-routing-{role}"));
        std::fs::create_dir(&root).unwrap();
        // Keep the walk nonempty when the target is deleted, so cleanup runs.
        std::fs::write(root.join("present.md"), "Still present.").unwrap();
        f.source(owner, json!(root));
        for actor in [other, f.actors[2]] {
            f.rt.block_on(f.bootstrap.execute(
                "DELETE FROM app.preferences WHERE owner_user_id=$1 AND key='notes-source-path'",
                &[&actor],
            ))
            .unwrap();
        }
        let (ports, jobs) = f.durable_ports(db.clone(), false);
        let ports = Arc::new(
            MemorySearchPorts::new(
                db.clone(),
                Arc::new(Stub),
                BTreeMap::from([(("notes".into(), "source".into()), "notes".into())]),
                ports,
            )
            .unwrap(),
        );
        let data = tempfile::tempdir().unwrap();
        let backend_calls = Arc::new(AtomicUsize::new(0));
        let services = Arc::new(
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                Arc::new(CountCalls {
                    count: backend_calls.clone(),
                    next: ports,
                }),
            )
            .unwrap(),
        );
        let mut manifest = f.durable_manifest();
        for (name, risk) in [
            ("notes.create", "write"),
            ("notes.edit", "write"),
            ("notes.delete", "destructive"),
        ] {
            manifest.tools.insert(
                name.into(),
                serde_json::from_value(json!({
                    "description":"Experimental Notes routing check", "risk":risk
                }))
                .unwrap(),
            );
        }
        manifest.capabilities.push(
            serde_json::from_value(json!({
                "port":"tools", "operations":["run"],
                "resources":["notes.search","notes.create","notes.edit","notes.delete"]
            }))
            .unwrap(),
        );
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut files = moss_notes_checks::package_files(&repo, f.wasm.clone()).unwrap();
        files.insert(
            "moss.module.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let registry = tempfile::tempdir().unwrap();
        let keys = support::Registry::create(registry.path(), &files);
        // Catalog installation uses app credentials, even for worker execution.
        let app = f.database("app");
        let installer = Arc::new(
            Installer::new(
                data.path(),
                Arc::new(PostgresCatalog::new(app.clone(), admin.clone()).unwrap()),
                Arc::new(
                    PostgresLifecycle::new(
                        Secret::new(std::env::var("JS55_BOOTSTRAP_URL").unwrap()),
                        app,
                        data.path(),
                    )
                    .unwrap(),
                ),
                Host::new(Limits::default()).unwrap(),
                services.clone(),
                "0.1.0".parse().unwrap(),
                LegacyInventory::default(),
            )
            .unwrap(),
        );
        services.bind(&installer);
        let source = installer
            .refresh(
                &admin,
                Source::Folder(registry.path().into()),
                &keys.public,
                &keys.public,
                "notes-test-registry",
            )
            .unwrap();
        installer
            .install(&admin, &source, &keys.artifact, true)
            .unwrap();
        let manifest = Arc::new(manifest);
        // A synthetic dependent caller probes the real installed public API.
        let api_probe = probe.replace("moss:module/tools@", "moss:module/api@");
        let mut caller = (*manifest).clone();
        caller.id = "notes-routing-probe".into();
        caller
            .requires
            .insert("notes".into(), "^0.1".parse().unwrap());
        caller.capabilities = serde_json::from_value(json!([{
            "port":"api", "operations":["call"], "resources":["notes"]
        }]))
        .unwrap();
        let prepare = |actor, caller: &moss_module_host::manifest::Manifest| {
            f.host.call(api_probe.as_bytes(), Arc::new(caller.clone()),
                AccessContext::new(actor, "notes-prepare-dispatch"), services.clone(), "route",
                &json!({"operation":"call","resource":"notes","parameters":{
                    "name":"prepareNoteAction", "parameters":{
                        "tool":"notes.create", "inputJson":r#"{"path":"note.md","content":"Before edit."}"#
                    }
                }}).to_string())
        };
        let prepared: Value = serde_json::from_str(&prepare(owner, &caller).unwrap()).unwrap();
        assert!(prepared["ok"]["version"].is_string());
        assert!(!root.join("note.md").exists());
        assert!(jobs.lock().unwrap().is_empty());
        for actor in [other, f.actors[2]] {
            let result: Value = serde_json::from_str(&prepare(actor, &caller).unwrap()).unwrap();
            assert_eq!(
                result,
                json!({"error":{"statusCode":409,"error":"Notes source is not configured"}})
            );
        }
        let mut undeclared = caller.clone();
        undeclared.requires.clear();
        assert!(prepare(owner, &undeclared).is_err());
        let call = |actor, name: &str, parameters: Value| {
            f.host.call(
                probe.as_bytes(),
                manifest.clone(),
                AccessContext::new(actor, "notes-tool-dispatch"),
                services.clone(),
                "route",
                &json!({"operation":"run","resource":name,"parameters":{"parameters":parameters}})
                    .to_string(),
            )
        };
        for (name, parameters, text) in [
            (
                "notes.create",
                json!({"path":"note.md","content":"Before edit."}),
                Some("Before edit."),
            ),
            (
                "notes.edit",
                json!({"path":"note.md","oldText":"Before","newText":"After"}),
                Some("After edit."),
            ),
            ("notes.delete", json!({"path":"note.md"}), None),
        ] {
            let before = std::fs::read(root.join("note.md")).ok();
            let count = jobs.lock().unwrap().len();
            let untouched = backend_calls.load(Ordering::SeqCst);
            assert!(
                call(owner, name, parameters.clone()).is_err(),
                "Unapproved {name}"
            );
            services
                .approve_tool(
                    &AccessContext::new(owner, "notes-tool-approval"),
                    "notes",
                    name,
                    &parameters,
                )
                .unwrap();
            // Neither another account nor changed parameters may spend this grant.
            for actor in [other, f.actors[2]] {
                assert!(call(actor, name, parameters.clone()).is_err());
            }
            let mut changed = parameters.clone();
            changed["path"] = json!("different.md");
            assert!(call(owner, name, changed).is_err());
            let different_tool = if name == "notes.delete" {
                "notes.edit"
            } else {
                "notes.delete"
            };
            assert!(call(owner, different_tool, parameters.clone()).is_err());
            assert_eq!(
                backend_calls.load(Ordering::SeqCst),
                untouched,
                "Denied approval calls must stop before Notes file/database access"
            );
            assert_eq!(std::fs::read(root.join("note.md")).ok(), before);
            assert!(!root.join("different.md").exists());
            assert_eq!(jobs.lock().unwrap().len(), count);
            let out: Value =
                serde_json::from_str(&call(owner, name, parameters.clone()).unwrap()).unwrap();
            assert_eq!(out, json!({"data":{"path":"note.md","synced":true}}));
            assert_eq!(
                std::fs::read_to_string(root.join("note.md"))
                    .ok()
                    .as_deref(),
                text
            );
            assert_eq!(jobs.lock().unwrap().len(), count + 1);
            let untouched = backend_calls.load(Ordering::SeqCst);
            assert!(
                call(owner, name, parameters).is_err(),
                "Grant replay for {name}"
            );
            assert_eq!(
                backend_calls.load(Ordering::SeqCst),
                untouched,
                "Replay must fail at approval, rather than a Notes conflict"
            );
            assert_eq!(jobs.lock().unwrap().len(), count + 1);
            let params = jobs.lock().unwrap()[count]["params"].clone();
            assert_eq!(params.as_object().unwrap().len(), 1);
            let id: Uuid = serde_json::from_value(params["checkpoint-id"].clone()).unwrap();
            for actor in [other, f.actors[2]] {
                assert_eq!(f.checkpoint_access(&db, actor, id), [0, 0, 0]);
            }
            if name == "notes.create" {
                f.rt.block_on(f.bootstrap.batch_execute(
                    "ALTER TABLE app.notes_sync_checkpoints DISABLE ROW LEVEL SECURITY",
                ))
                .unwrap();
                let exposed: Vec<_> = [other, f.actors[2]]
                    .into_iter()
                    .map(|actor| f.checkpoint_access(&db, actor, id))
                    .collect();
                f.rt.block_on(f.bootstrap.batch_execute(
                    "ALTER TABLE app.notes_sync_checkpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE app.notes_sync_checkpoints FORCE ROW LEVEL SECURITY",
                )).unwrap();
                for actual in exposed {
                    assert!(
                        std::panic::catch_unwind(|| assert_eq!(actual, [0, 0, 0])).is_err(),
                        "Checkpoint privacy assertion must fail without RLS"
                    );
                }
                for actor in [other, f.actors[2]] {
                    assert_eq!(f.checkpoint_access(&db, actor, id), [0, 0, 0]);
                }
                println!("PASS {role}: new routed-write checkpoint read/update/delete denial fails with RLS removed and passes restored");
            }
            // Manual delivery: this is real installed worker execution, not an active queue.
            let out: Value = serde_json::from_str(
                &installer
                    .call(
                        "notes",
                        AccessContext::new(owner, "notes-tool-worker"),
                        "job",
                        &json!({"queue":"notes.sync","parameters":params}).to_string(),
                    )
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(out["errors"], 0);
            for actor in [owner, other, f.actors[2]] {
                services
                    .set_action_policy(
                        &AccessContext::new(actor, "notes-search-policy"),
                        "notes",
                        &BTreeMap::from([("notes.search".into(), false)]),
                    )
                    .unwrap();
                let out: Value = serde_json::from_str(
                    &call(
                        actor,
                        "notes.search",
                        json!({"query":text.unwrap_or("After edit."),"limit":20}),
                    )
                    .unwrap(),
                )
                .unwrap();
                let chunks = out["data"]["chunks"].as_array().unwrap();
                let found = chunks
                    .iter()
                    .find(|c| c["sourcePath"] == json!(root.join("note.md")));
                if actor == owner && text.is_some() {
                    assert_eq!(found.unwrap()["text"], text.unwrap());
                } else {
                    assert!(
                        found.is_none(),
                        "Deleted or another account's note was returned"
                    );
                }
            }
        }
        println!("PASS {role}: installed tools.run → Notes create/edit/delete → private sync request → manually delivered installed worker → indexed search; account/parameter-bound one-use approvals");
    }
}
