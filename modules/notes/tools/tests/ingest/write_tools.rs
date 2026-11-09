//! Experimental writes + durable worker, using real linked files and PostgreSQL.
//! Queue delivery and embeddings retain the parent fixture's named stand-ins.
use super::*;
use moss_module_host::linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders};
use vault::AllowedRoots;

pub(super) fn write_ports(f: &Fixture, db: Database, next: Arc<dyn Ports>) -> Arc<dyn Ports> {
    let parent = PathBuf::from(f.oracle["parent"].as_str().unwrap());
    let roots: BTreeMap<_, _> = f
        .actors
        .iter()
        .map(|actor| (*actor, vec![parent.clone()]))
        .collect();
    let files = Arc::new(LinkedNotesPorts::new(
        Arc::new(
            PreferenceFolders::new(
                db.clone(),
                BTreeMap::from([(
                    ("notes".into(), "source".into()),
                    PreferenceFolder {
                        preference: "notes-source-path".into(),
                        relative_to: None,
                    },
                )]),
                roots
                    .iter()
                    .map(|(actor, paths)| {
                        (
                            *actor,
                            AllowedRoots::for_account(
                                &AccessContext::new(*actor, "notes-write-roots"),
                                paths.clone(),
                            ),
                        )
                    })
                    .collect(),
            )
            .unwrap(),
        ),
        next,
    ));
    Arc::new(
        FolderSettingsPorts::new(
            db,
            BTreeMap::from([(
                ("notes".into(), "source".into()),
                FolderSetting {
                    path_key: "notes-source-path".into(),
                    status_key: "notes-last-sync".into(),
                    roots,
                },
            )]),
            files,
        )
        .unwrap(),
    )
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn writes_queue_private_checkpoints_and_resume_real_indexing() {
    let f = Fixture::open();
    let actor = f.actors[0];
    let other = f.actors[1];
    let parent = PathBuf::from(f.oracle["parent"].as_str().unwrap());
    for role in ["app", "worker"] {
        let db = f.database(role);
        let root = parent.join(format!("writes-{role}"));
        std::fs::create_dir(&root).unwrap();
        f.source(actor, json!(root));
        // Empty walks deliberately retain the index (for example if a linked
        // mount disappears). Keep one note present so delete tests the real
        // missing-file sweep rather than contradicting that safety rule.
        std::fs::write(root.join("present.md"), "Still present.").unwrap();
        // A different account has its own folder; its identical relative path
        // must never resolve to the first owner's note.
        let foreign = parent.join(format!("foreign-{role}"));
        std::fs::create_dir(&foreign).unwrap();
        f.source(other, json!(foreign));
        for (tool, input, expected) in [
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
            let (out, jobs) = f.durable_call(
                db.clone(),
                actor,
                "tool",
                json!({"tool":tool,"parameters":input}),
                false,
            );
            assert_eq!(
                serde_json::from_str::<Value>(&out.unwrap()).unwrap(),
                json!({"data":{"path":"note.md","synced":true}})
            );
            assert_eq!(
                std::fs::read_to_string(root.join("note.md"))
                    .ok()
                    .as_deref(),
                expected
            );
            assert_eq!(jobs.len(), 1);
            let params = jobs[0]["params"].clone();
            let id: Uuid = serde_json::from_value(params["checkpoint-id"].clone()).unwrap();
            assert_eq!(f.checkpoint_access(&db, actor, id), [1, 1, 1]);
            if tool == "notes.create" {
                f.rt.block_on(f.bootstrap.batch_execute(
                    "ALTER TABLE app.notes_sync_checkpoints DISABLE ROW LEVEL SECURITY",
                ))
                .unwrap();
                let exposed: Vec<_> = [other, f.actors[2]]
                    .into_iter()
                    .map(|outsider| f.checkpoint_access(&db, outsider, id))
                    .collect();
                f.rt.block_on(f.bootstrap.batch_execute("ALTER TABLE app.notes_sync_checkpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE app.notes_sync_checkpoints FORCE ROW LEVEL SECURITY")).unwrap();
                assert_eq!(
                    exposed,
                    vec![[1, 1, 1]; 2],
                    "Privacy assertions must fail with RLS removed"
                );
            }
            for outsider in [other, f.actors[2]] {
                assert_eq!(f.checkpoint_access(&db, outsider, id), [0, 0, 0]);
                let (denied, queued) = f.durable_call(
                    db.clone(),
                    outsider,
                    "job",
                    json!({"queue":"notes.sync","parameters":params}),
                    false,
                );
                assert!(denied.is_err());
                assert!(queued.is_empty());
            }
            let (resumed, _) = f.durable_call(
                db.clone(),
                actor,
                "job",
                json!({"queue":"notes.sync","parameters":params}),
                false,
            );
            let result: Value = serde_json::from_str(&resumed.unwrap()).unwrap();
            assert_eq!(result["errors"], 0);
            assert_ne!(result["deferred"], true);
            f.rt.block_on(async {
                let rows = f.bootstrap.query("SELECT text FROM app.memory_chunks WHERE owner_user_id=$1 AND source_path=$2", &[&actor, &root.join("note.md").to_string_lossy().as_ref()]).await.unwrap();
                match expected {
                    Some(text) => assert!(rows.iter().any(|r| r.get::<_, String>(0).contains(text))),
                    None => assert!(rows.is_empty(), "Deleted note remained indexed"),
                }
            });
        }
        // A real database INSERT refusal occurs after file mutation but before
        // outer finalization. Both new files and existing edits/deletes compensate.
        std::fs::write(root.join("keep.md"), "Keep this note.").unwrap();
        f.rt.block_on(f.bootstrap.batch_execute("CREATE FUNCTION app.reject_notes_write_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic checkpoint refusal'; END $$; CREATE TRIGGER reject_notes_write_checkpoint BEFORE INSERT ON app.notes_sync_checkpoints FOR EACH ROW EXECUTE FUNCTION app.reject_notes_write_checkpoint()" )).unwrap();
        for (tool, parameters) in [
            (
                "notes.create",
                json!({"path":"refused.md","content":"Refuse this note."}),
            ),
            (
                "notes.create",
                json!({"path":"keep.md","content":"Replace this note.","overwrite":true}),
            ),
            (
                "notes.edit",
                json!({"path":"keep.md","oldText":"Keep","newText":"Lose"}),
            ),
            ("notes.delete", json!({"path":"keep.md"})),
        ] {
            let (refused, jobs) = f.durable_call(
                db.clone(),
                actor,
                "tool",
                json!({"tool":tool,"parameters":parameters}),
                false,
            );
            assert!(refused.is_err());
            assert!(jobs.is_empty());
            assert!(!root.join("refused.md").exists());
            assert_eq!(
                std::fs::read_to_string(root.join("keep.md")).unwrap(),
                "Keep this note."
            );
        }
        f.rt.block_on(f.bootstrap.batch_execute("DROP TRIGGER reject_notes_write_checkpoint ON app.notes_sync_checkpoints; DROP FUNCTION app.reject_notes_write_checkpoint()" )).unwrap();
        // A publication refusal happens after commit. The file and empty
        // checkpoint survive, and the captured metadata is sufficient to retry.
        let (failed, jobs) = f.durable_call(db.clone(), actor, "tool", json!({"tool":"notes.create","parameters":{"path":"retry.md","content":"Retry this note."}}), true);
        assert!(failed.is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("retry.md")).unwrap(),
            "Retry this note."
        );
        assert_eq!(jobs.len(), 1);
        let (recovered, _) = f.durable_call(
            db.clone(),
            actor,
            "job",
            json!({"queue":"notes.sync","parameters":jobs[0]["params"]}),
            false,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&recovered.unwrap()).unwrap()["errors"],
            0
        );
    }
    println!("PASS compiled create/edit/delete: owner-private UUID checkpoints resume actual file indexing and deletion cleanup for app/worker roles; failed post-commit publication retains a resumable checkpoint. Queue delivery and embeddings are stand-ins; installed approval/chat is not proved.");
}
