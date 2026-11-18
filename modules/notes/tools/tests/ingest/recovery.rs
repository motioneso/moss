//! Discover unpublished requests without knowing their private checkpoint IDs.
//! Real Wasm + database; publication and document embeddings are named stand-ins.
use super::*;

// The production queue admits RFC4122 UUIDs with a supported version.
fn checkpoint_id(n: u128) -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0000 | n)
}

fn recover(f: &Fixture, db: &Database, actor: Uuid) -> (usize, Vec<Value>) {
    let mut cursor = Value::Null;
    let mut scanned = 0;
    let mut jobs = Vec::new();
    for _ in 0..10 {
        let (out, page_jobs) = f.durable_call(
            db.clone(),
            actor,
            "api",
            json!({"name":"recoverNotesSync","parameters":{"after":cursor}}),
            false,
        );
        let out: Value = serde_json::from_str(&out.unwrap()).unwrap();
        scanned += out["scanned"].as_u64().unwrap() as usize;
        assert_eq!(out["requested"], page_jobs.len());
        assert!(out["scanned"].as_u64().unwrap() <= 25);
        assert_eq!(out.as_object().unwrap().len(), 3);
        jobs.extend(page_jobs);
        cursor = out["nextCursor"].clone();
        if cursor.is_null() {
            return (scanned, jobs);
        }
    }
    panic!("Recovery pagination did not finish")
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn recovery_discovers_orphan_requests_and_detects_missing_privacy() {
    let f = Fixture::open();
    let actor = f.actors[0];
    for role in ["app", "worker"] {
        let db = f.database(role);
        let source = PathBuf::from(f.oracle["parent"].as_str().unwrap())
            .join(format!("recovery-source-{role}"));
        std::fs::create_dir(&source).unwrap();
        f.source(actor, json!(source));
        f.rt.block_on(f.bootstrap.execute(
            "DELETE FROM app.notes_sync_checkpoints WHERE owner_user_id=ANY($1::uuid[])",
            &[&f.actors],
        ))
        .unwrap();
        // Simulate first-request post-commit publication loss, then discard its
        // captured ID. Recovery must discover it from the calling owner's table.
        let (failed, publication) = f.durable_call(
            db.clone(),
            actor,
            "api",
            json!({"name":"requestNotesSync","parameters":{}}),
            true,
        );
        assert!(failed.is_err());
        assert_eq!(publication.len(), 1, "Must fail after checkpoint commit");
        for n in 1..=30 {
            let id = checkpoint_id(n);
            let checkpoint = if n == 30 {
                json!({"filePath":"/private/continuation.md","expectedFileHash":"private"})
            } else {
                json!({"workerResult":{"ingested":1,"skipped":0,"errors":0}})
            };
            f.rt.block_on(f.bootstrap.execute(
                "INSERT INTO app.notes_sync_checkpoints(id,owner_user_id,checkpoint) VALUES($1,$2,$3)",
                &[&id, &actor, &checkpoint],
            )).unwrap();
        }
        // Empty accounts (including an unrelated admin) cannot discover or
        // republish another owner's work. Observe the same assertion fail when
        // checkpoint RLS is removed, then restore and repeat it for both roles.
        for outsider in [f.actors[1], f.actors[2]] {
            assert_eq!(recover(&f, &db, outsider), (0, vec![]));
        }
        f.rt.block_on(
            f.bootstrap
                .batch_execute("ALTER TABLE app.notes_sync_checkpoints DISABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        let exposed: Vec<_> = [f.actors[1], f.actors[2]]
            .into_iter()
            .map(|outsider| recover(&f, &db, outsider))
            .collect();
        f.rt.block_on(f.bootstrap.batch_execute(
            "ALTER TABLE app.notes_sync_checkpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE app.notes_sync_checkpoints FORCE ROW LEVEL SECURITY"
        )).unwrap();
        for (scanned, jobs) in exposed {
            assert_eq!(
                scanned, 31,
                "Disabled RLS must expose private recovery rows"
            );
            assert_eq!(
                jobs.len(),
                2,
                "Disabled RLS must break no-foreign-publication assertion"
            );
        }
        for outsider in [f.actors[1], f.actors[2]] {
            assert_eq!(recover(&f, &db, outsider), (0, vec![]));
        }
        let (scanned, jobs) = recover(&f, &db, actor);
        assert_eq!(scanned, 31);
        assert_eq!(jobs.len(), 2, "Completed pages must never be republished");
        let ids: Vec<_> = jobs
            .iter()
            .map(|job| job["params"]["checkpoint-id"].clone())
            .collect();
        let (_, again) = recover(&f, &db, actor);
        assert_eq!(
            again
                .iter()
                .map(|j| j["params"]["checkpoint-id"].clone())
                .collect::<Vec<_>>(),
            ids
        );
        // The discovered request retains its original source even across lost
        // publication. Unlinking must refuse it, then restoring allows retry.
        f.source(actor, Value::Null);
        let initial = jobs
            .iter()
            .find(|j| j["params"]["checkpoint-id"] != json!(checkpoint_id(30)))
            .unwrap();
        let (unlinked, _) = f.durable_call(
            db.clone(),
            actor,
            "job",
            json!({"queue":"notes.sync","parameters":initial["params"]}),
            false,
        );
        assert!(unlinked.is_err());
        f.source(actor, json!(source));
        let (out, _) = f.durable_call(
            db.clone(),
            actor,
            "job",
            json!({"queue":"notes.sync","parameters":initial["params"]}),
            false,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&out.unwrap()).unwrap(),
            json!({"ingested":0,"skipped":0,"errors":0})
        );
        let (_, remaining) = recover(&f, &db, actor);
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0]["params"]["checkpoint-id"],
            json!(checkpoint_id(30))
        );
    }
    println!("PASS compiled recovery: orphan discovery, bounded cursor pages, stable UUID-only publication, completed-page skip, both runtime roles, other-owner/admin denial, RLS-removal exposure and restored denial; queue and embeddings are stand-ins");
}
