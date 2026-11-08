//! Compiled People guest, merged linked-notes adapter and real legacy PostgreSQL.
//! This service checkpoint is not installed HTTP/UI or ingest-worker evidence.
mod common;
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
    linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders},
    manifest::{Ledger, Manifest},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use moss_people::repository::TABLES;
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
use uuid::Uuid;
use vault::AllowedRoots;

// Fail after the real file publication, or interleave an arbitrary editor before
// publication. Neither path substitutes the filesystem or database adapter.
struct Faults {
    next: Arc<dyn Ports>,
    mode: AtomicU8,
    reads: AtomicU8,
    folder: PathBuf,
}
impl Ports for Faults {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if port == "context"
            && request.operation == "read"
            && self.mode.load(Ordering::SeqCst) == 4
            && self.reads.fetch_add(1, Ordering::SeqCst) == 1
        {
            self.mode.store(0, Ordering::SeqCst);
            anyhow::bail!("Synthetic error after real projection and identity deletion");
        }
        if port == "vault" && request.operation == "notes.compare-write" {
            let mode = self.mode.load(Ordering::SeqCst);
            if mode != 4 {
                self.mode.store(0, Ordering::SeqCst);
            }
            let path = self
                .folder
                .join(request.parameters["path"].as_str().unwrap());
            if mode == 2 {
                std::fs::write(&path, "External editor wins\n")?;
            }
            let result = self.next.invoke(scope, port, request)?;
            if mode == 1 {
                anyhow::bail!("Synthetic error after actual note publication");
            }
            if mode == 3 {
                std::fs::write(&path, "External editor wins\n")?;
                anyhow::bail!("Synthetic failure with external edit before compensation");
            }
            return Ok(result);
        }
        self.next.invoke(scope, port, request).map_err(|error| {
            eprintln!(
                "Synthetic People notes fixture port failed: {port}/{}: {error:#}",
                request.operation
            );
            error
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn compiled_people_coordinates_canonical_notes_and_projection() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = Uuid::new_v4();
    let other = Uuid::new_v4();
    let admin = Uuid::new_v4();
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("Contacts");
    std::fs::create_dir(&folder).unwrap();
    let bootstrap = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _=connection.await; });
        for (id, is_admin) in [(actor,false),(other,false),(admin,true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'People notes test',$3)", &[&id,&format!("people-notes-{id}@example.test"),&is_admin]).await.unwrap();
        }
        db.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'people-notes-folder',$2),($1,'notes-source-path',$3)", &[&actor,&json!("Contacts"),&json!(temp.path().to_str().unwrap())]).await.unwrap();
        db
    });
    let database = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let roots = [actor, other, admin]
        .into_iter()
        .map(|id| {
            let access = AccessContext::new(id, "people-notes-roots");
            (
                id,
                AllowedRoots::for_account(&access, vec![temp.path().into()]),
            )
        })
        .collect();
    let provider = PreferenceFolders::new(
        database.clone(),
        BTreeMap::from([(
            ("people".into(), "people-notes".into()),
            PreferenceFolder {
                preference: "people-notes-folder".into(),
                relative_to: Some("notes-source-path".into()),
            },
        )]),
        roots,
    )
    .unwrap();
    let files = Arc::new(LinkedNotesPorts::new(
        Arc::new(provider),
        Arc::new(ContextPorts::new(Arc::new(DenyPorts))),
    ));
    let faults = Arc::new(Faults {
        next: files,
        mode: AtomicU8::new(0),
        reads: AtomicU8::new(0),
        folder: folder.clone(),
    });
    let ports = Arc::new(TransactionalDatabasePorts::new(database, faults.clone()).unwrap());
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "people".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = TABLES.map(str::to_owned).to_vec();
    manifest.capabilities=serde_json::from_value(json!([
        {"port":"db","operations":["query"],"resources":TABLES},
        {"port":"context","operations":["read","uuid"],"resources":["call","new"]},
        {"port":"vault","operations":["notes.read","notes.list","notes.compare-write"],"resources":["people-notes"]}
    ])).unwrap();
    let manifest: Arc<Manifest> = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let run =
        |user, method: &str, path: &str, body: Value, params: Value| -> anyhow::Result<Value> {
            let reply = host.call(
                &component,
                manifest.clone(),
                AccessContext::new(user, "people-notes-service"),
                ports.clone(),
                "route",
                &json!({"method":method,"path":path,"body":body,"params":params}).to_string(),
            )?;
            let reply: Value = serde_json::from_str(&reply)?;
            assert_eq!(reply["status"], 200);
            Ok(reply["body"].clone())
        };
    // An empty existing file is a collision, not an available destination.
    std::fs::write(folder.join("Native-Person.md"), "").unwrap();
    let created=run(actor,"POST","/people",json!({"displayName":"Native Person","aliases":["N"],"emails":["N@example.test"],"phones":["123"]}),json!({})).expect("People create must run in the compiled guest");
    let id = created["person"]["id"].as_str().unwrap();
    let path = created["notePath"].as_str().unwrap();
    assert!(path.starts_with("Native-Person-") && path.ends_with(".md"));
    assert_eq!(
        std::fs::read_to_string(folder.join("Native-Person.md")).unwrap(),
        ""
    );
    let content = std::fs::read_to_string(folder.join(path)).unwrap();
    assert!(content.contains(&format!("jarvisPersonId: {id}")));
    assert!(content.contains("Emails: N@example.test"));
    assert!(content.contains("Phones: 123"));
    assert_eq!(created["person"]["confidence"], "1.00");
    let human = format!("{content}\nHuman text stays.\n");
    std::fs::write(folder.join(path), &human).unwrap();
    let updated = run(
        actor,
        "PATCH",
        "/people/:id",
        json!({"displayName":"Renamed Person"}),
        json!({"id":id}),
    )
    .unwrap();
    assert_eq!(updated["person"]["displayName"], "Renamed Person");
    let renamed = std::fs::read_to_string(folder.join(path)).unwrap();
    assert!(renamed.contains("Human text stays."));
    assert!(renamed.contains("Display name: Renamed Person"));
    assert_eq!(
        run(
            actor,
            "POST",
            "/people/:id/archive",
            json!({}),
            json!({"id":id})
        )
        .unwrap()["person"]["status"],
        "archived"
    );
    let archived = std::fs::read_to_string(folder.join(path)).unwrap();
    for mode in [1, 2, 3, 4] {
        std::fs::write(folder.join(path), &archived).unwrap();
        faults.reads.store(0, Ordering::SeqCst);
        faults.mode.store(mode, Ordering::SeqCst);
        assert!(run(
            actor,
            "PATCH",
            "/people/:id",
            json!({"displayName":"Must not commit"}),
            json!({"id":id})
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(folder.join(path)).unwrap(),
            if mode == 1 || mode == 4 {
                archived.as_str()
            } else {
                "External editor wins\n"
            }
        );
        let name: String = rt.block_on(async {
            bootstrap
                .query_one(
                    "SELECT display_name FROM app.person_context_people WHERE id=$1",
                    &[&Uuid::parse_str(id).unwrap()],
                )
                .await
                .unwrap()
                .get(0)
        });
        assert_eq!(
            name, "Renamed Person",
            "File failure must roll back its projection"
        );
        let identities: i64 = rt.block_on(async {
            bootstrap
                .query_one(
                    "SELECT count(*) FROM app.person_context_identities WHERE person_id=$1",
                    &[&Uuid::parse_str(id).unwrap()],
                )
                .await
                .unwrap()
                .get(0)
        });
        assert_eq!(
            identities, 2,
            "Failure after projection must also restore deleted note identities"
        );
    }
    std::fs::write(folder.join(path), &archived).unwrap();
    for reader in [other, admin] {
        assert!(run(
            reader,
            "POST",
            "/people/notes/refresh",
            json!({}),
            json!({})
        )
        .is_err());
        assert!(run(
            reader,
            "PATCH",
            "/people/:id",
            json!({"displayName":"Intruder"}),
            json!({"id":id})
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(folder.join(path)).unwrap(),
            archived
        );
    }
    // A canonical note with another owner's real ID must not steal that row. The
    // real projection SQL fails after file publication; finalization restores it.
    let foreign = Uuid::new_v4();
    rt.block_on(async {bootstrap.execute("INSERT INTO app.person_context_people(id,owner_user_id,display_name) VALUES($1,$2,'Other owner')", &[&foreign,&other]).await.unwrap();});
    let forged = archived.replace(id, &foreign.to_string());
    std::fs::write(folder.join("forged.md"), &forged).unwrap();
    assert!(run(
        actor,
        "PATCH",
        "/people/:id",
        json!({"displayName":"Must not steal"}),
        json!({"id":foreign})
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(folder.join("forged.md")).unwrap(),
        forged
    );
    let foreign_name: String = rt.block_on(async {
        bootstrap
            .query_one(
                "SELECT display_name FROM app.person_context_people WHERE id=$1",
                &[&foreign],
            )
            .await
            .unwrap()
            .get(0)
    });
    assert_eq!(foreign_name, "Other owner");
    std::fs::remove_file(folder.join("forged.md")).unwrap();
    // Duplicate canonical IDs and missing IDs produce review; malformed notes are ignored.
    std::fs::create_dir(folder.join("nested")).unwrap();
    std::fs::write(folder.join("nested/duplicate.md"), &archived).unwrap();
    std::fs::write(
        folder.join("missing-id.md"),
        "---\ndisplayName: Missing ID\nstatus: active\n---\n",
    )
    .unwrap();
    std::fs::write(folder.join("ordinary.md"), "# ordinary note\n").unwrap();
    let refresh = run(actor, "POST", "/people/notes/refresh", json!({}), json!({})).unwrap();
    assert_eq!(
        refresh,
        json!({"discovered":5,"projected":0,"ignored":2,"candidates":2})
    );
    std::fs::remove_file(folder.join("nested/duplicate.md")).unwrap();
    let refresh = run(actor, "POST", "/people/notes/refresh", json!({}), json!({})).unwrap();
    assert_eq!(
        refresh,
        json!({"discovered":4,"projected":1,"ignored":2,"candidates":1})
    );
    // Removal is observed on refresh; the person remains and gets a review candidate.
    std::fs::remove_file(folder.join(path)).unwrap();
    assert_eq!(
        run(actor, "POST", "/people/notes/refresh", json!({}), json!({})).unwrap()["candidates"],
        2
    );
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS50_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let created=run(actor,"POST","/people",json!({"displayName":"Note Oracle","aliases":["Oracle"],"emails":["oracle@example.test"],"phones":["123"]}),json!({})).unwrap();
    let oracle_id = created["person"]["id"].as_str().unwrap();
    let oracle_path = created["notePath"].as_str().unwrap();
    let initial = std::fs::read_to_string(folder.join(oracle_path)).unwrap();
    std::fs::write(
        folder.join(oracle_path),
        format!("{initial}\nHuman text stays.\n"),
    )
    .unwrap();
    let updated = run(
        actor,
        "PATCH",
        "/people/:id",
        json!({"displayName":"Renamed Oracle"}),
        json!({"id":oracle_id}),
    )
    .unwrap();
    let changed = std::fs::read_to_string(folder.join(oracle_path)).unwrap();
    let archived = run(
        actor,
        "POST",
        "/people/:id/archive",
        json!({}),
        json!({"id":oracle_id}),
    )
    .unwrap();
    let final_text = std::fs::read_to_string(folder.join(oracle_path)).unwrap();
    let known = std::collections::HashSet::new();
    let mut expected = parity_canon::Canon::new(chrono::Utc::now(), &known);
    let mut actual = parity_canon::Canon::new(chrono::Utc::now(), &known);
    assert_eq!(
        actual.value(&json!([created, updated, archived])),
        expected.value(&oracle["notes"]["responses"]),
        "Real TypeScript canonical-note service response parity"
    );
    let old_id = oracle["notes"]["responses"][0]["person"]["id"]
        .as_str()
        .unwrap();
    for (index, text) in [initial, changed, final_text].iter().enumerate() {
        assert_eq!(
            *text,
            oracle["notes"]["contents"][index]
                .as_str()
                .unwrap()
                .replace(old_id, oracle_id),
            "Canonical note bytes differ from the real TypeScript service"
        );
    }
    rt.block_on(async {
        bootstrap
            .execute(
                "DELETE FROM app.users WHERE id=ANY($1)",
                &[&vec![actor, other, admin]],
            )
            .await
            .unwrap();
    });
    println!("PASS compiled People note create/update/archive/refresh with shared adapter and app.preferences; collisions, human text, duplicate/missing review, real publication failure, external conflict and compensation; no installed UI or ingest-worker proof");
}
