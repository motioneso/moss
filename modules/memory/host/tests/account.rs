//! Account export and deletion proofs. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_memory_host::ports::{Embedder, MemoryPorts};
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const MARKER: &str = "Synthetic quartz-heron marker 5521";

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

/// Every table the module owns, as the deletion call reports them.
const TABLES: &[&str] = &[
    "memory_reembed_staged", "memory_reembed_runs", "memory_ingest_nudges",
    "memory_recording_proposals", "memory_recording_receipts", "memory_search_documents",
    "memory_candidates", "memory_fact_sources", "memory_legacy_fact_migrations", "memory_aliases",
    "memory_facts", "memory_conflict_groups", "memory_episodes", "memory_entities",
    "chat_memory_facts", "memory_links", "memory_chunks", "memory_file_index",
    "memory_recording_fact_versions",
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

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (mut root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            provision(&mut root).await;
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Acc A',false),($2,$4,'Acc B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        let f = Self { rt, root, db, a, b };
        f.seed(a, "A");
        f.seed(b, "B");
        f
    }

    fn sql(&self, statement: &str) {
        self.rt.block_on(self.root.batch_execute(statement)).unwrap();
    }

    fn count(&self, table: &str, owner: Uuid) -> i64 {
        self.rt
            .block_on(self.root.query_one(&format!("SELECT count(*) FROM app.{table} WHERE owner_user_id = $1"), &[&owner]))
            .unwrap()
            .get(0)
    }

    /// One row, carrying the marker, in every table that can be filled without another module.
    fn seed(&self, o: Uuid, tag: &str) {
        let v = format!("[{}]", vec!["0"; 768].join(","));
        self.sql(&format!(
            "INSERT INTO app.memory_chunks(owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text, embedding, embed_model_name, embed_model_version)
               VALUES ('{o}','vault','n/{tag}.md',0,1,'h','{MARKER} {tag}','{v}','m','1');
             INSERT INTO app.memory_file_index(owner_user_id, source_kind, source_path, file_hash, embed_model_name, embed_model_version) VALUES ('{o}','vault','n/{tag}.md','h','m','1');
             INSERT INTO app.memory_links(owner_user_id, from_path, to_path) VALUES ('{o}','n/{tag}.md','n/other.md');
             INSERT INTO app.chat_memory_facts(owner_user_id, category, content) VALUES ('{o}','fact','{MARKER} {tag}');
             INSERT INTO app.memory_entities(owner_user_id, kind, name, summary) VALUES ('{o}','self','Me {tag}','{MARKER}');
             INSERT INTO app.memory_aliases(owner_user_id, entity_id, alias, normalized_alias)
               SELECT '{o}', id, 'alias {tag}', 'alias {tag}' FROM app.memory_entities WHERE owner_user_id='{o}';
             INSERT INTO app.memory_facts(owner_user_id, subject_entity_id, predicate, object_text, record_kind, confidence, importance, provenance, pinned)
               SELECT '{o}', id, 'prefers', '{MARKER} {tag}', 'preference', 0.9, 0.5, 'volunteered', false FROM app.memory_entities WHERE owner_user_id='{o}';
             INSERT INTO app.memory_episodes(owner_user_id, source_kind, source_ref, excerpt) VALUES ('{o}','chat','ref-{tag}','{MARKER} {tag}');
             INSERT INTO app.memory_fact_sources(owner_user_id, fact_id, episode_id)
               SELECT '{o}', f.id, e.id FROM app.memory_facts f, app.memory_episodes e WHERE f.owner_user_id='{o}' AND e.owner_user_id='{o}';
             INSERT INTO app.memory_conflict_groups(owner_user_id) VALUES ('{o}');
             INSERT INTO app.memory_candidates(owner_user_id, kind, action, payload_json, candidate_signature, confidence, importance, provenance)
               VALUES ('{o}','fact','create','{{\"excerpt\":\"{MARKER}\",\"k\":1}}','sig-{tag}',0.9,0.5,'volunteered');
             INSERT INTO app.memory_search_documents(owner_user_id, target_kind, target_id, search_text, embedding, embed_model_name, embed_model_version)
               SELECT '{o}','entity', id, '{MARKER} {tag}', '{v}', 'm', '1' FROM app.memory_entities WHERE owner_user_id='{o}';
             INSERT INTO app.memory_legacy_fact_migrations(owner_user_id, legacy_fact_id, memory_fact_id)
               SELECT '{o}', c.id, f.id FROM app.chat_memory_facts c, app.memory_facts f WHERE c.owner_user_id='{o}' AND f.owner_user_id='{o}';
             INSERT INTO app.memory_recording_fact_versions(owner_user_id, fact_id, lineage_id, side)
               SELECT '{o}', id, gen_random_uuid(), 'personal' FROM app.memory_facts WHERE owner_user_id='{o}';"
        ));
    }

    fn api(&self, actor: Uuid, name: &str, parameters: Value) -> Result<Value, (u64, String)> {
        let ports: Arc<dyn Ports> = Arc::new(
            MemoryPorts::new(self.db.clone(), Arc::new(Stub), Arc::new(DenyPorts)).unwrap(),
        );
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
        let wasm = moss_memory_host::package::component(&core).unwrap();
        let manifest = moss_memory_host::package::manifest().unwrap();
        let payload = json!({"name": name, "parameters": parameters}).to_string();
        let out = Host::new(Limits::default()).unwrap().call(
            &wasm,
            Arc::new(manifest),
            AccessContext::new(actor, "account-proof"),
            ports,
            "api",
            &payload,
        );
        let answer: Value = serde_json::from_str(&out.expect("the guest finished")).unwrap();
        match answer.get("error") {
            Some(e) => Err((e["statusCode"].as_u64().unwrap(), e["error"].as_str().unwrap().to_owned())),
            None => Ok(answer["ok"].clone()),
        }
    }

    /// Every row of every section, read page by page.
    fn export_all(&self, actor: Uuid) -> Value {
        let names = self.api(actor, "collectMemoryExportSection", json!({})).unwrap();
        let mut all = serde_json::Map::new();
        for name in names["sections"].as_array().unwrap() {
            let (mut rows, mut after) = (Vec::new(), Value::Null);
            loop {
                let mut p = json!({"section": name});
                if !after.is_null() {
                    p["after"] = after.clone();
                }
                let page = self.api(actor, "collectMemoryExportSection", p).unwrap();
                if page["rows"].is_object() {
                    all.insert(name.as_str().unwrap().into(), page["rows"].clone());
                    break;
                }
                rows.extend(page["rows"].as_array().cloned().unwrap_or_default());
                after = page["next"].clone();
                if after.is_null() {
                    break;
                }
            }
            if !all.contains_key(name.as_str().unwrap()) {
                all.insert(name.as_str().unwrap().into(), Value::Array(rows));
            }
        }
        Value::Object(all)
    }

    /// Rows an unfiltered read returns while signed in as `actor`.
    fn bare_count(&self, actor: Uuid, tables: &[&&str]) -> i64 {
        use safety_core::db::DataContext;
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "account-proof")).await.unwrap();
            let mut total = 0;
            for t in tables {
                total += cx.db().query_one(&format!("SELECT count(*) FROM app.{t}"), &[]).await.unwrap().get::<_, i64>(0);
            }
            total
        })
    }

    fn marker_hits(&self, sql: &str) -> i64 {
        self.rt.block_on(self.root.query_one(sql, &[&format!("%{MARKER}%")])).unwrap().get(0)
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn export_returns_only_the_callers_rows_and_no_vectors() {
    let f = Fixture::new();
    let mine = f.export_all(f.a);
    let text = mine.to_string();
    assert!(text.contains(&format!("{MARKER} A")), "the caller's text is exported");
    assert!(!text.contains(&format!("{MARKER} B")), "the other person's text must not appear");
    assert!(!text.contains(&f.b.to_string()), "the other person's id must not appear");
    assert!(!text.contains("embedding"), "vectors are never exported");
    for section in ["memoryChunks", "chatMemoryFacts", "memoryEntities", "memoryFacts", "memoryEpisodes", "memoryAliases", "memoryCandidates", "memorySearchDocuments"] {
        assert_eq!(mine[section].as_array().unwrap().len(), 1, "{section}");
    }
    assert_eq!(mine["memoryCandidates"][0]["payloadJson"], json!({"k": 1}), "excerpt is stripped");
    assert_eq!(mine["recordingMemory"]["factVersions"].as_array().unwrap().len(), 1);

    // Without row security an unfiltered read as B sees A's rows, so the policy is what hides them.
    let tables: Vec<_> = TABLES.iter().filter(|t| !t.contains("reembed") && !t.contains("nudges")).collect();
    assert_eq!(f.bare_count(f.b, &tables), 0);
    for t in &tables {
        f.sql(&format!("ALTER TABLE app.{t} NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY"));
    }
    let leaked = f.bare_count(f.b, &tables);
    for t in &tables {
        f.sql(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY"));
    }
    assert!(leaked >= 2 * tables.len() as i64 - 4, "without row security B sees everything, got {leaked}");
    assert_eq!(f.bare_count(f.b, &tables), 0);
    assert!(f.api(f.b, "collectMemoryExportSection", json!({"section": "nope"})).is_err());
    assert!(f.api(f.b, "collectMemoryExportSection", json!({"section": "memoryFacts", "owner": f.a.to_string()})).is_err());
}

#[test]
#[ignore = "Only through verify-gate"]
fn delete_removes_everything_for_the_caller_and_nothing_for_anyone_else() {
    let f = Fixture::new();
    let before_b: Vec<i64> = TABLES.iter().map(|t| f.count(t, f.b)).collect();
    let out = f.api(f.a, "deleteMemoryData", json!({})).unwrap();
    for t in TABLES {
        assert_eq!(f.count(t, f.a), 0, "{t} still has the caller's rows");
    }
    let after_b: Vec<i64> = TABLES.iter().map(|t| f.count(t, f.b)).collect();
    assert_eq!(before_b, after_b, "the other person lost rows");
    assert!(before_b.iter().sum::<i64>() > 10);
    assert!(out["total"].as_u64().unwrap() >= 10);
    assert!(!out.to_string().contains(MARKER), "the answer carries counts only");
    assert!(f.api(f.a, "deleteMemoryData", json!({"owner": f.b.to_string()})).is_err());
    let again = f.api(f.a, "deleteMemoryData", json!({})).unwrap();
    assert_eq!(again["total"], 0);
    // The export is empty afterwards.
    let empty = f.export_all(f.a);
    for (name, rows) in empty.as_object().unwrap() {
        if name != "recordingMemory" {
            assert!(rows.as_array().unwrap().is_empty(), "{name}");
        }
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn deleting_a_person_removes_every_row_and_leaves_the_other() {
    let f = Fixture::new();
    f.sql(&format!("DELETE FROM app.users WHERE id = '{}'", f.a));
    for t in TABLES {
        assert_eq!(f.count(t, f.a), 0, "{t} kept a deleted person's rows");
        assert!(f.count(t, f.b) >= 0);
    }
    assert!(f.count("memory_facts", f.b) > 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn memory_text_never_reaches_jobs_or_activity() {
    let f = Fixture::new();
    f.export_all(f.a);
    f.api(f.a, "deleteMemoryData", json!({})).unwrap();
    assert_eq!(f.marker_hits("SELECT count(*) FROM pgboss.job WHERE data::text LIKE $1"), 0);
    for table in ["jarvis_action_audit_log", "moss_activity_detail", "moss_model_activity_log"] {
        assert_eq!(f.marker_hits(&format!("SELECT count(*) FROM app.{table} t WHERE t::text LIKE $1")), 0, "{table}");
    }
}
