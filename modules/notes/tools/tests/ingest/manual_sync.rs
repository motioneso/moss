//! Signed experimental package routing with real owner preferences/checkpoints.
//! Queue publication and embeddings use the parent fixture's named stand-ins.
use super::*;
use moss_module_host::{
    migrations::PostgresLifecycle, postgres::PostgresCatalog, registry::Source,
    sql::LegacyInventory, store::Installer,
};
use safety_core::secret::Secret;

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn installed_manual_sync_keeps_requests_private_and_resumes_indexing() {
    let f = Fixture::open();
    let owner = f.actors[0];
    let admin = AccessContext::new(f.actors[2], "notes-manual-install");
    for role in ["app", "worker"] {
        // Catalog installation always uses app credentials; execution tests both roles.
        let app = f.database("app");
        let db = f.database(role);
        f.rt.block_on(
            f.bootstrap
                .batch_execute("DELETE FROM moss_modules.catalog"),
        )
        .unwrap();
        f.rt.block_on(f.bootstrap.execute(
            "DELETE FROM app.preferences WHERE key='notes-source-path'",
            &[],
        ))
        .unwrap();
        f.source(owner, f.oracle["root"].clone());
        let (ports, jobs) = f.durable_ports(db.clone(), false);
        let mut manifest = f.durable_manifest();
        manifest.routes.push(
            serde_json::from_value(json!({
                "method":"POST","path":"/notes/sync","signIn":true
            }))
            .unwrap(),
        );
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut files = moss_notes_checks::package_files(&repo, f.wasm.clone()).unwrap();
        files.insert(
            "moss.module.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let data = tempfile::tempdir().unwrap();
        let registry = tempfile::tempdir().unwrap();
        let keys = support::Registry::create(registry.path(), &files);
        let installer = Installer::new(
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
            ports,
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap();
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
        let call = |actor| -> Value {
            serde_json::from_str(
                &installer
                    .dispatch_extended(
                        AccessContext::new(actor, "notes-manual-route"),
                        "POST",
                        "/api/m/notes/notes/sync",
                        &json!({"actorUserId":owner,"sourcePath":f.oracle["root"]}).to_string(),
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        let denied = json!({"status":409,"body":{
            "error":"No notes source configured. Set a path via PUT /api/me/notes-source first."
        }});
        let private = || {
            for outsider in [f.actors[1], f.actors[2]] {
                let before = jobs.lock().unwrap().len();
                assert_eq!(call(outsider), denied);
                assert_eq!(jobs.lock().unwrap().len(), before);
            }
        };
        private();
        // Same privacy assertion must fail without preference RLS. Only this
        // fixture's one source preference remains, avoiding query_opt ambiguity.
        f.rt.block_on(
            f.bootstrap
                .batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        let exposed: Vec<_> = [f.actors[1], f.actors[2]].into_iter().map(call).collect();
        f.rt.block_on(f.bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY")).unwrap();
        for response in exposed {
            assert_eq!(
                response["status"], 202,
                "Removed RLS must expose the source"
            );
            let failed = std::panic::catch_unwind(|| assert_eq!(response, denied));
            assert!(
                failed.is_err(),
                "Privacy assertion did not detect removed RLS"
            );
        }
        private();
        jobs.lock().unwrap().clear();
        let out = call(owner);
        assert_eq!(out["status"], 202);
        let id: Uuid = serde_json::from_value(out["body"]["jobId"].clone()).unwrap();
        assert_eq!(jobs.lock().unwrap().len(), 1);
        let params = jobs.lock().unwrap()[0]["params"].clone();
        assert_eq!(params, json!({"checkpoint-id":id}));
        assert_eq!(f.checkpoint_access(&db, owner, id), [1, 1, 1]);
        for outsider in [f.actors[1], f.actors[2]] {
            assert_eq!(f.checkpoint_access(&db, outsider, id), [0, 0, 0]);
        }
        // The private checkpoint pins the server-read source, while the public
        // job envelope above contains only its ID. Changing the preference must
        // refuse this request rather than silently indexing the new folder.
        let changed = PathBuf::from(f.oracle["parent"].as_str().unwrap())
            .join(format!("manual-changed-{role}"));
        std::fs::create_dir(&changed).unwrap();
        f.source(owner, json!(changed));
        let (retargeted, _) = f.durable_call(
            db.clone(),
            owner,
            "job",
            json!({"queue":"notes.sync","parameters":params}),
            false,
        );
        assert!(
            retargeted.is_err(),
            "Pending request followed the changed folder"
        );
        f.source(owner, f.oracle["root"].clone());
        let (resumed, _) = f.durable_call(
            db,
            owner,
            "job",
            json!({"queue":"notes.sync","parameters":params}),
            false,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&resumed.unwrap()).unwrap()["errors"],
            0
        );
    }
    println!("PASS installed manual-sync route for app/worker, owner/other-owner/admin, preference RLS removal control and real worker resume; queue/embeddings are stand-ins");
}
