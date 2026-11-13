//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-4f1c9b";

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Briefings has no AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Briefings has no embeddings")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("BRIEFINGS_COMPONENT_WASM")
            .expect("Run modules/briefings/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_briefings_keep_definitions_and_runs_private_and_schedule_in_the_owner_zone() {
    let f = support::Fixture::new();
    f.rt.block_on(async {
        f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        f.root
            .execute(
                "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale.timezone','\"Pacific/Auckland\"')",
                &[&f.a],
            )
            .await
            .ok();
    });
    let dir = tempfile::tempdir().unwrap();
    let reg = tempfile::tempdir().unwrap();
    let bytes = moss_briefings_host::package::pack(&root(), &component()).unwrap();
    let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
    let app = Application::open(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
        },
    )
    .unwrap();
    let source = app
        .installer
        .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "briefings-test-registry")
        .unwrap();
    app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    let call = |actor, method: &str, path: &str, body: Value| -> Value {
        serde_json::from_str(
            &app.dispatch(f.access(actor), method, &format!("/api/m/briefings{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    };

    // Person A saves a daily definition. Its schedule is registered in the queue.
    let made = call(f.a, "POST", "/definitions",
        json!({"title":format!("Plan {MARK}"),"briefingType":"morning","cadence":"daily"}));
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["definition"]["id"].as_str().unwrap().to_owned();
    let schedules: Vec<(String, String)> = f.rt.block_on(async {
        f.root
            .query("SELECT cron, timezone FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue='briefings-run'", &[&f.a])
            .await
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    });
    assert_eq!(schedules.len(), 1, "one schedule for the definition");
    assert_eq!(schedules[0].0, "0 7 * * *");
    println!("SCHEDULE cron={} timezone={}", schedules[0].0, schedules[0].1);

    // A run exists for A only.
    f.rt.block_on(async {
        let definition: uuid::Uuid = id.parse().unwrap();
        f.root
            .execute(
                "INSERT INTO app.briefing_runs(id,definition_id,owner_user_id,status,run_kind,briefing_type,summary_text,source_metadata) \
                 VALUES(gen_random_uuid(),$1,$2,'succeeded','manual','morning',$3,'{\"aiModel\":{\"provider\":\"p\",\"model\":\"m\"}}'::jsonb)",
                &[&definition, &f.a, &format!("Briefing {MARK}")],
            )
            .await
            .unwrap();
    });
    let own = call(f.a, "GET", &format!("/definitions/{id}/runs"), Value::Null);
    assert_eq!(own["body"]["runs"].as_array().unwrap().len(), 1, "{own}");
    let run_id = own["body"]["runs"][0]["id"].as_str().unwrap().to_owned();

    // Person B and an administrator see nothing and change nothing.
    let missing = call(f.b, "PATCH", "/definitions/99999999-9999-4999-8999-999999999999", json!({"title":"x"}))["status"].clone();
    for actor in [f.b, f.admin] {
        assert_eq!(call(actor, "GET", "/definitions", Value::Null)["body"]["definitions"], json!([]));
        assert_eq!(call(actor, "PATCH", &format!("/definitions/{id}"), json!({"title":"intruder"}))["status"], missing);
        assert_eq!(call(actor, "GET", &format!("/definitions/{id}/runs"), Value::Null)["status"], 404);
        assert_eq!(call(actor, "GET", &format!("/definitions/{id}/runs/{run_id}"), Value::Null)["status"], 404);
    }

    // A view share shows B the definition but never a run, and B cannot edit.
    let share = |level: &str| {
        f.rt.block_on(async {
            let definition: uuid::Uuid = id.parse().unwrap();
            f.root.execute("DELETE FROM app.shares WHERE resource_id=$1", &[&definition]).await.unwrap();
            f.root
                .execute(
                    "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('briefing_definition',$1,$2,$3,$4)",
                    &[&definition, &f.a, &f.b, &level],
                )
                .await
                .unwrap();
        })
    };
    share("view");
    assert_eq!(call(f.b, "GET", "/definitions", Value::Null)["body"]["definitions"].as_array().unwrap().len(), 1);
    assert_eq!(call(f.b, "PATCH", &format!("/definitions/{id}"), json!({"title":"viewer"}))["status"], 404);
    assert_eq!(call(f.b, "GET", &format!("/definitions/{id}/runs"), Value::Null)["body"]["runs"], json!([]));
    assert_eq!(call(f.b, "GET", &format!("/definitions/{id}/runs/{run_id}"), Value::Null)["status"], 404);

    // A manage share lets B edit, and B's edit leaves the owner's schedule alone.
    share("manage");
    let edited = call(f.b, "PATCH", &format!("/definitions/{id}"), json!({"title":"Managed","cadence":"manual"}));
    assert_eq!(edited["status"], 200, "{edited}");
    let still: i64 = f.rt.block_on(async {
        f.root.query_one("SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue='briefings-run'", &[&f.a]).await.unwrap().get(0)
    });
    assert_eq!(still, 1, "a manager must not remove the owner's schedule");
    f.rt.block_on(f.root.execute("DELETE FROM app.shares", &[])).unwrap();

    // The same checks must fail with row security removed, then pass once it is restored.
    let reads_definition = || call(f.b, "GET", "/definitions", Value::Null)["body"]["definitions"].as_array().is_some_and(|d| !d.is_empty());
    let reads_run = || {
        // B needs a view of the definition to reach runs, so share it while the run table is open.
        call(f.b, "GET", &format!("/definitions/{id}/runs"), Value::Null)["body"]["runs"].as_array().is_some_and(|r| !r.is_empty())
    };
    for table in ["app.briefing_definitions", "app.briefing_runs"] {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open = if table == "app.briefing_definitions" { reads_definition() } else { share("view"); reads_run() };
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(open, "RED expected: {table} shows another person's data with row security removed");
        println!("RED {table}: another person sees the data with row security removed");
        println!("GREEN {table}: row security restored");
    }
    f.rt.block_on(f.root.execute("DELETE FROM app.shares", &[])).unwrap();
    assert!(!reads_definition());
    assert!(!reads_run());

    // The briefing title and text never reach the queue or any module bookkeeping table.
    let leaked: i64 = f.rt.block_on(async {
        let mut total = 0;
        for table in f
            .root
            .query("SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('moss_queue','moss_modules')", &[])
            .await
            .unwrap()
        {
            let name: String = table.get(0);
            let hits: i64 = f
                .root
                .query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE $1"), &[&format!("%{MARK}%")])
                .await
                .unwrap()
                .get(0);
            total += hits;
        }
        total
    });
    assert_eq!(leaked, 0, "briefing text reached the job queue or module tables");
}
