//! Installed generic tool dispatch into the real Notes guest. The outer WAT
//! probe forwards a tools.run request; it is not chat or an approval screen.
//! Publication, claiming and installed job dispatch use the real durable queue.
//! Embeddings use the parent fixture's named deterministic stub.
use super::*;
use moss_module_host::{
    ai::Intelligence,
    jobs::JobPorts,
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

// Observe successful publication without replacing queue admission or storage.
struct ObserveQueue {
    jobs: Arc<Mutex<Vec<Value>>>,
    next: Arc<dyn Ports>,
}
impl Ports for ObserveQueue {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let result = self.next.invoke(scope, port, request)?;
        if port == "jobs" {
            assert_eq!(request.operation, "enqueue-options");
            assert!(result["id"].is_string(), "Publication must save a real job");
            self.jobs.lock().unwrap().push(request.parameters.clone());
        }
        Ok(result)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

struct CountCalls {
    count: Arc<AtomicUsize>,
    errors: Arc<Mutex<Vec<String>>>,
    next: Arc<dyn Ports>,
}
impl Ports for CountCalls {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        self.count.fetch_add(1, Ordering::SeqCst);
        let result = self.next.invoke(scope, port, request);
        if let Err(error) = &result {
            self.errors
                .lock()
                .unwrap()
                .push(format!("{port}.{}: {error:#}", request.operation));
        }
        result
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

// Observe the trusted service result before Host::call redacts guest errors.
struct RecordServiceErrors {
    errors: Arc<Mutex<Vec<String>>>,
    next: Arc<dyn Ports>,
}
impl Ports for RecordServiceErrors {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let result = self.next.invoke(scope, port, request);
        if let Err(error) = &result {
            self.errors.lock().unwrap().push(format!("{error:#}"));
        }
        result
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
        let jobs = Arc::new(Mutex::new(Vec::new()));
        // Publication always uses the app producer role, even when Notes data
        // execution uses the worker role. Claiming uses worker credentials below.
        let queue = Arc::new(ObserveQueue {
            jobs: jobs.clone(),
            next: Arc::new(
                JobPorts::new(
                    Secret::new(std::env::var("JS55_APP_URL").unwrap()),
                    f.database("app"),
                    f.ingest_ports(db.clone(), Arc::new(Stub)),
                )
                .unwrap(),
            ),
        });
        let ports = f.durable_ports_with_queue(db.clone(), queue);
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
        let backend_errors = Arc::new(Mutex::new(Vec::new()));
        let services = Arc::new(
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                Arc::new(CountCalls {
                    count: backend_calls.clone(),
                    errors: backend_errors.clone(),
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
                    "description":"Experimental Notes routing check", "risk":risk,
                    "approvalVersion":true
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
        let service_errors = Arc::new(Mutex::new(Vec::new()));
        let observed_services = Arc::new(RecordServiceErrors {
            errors: service_errors.clone(),
            next: services.clone(),
        });
        let call = |actor, name: &str, parameters: Value| {
            f.host.call(
                probe.as_bytes(),
                manifest.clone(),
                AccessContext::new(actor, "notes-tool-dispatch"),
                observed_services.clone(),
                "route",
                &json!({"operation":"run","resource":name,"parameters":{"parameters":parameters,"approvalVersion":"caller-forged"}})
                    .to_string(),
            )
        };
        for (name, parameters, text) in [
            (
                "notes.create",
                json!({"path":"note.md","content":"Before edit.","overwrite":true}),
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
            assert_approval_denied(call(owner, name, parameters.clone()), &service_errors);
            // Plain grants cannot bypass the displayed-target requirement, even
            // if the caller adds a forged version to the tools.run envelope.
            services
                .approve_tool(
                    &AccessContext::new(owner, "notes-tool-approval"),
                    "notes",
                    name,
                    &parameters,
                )
                .unwrap();
            assert_approval_denied(call(owner, name, parameters.clone()), &service_errors);
            assert_eq!(backend_calls.load(Ordering::SeqCst), untouched);
            let details: Value = serde_json::from_str(
                &installer
                    .call(
                        "notes",
                        AccessContext::new(owner, "notes-current-approval"),
                        "api",
                        &json!({"name":"prepareNoteAction","parameters":{
                            "tool":name,"inputJson":parameters.to_string()
                        }})
                        .to_string(),
                    )
                    .unwrap(),
            )
            .unwrap();
            let version = details["ok"]["version"].as_str().unwrap();
            services
                .approve_tool_at_version(
                    &AccessContext::new(owner, "notes-stale-approval"),
                    "notes",
                    name,
                    &parameters,
                    version,
                )
                .unwrap();
            // External changes preserve the edit needle, so the old handler
            // would perform the write rather than fail for an unrelated reason.
            std::fs::write(root.join("note.md"), "Before edit. Changed externally.").unwrap();
            assert!(call(owner, name, parameters.clone()).is_err());
            service_errors.lock().unwrap().clear();
            assert!(backend_calls.load(Ordering::SeqCst) > untouched);
            assert_approval_denied(call(owner, name, parameters.clone()), &service_errors);
            assert_eq!(
                std::fs::read_to_string(root.join("note.md")).unwrap(),
                "Before edit. Changed externally."
            );
            assert_eq!(jobs.lock().unwrap().len(), count);
            match &before {
                Some(bytes) => std::fs::write(root.join("note.md"), bytes).unwrap(),
                None => std::fs::remove_file(root.join("note.md")).unwrap(),
            }
            // Relinking to another folder with the same text must also refuse.
            let alternate = root.join("alternate");
            std::fs::create_dir_all(&alternate).unwrap();
            match &before {
                Some(bytes) => std::fs::write(alternate.join("note.md"), bytes).unwrap(),
                None => (),
            }
            services
                .approve_tool_at_version(
                    &AccessContext::new(owner, "notes-relinked-approval"),
                    "notes",
                    name,
                    &parameters,
                    version,
                )
                .unwrap();
            f.source(owner, json!(alternate));
            let before_relink = backend_calls.load(Ordering::SeqCst);
            assert!(call(owner, name, parameters.clone()).is_err());
            service_errors.lock().unwrap().clear();
            assert!(
                backend_calls.load(Ordering::SeqCst) > before_relink,
                "Relink refusal must reach Notes, not fail at approval"
            );
            assert_eq!(std::fs::read(alternate.join("note.md")).ok(), before);
            assert_eq!(jobs.lock().unwrap().len(), count);
            f.source(owner, json!(root));
            std::fs::remove_dir_all(&alternate).unwrap();
            services
                .approve_tool_at_version(
                    &AccessContext::new(owner, "notes-fresh-approval"),
                    "notes",
                    name,
                    &parameters,
                    version,
                )
                .unwrap();
            let untouched = backend_calls.load(Ordering::SeqCst);
            // Neither another account nor changed parameters may spend this grant.
            for actor in [other, f.actors[2]] {
                assert_approval_denied(call(actor, name, parameters.clone()), &service_errors);
            }
            let mut changed = parameters.clone();
            changed["path"] = json!("different.md");
            assert_approval_denied(call(owner, name, changed), &service_errors);
            let different_tool = if name == "notes.delete" {
                "notes.edit"
            } else {
                "notes.delete"
            };
            assert_approval_denied(
                call(owner, different_tool, parameters.clone()),
                &service_errors,
            );
            assert_eq!(
                backend_calls.load(Ordering::SeqCst),
                untouched,
                "Denied approval calls must stop before Notes file/database access"
            );
            assert_eq!(std::fs::read(root.join("note.md")).ok(), before);
            assert!(!root.join("different.md").exists());
            assert_eq!(jobs.lock().unwrap().len(), count);
            let out: Value = serde_json::from_str(
                &call(owner, name, parameters.clone()).unwrap_or_else(|error| {
                    panic!(
                        "Approved {name}: {error:#}; backend errors: {:?}",
                        backend_errors.lock().unwrap()
                    );
                }),
            )
            .unwrap();
            assert_eq!(out, json!({"data":{"path":"note.md","synced":true}}));
            assert!(backend_calls.load(Ordering::SeqCst) > untouched);
            assert_eq!(
                std::fs::read_to_string(root.join("note.md"))
                    .ok()
                    .as_deref(),
                text
            );
            assert_eq!(jobs.lock().unwrap().len(), count + 1);
            let untouched = backend_calls.load(Ordering::SeqCst);
            assert_approval_denied(call(owner, name, parameters), &service_errors);
            assert_eq!(
                backend_calls.load(Ordering::SeqCst),
                untouched,
                "Replay must fail at approval, rather than a Notes conflict"
            );
            assert_eq!(jobs.lock().unwrap().len(), count + 1);
            let params = jobs.lock().unwrap()[count]["params"].clone();
            assert_eq!(params.as_object().unwrap().len(), 1);
            let id: Uuid = serde_json::from_value(params["checkpoint-id"].clone()).unwrap();
            assert_eq!(f.checkpoint_access(&db, owner, id), [1, 1, 1]);
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
                assert_eq!(
                    exposed,
                    vec![[1, 1, 1]; 2],
                    "Checkpoint privacy assertions must fail without RLS"
                );
                for actor in [other, f.actors[2]] {
                    assert_eq!(f.checkpoint_access(&db, actor, id), [0, 0, 0]);
                }
                println!("PASS {role}: new routed-write checkpoint read/update/delete denial fails with RLS removed and passes restored");
            }
            let worker = Secret::new(std::env::var("JS55_WORKER_URL").unwrap());
            let expected_attempts = if name == "notes.create" {
                let indexed = f.snapshot();
                f.rt.block_on(f.bootstrap.execute(
                    "DELETE FROM app.preferences WHERE owner_user_id=$1 AND key='notes-last-sync'",
                    &[&owner],
                ))
                .unwrap();
                assert!(f.status(db.clone(), owner).is_null());
                f.source(owner, Value::Null);
                let failure_started: std::time::SystemTime =
                    f.rt.block_on(f.bootstrap.query_one("SELECT clock_timestamp()", &[]))
                        .unwrap()
                        .get(0);
                assert!(
                    installer.run_job(&worker).is_err(),
                    "Unlinking must refuse saved work rather than retarget it"
                );
                assert_eq!(
                    f.snapshot(),
                    indexed,
                    "Refused delivery must leave the index unchanged"
                );
                assert_eq!(f.status(db.clone(), owner)["lastError"], "notes sync failed (Error)",
                    "The Notes worker must record the source refusal, not fail before guest execution");
                let retry = f.rt.block_on(f.bootstrap.query_one(
                    "SELECT state, attempts, failure_code, run_at >= $3::timestamptz + interval '10 seconds' FROM moss_queue.jobs WHERE actor_user_id=$1 AND idempotency_key=$2",
                    &[&owner, &id, &failure_started],
                )).unwrap();
                assert_eq!(retry.get::<_, String>(0), "pending");
                assert_eq!(retry.get::<_, i32>(1), 1);
                assert_eq!(retry.get::<_, String>(2), "handler");
                assert!(
                    retry.get::<_, bool>(3),
                    "Failure must retain the declared minimum retry delay"
                );
                f.source(owner, json!(root));
                // Advance only this disposable job's due time; no wall-clock sleep
                // or retry loop, and no production timer is claimed.
                f.rt.block_on(f.bootstrap.execute(
                    "UPDATE moss_queue.jobs SET run_at=now()-interval '1 second' WHERE actor_user_id=$1 AND idempotency_key=$2",
                    &[&owner, &id],
                )).unwrap();
                2
            } else {
                1
            };
            assert!(
                installer.run_job(&worker).unwrap(),
                "The installed dispatcher must claim the saved sync"
            );
            assert!(
                !installer.run_job(&worker).unwrap(),
                "No duplicate delivery remains"
            );
            let row = f.rt.block_on(f.bootstrap.query_one(
                "SELECT state, attempts, payload FROM moss_queue.jobs WHERE actor_user_id=$1 AND idempotency_key=$2",
                &[&owner, &id],
            )).unwrap();
            assert_eq!(row.get::<_, String>(0), "completed");
            assert_eq!(row.get::<_, i32>(1), expected_attempts);
            let status = f.status(db.clone(), owner);
            assert_eq!(
                status["errors"], 0,
                "Successful queued sync must report no file errors"
            );
            assert!(status.get("lastError").is_none());
            let payload: Value = row.get(2);
            let module = moss_module_host::jobs::module_key("notes");
            assert_eq!(
                payload,
                json!({
                    "actorUserId":owner, "moduleId":module,
                    "manifestHash":moss_module_host::jobs::manifest_hash(&manifest),
                    "jobKind":format!("{module}.notes.sync"), "params":params
                }),
                "The persisted envelope must contain only trusted metadata and the checkpoint UUID"
            );
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
        println!("PASS {role}: installed tools.run → Notes create/edit/delete → private sync request → durable queue and installed dispatcher → indexed search; account/parameter-bound one-use approvals");
    }
}

fn assert_approval_denied(result: anyhow::Result<String>, errors: &Mutex<Vec<String>>) {
    assert_eq!(
        result.unwrap_err().to_string(),
        "The module could not finish this request"
    );
    let errors = std::mem::take(&mut *errors.lock().unwrap());
    assert_eq!(
        errors.len(),
        1,
        "Expected one trusted service refusal: {errors:?}"
    );
    assert!(
        errors[0].contains("needs the account's approval"),
        "{errors:?}"
    );
}
