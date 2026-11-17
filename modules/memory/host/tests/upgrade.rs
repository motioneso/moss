//! Upgrade check. Reads an existing install's memory back through the new export, on a copy of
//! its database. Runs only when MEMORY_UPGRADE_BOOTSTRAP_URL and MEMORY_UPGRADE_APP_URL name a
//! throwaway copy, never a live database.
use access_context::AccessContext;
use moss_memory_host::ports::{Embedder, MemoryPorts};
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

struct Stub;
impl Embedder for Stub {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(vec![0.0; 768])
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        Ok((vec![0.0; 768], ("stand-in".into(), "1".into())))
    }
    fn model(&self, _: &CallScope) -> anyhow::Result<(String, String)> {
        Ok(("stand-in".into(), "1".into()))
    }
}

const SECTIONS: &[(&str, &str)] = &[
    ("memoryChunks", "memory_chunks"),
    ("chatMemoryFacts", "chat_memory_facts"),
    ("memoryEntities", "memory_entities"),
    ("memoryFacts", "memory_facts"),
    ("memoryEpisodes", "memory_episodes"),
    ("memoryFactSources", "memory_fact_sources"),
    ("memoryAliases", "memory_aliases"),
    ("memoryConflictGroups", "memory_conflict_groups"),
    ("memoryCandidates", "memory_candidates"),
    ("memorySearchDocuments", "memory_search_documents"),
    ("memoryLegacyFactMigrations", "memory_legacy_fact_migrations"),
];

/// Creates the module role, the module tables and the host-made policies the way an install
/// does, once per database. The throwaway database holds only the core migrations.
async fn provision(root: &mut Client) {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let role = moss_module_host::database::runtime_role(&manifest.id);
    let tx = root.transaction().await.unwrap();
    tx.batch_execute("SELECT pg_advisory_xact_lock(246246)").await.unwrap();
    tx.batch_execute(&format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{role}') THEN
           CREATE ROLE {role} NOLOGIN; END IF; END $$;
         GRANT {role} TO jarvis_app_runtime WITH INHERIT FALSE, SET TRUE;
         GRANT USAGE ON SCHEMA app TO {role};
         GRANT EXECUTE ON FUNCTION app.current_actor_user_id() TO {role}"
    ))
    .await
    .unwrap();
    for (table, files) in [
        ("app.memory_ingest_nudges", vec!["0363_memory_ingest_nudges.sql"]),
        (
            "app.memory_reembed_runs",
            vec!["0364_memory_reembed_runs.sql", "0365_memory_reembed_one_running.sql", "0366_memory_reembed_staged.sql"],
        ),
    ] {
        let made: bool = tx
            .query_one(&format!("SELECT to_regclass('{table}') IS NOT NULL"), &[])
            .await
            .unwrap()
            .get(0);
        if made {
            continue;
        }
        for file in files {
            let path = format!("{}/../sql/{file}", env!("CARGO_MANIFEST_DIR"));
            tx.batch_execute(&std::fs::read_to_string(path).unwrap()).await.unwrap();
        }
        let owned: &[&str] = if table.contains("nudges") {
            &["app.memory_ingest_nudges"]
        } else {
            &["app.memory_reembed_runs", "app.memory_reembed_staged"]
        };
        for t in owned {
            moss_module_host::rls::emit(&tx, &manifest, t).await.unwrap();
        }
    }
    moss_module_host::rls::emit_owner_delete(&tx, "app.memory_recording_fact_versions").await.unwrap();
    tx.commit().await.unwrap();
}

fn api(db: &Database, actor: Uuid, parameters: Value) -> Value {
    let ports: Arc<dyn Ports> = Arc::new(MemoryPorts::new(db.clone(), Arc::new(Stub), Arc::new(DenyPorts)).unwrap());
    let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
    let wasm = moss_memory_host::package::component(&core).unwrap();
    let manifest = moss_memory_host::package::manifest().unwrap();
    let payload = json!({"name": "collectMemoryExportSection", "parameters": parameters}).to_string();
    let out = Host::new(Limits::default()).unwrap().call(
        &wasm, Arc::new(manifest), AccessContext::new(actor, "upgrade-proof"), ports, "api", &payload,
    );
    let answer: Value = serde_json::from_str(&out.expect("the guest finished")).unwrap();
    assert!(answer.get("error").is_none(), "{answer}");
    answer["ok"].clone()
}

#[test]
#[ignore = "Only against a copy"]
fn an_existing_installs_rows_all_read_back() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (mut root, db) = rt.block_on(async {
        let (mut root, c) = tokio_postgres::connect(&std::env::var("MEMORY_UPGRADE_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = c.await;
        });
        provision(&mut root).await;
        let db = Database::connect(&std::env::var("MEMORY_UPGRADE_APP_URL").unwrap(), 4, RuntimeRole::App).await.unwrap();
        (root, db)
    });
    let owners: Vec<Uuid> = rt
        .block_on(root.query("SELECT DISTINCT owner_user_id FROM (SELECT owner_user_id FROM app.memory_chunks UNION SELECT owner_user_id FROM app.memory_entities UNION SELECT owner_user_id FROM app.memory_file_index) o", &[]))
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(!owners.is_empty(), "the copy holds no memory");
    let mut total = 0;
    for owner in owners {
        for (section, table) in SECTIONS {
            let want: i64 = rt
                .block_on(root.query_one(&format!("SELECT count(*) FROM app.{table} WHERE owner_user_id = $1"), &[&owner]))
                .unwrap()
                .get(0);
            let (mut got, mut after) = (0i64, Value::Null);
            loop {
                let mut p = json!({"section": section});
                if !after.is_null() {
                    p["after"] = after.clone();
                }
                let page = api(&db, owner, p);
                got += page["rows"].as_array().unwrap().len() as i64;
                after = page["next"].clone();
                if after.is_null() {
                    break;
                }
            }
            assert_eq!(got, want, "{section} for {owner}");
            total += got;
        }
    }
    println!("read back {total} rows across the owners");
    assert!(total > 0);
}
