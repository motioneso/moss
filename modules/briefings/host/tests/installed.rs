//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
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

/// Stands in for the router. The reply is set per test and every prompt is kept for checks.
#[derive(Default)]
struct Scripted {
    reply: std::sync::Mutex<Option<String>>,
    prompts: std::sync::Mutex<Vec<Value>>,
}
impl moss_module_host::ai::Intelligence for Scripted {
    fn generate(&self, _: &CallScope, request: &Request) -> anyhow::Result<Value> {
        self.prompts.lock().unwrap().push(request.parameters.clone());
        match self.reply.lock().unwrap().clone() {
            Some(text) => Ok(json!({"text": text})),
            None => anyhow::bail!("The configured AI service is not set up"),
        }
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

/// Reads as the app role with the actor set, so row security applies as it does at run time.
fn rows_as(
    f: &support::Fixture,
    actor: uuid::Uuid,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) =
            tokio_postgres::connect(&std::env::var("JS48_APP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.execute("SELECT set_config('app.actor_user_id', $1, true)", &[&actor.to_string()]).await.unwrap();
        let rows = tx.query(sql, params).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
}

/// One installed Briefings package on a fresh database, with the person's saved zone.
struct World {
    ai: Arc<Scripted>,
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new(zone: &str) -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            // The queue tables are created once per database, however many tests run here.
            let ready = f.root.query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0);
            if !ready {
                f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
                f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
            }
            {
                let who = f.a;
                f.root
                    .execute(
                        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',jsonb_build_object('timezone',$2::text))",
                        &[&who, &zone],
                    )
                    .await
                    .unwrap();
            }
        });
        // An earlier test in this database installed the package into a folder that is gone.
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[])).unwrap();
        let ai = Arc::new(Scripted::default());
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_briefings_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: ai.clone(),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "briefings-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { ai, f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(self.f.access(actor), method, &format!("/api/m/briefings{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    }
    /// Runs the worker until the queue has nothing due.
    fn work(&self) {
        let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
        for _ in 0..6 {
            self.app.installer.run_job(&worker).unwrap();
        }
    }
    fn count(&self, sql: &str, who: uuid::Uuid) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[&who])).unwrap().get(0)
    }
    fn make_schedule_due(&self, who: uuid::Uuid) {
        self.f
            .rt
            .block_on(self.f.root.execute(
                "UPDATE moss_queue.schedules SET next_at=now()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%.briefings-run'",
                &[&who],
            ))
            .unwrap();
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_briefings_keep_definitions_and_runs_private_and_schedule_in_the_owner_zone() {
    let w = World::new("Pacific/Auckland");
    let f = &w.f;
    let call = |actor, method: &str, path: &str, body: Value| w.call(actor, method, path, body);

    // Person A saves a daily definition. Its schedule is registered in the queue.
    let made = call(f.a, "POST", "/definitions",
        json!({"title":format!("Plan {MARK}"),"briefingType":"morning","cadence":"daily"}));
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["definition"]["id"].as_str().unwrap().to_owned();
    let schedule_sql = "SELECT cron, timezone FROM moss_queue.schedules WHERE queue LIKE '%.briefings-run'";
    let schedules: Vec<(String, String)> =
        rows_as(&f, f.a, schedule_sql, &[]).iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(schedules.len(), 1, "one schedule for the definition");
    assert_eq!(schedules[0].0, "0 7 * * *");
    assert_eq!(schedules[0].1, "Pacific/Auckland", "schedule uses the owner's zone");
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
    let still = rows_as(&f, f.a, schedule_sql, &[]).len() as i64;
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
    let mut leaked = 0;
    for actor in [f.a, f.b] {
        for table in ["moss_queue.jobs", "moss_queue.schedules"] {
            let sql = format!("SELECT count(*) FROM {table} t WHERE t::text LIKE $1");
            leaked += rows_as(&f, actor, &sql, &[&format!("%{MARK}%")])[0].get::<_, i64>(0);
        }
    }
    leaked += f.rt.block_on(async {
        let mut total = 0;
        for table in f
            .root
            .query("SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname='moss_modules'", &[])
            .await
            .unwrap()
        {
            let name: String = table.get(0);
            total += f
                .root
                .query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE $1"), &[&format!("%{MARK}%")])
                .await
                .unwrap()
                .get::<_, i64>(0);
        }
        total
    });
    assert_eq!(leaked, 0, "briefing text reached the job queue or module tables");

    // Replay: the old routes and the installed package answer the same steps the same way.
    // The old routes run as the administrator and the package as person B, both from nothing.
    f.rt.block_on(async {
        f.root.batch_execute("DELETE FROM app.shares; DELETE FROM app.briefing_definitions; DELETE FROM moss_queue.schedules").await.unwrap();
    });
    let mut old_schedule = std::collections::BTreeMap::new();
    let mut note = |calls: Vec<Value>| {
        for c in calls {
            let key = c["key"].as_str().unwrap().to_owned();
            if c["op"] == "schedule" {
                old_schedule.insert(key, (c["cron"].as_str().unwrap().to_owned(), c["tz"].as_str().unwrap().to_owned()));
            } else {
                old_schedule.remove(&key);
            }
        }
    };
    let run_new = |steps: &[Value], vars: &Value| -> Vec<Value> {
        steps
            .iter()
            .map(|step| {
                let path = replay::fill(step["url"].as_str().unwrap(), vars).replacen("/api/briefings", "", 1);
                call(f.b, step["method"].as_str().unwrap(), &path, step.get("body").cloned().unwrap_or(Value::Null))
            })
            .collect()
    };
    let compare = |label: &str, steps: &[Value], old: Vec<Value>, new: Vec<Value>| {
        assert_eq!(old.len(), new.len());
        for (i, (mut old, mut new)) in old.into_iter().zip(new).enumerate() {
            let mut old = json!({"status":old["status"],"body":old["body"]});
            let mut new = json!({"status":new["status"],"body":new["body"]});
            replay::mask(&mut old);
            replay::mask(&mut new);
            assert_eq!(old, new, "{label} step {i} ({}) differs from the old route", steps[i]);
        }
    };
    let first = replay::steps_before_ids();
    let (old, calls) = replay::old_routes(f.admin, &first, json!({}));
    note(calls);
    let new = run_new(&first, &json!({}));
    let old_def = old[1]["body"]["definition"]["id"].as_str().unwrap().to_owned();
    let new_def = new[1]["body"]["definition"]["id"].as_str().unwrap().to_owned();
    println!("OLD STATUSES {:?}", old.iter().map(|r| r["status"].as_i64().unwrap()).collect::<Vec<_>>());
    compare("create and read", &first, old, new);
    let seed_run = |owner: uuid::Uuid, def: &str| -> String {
        f.rt.block_on(async {
            let id = uuid::Uuid::new_v4();
            f.root
                .execute(
                    "INSERT INTO app.briefing_runs(id,definition_id,owner_user_id,status,run_kind,briefing_type,summary_text,source_metadata) \
                     VALUES($1,$2,$3,'succeeded','manual','morning','Replay text','{\"aiModel\":{\"provider\":\"p\",\"model\":\"m\"},\"calendarSignals\":[{\"type\":\"meeting\",\"summary\":\"Standup\",\"score\":70}]}'::jsonb)",
                    &[&id, &def.parse::<uuid::Uuid>().unwrap(), &owner],
                )
                .await
                .unwrap();
            id.to_string()
        })
    };
    let (old_run, new_run) = (seed_run(f.admin, &old_def), seed_run(f.b, &new_def));
    let second = replay::steps_with_ids();
    let (old, calls) = replay::old_routes(f.admin, &second, json!({"def":old_def,"run":old_run}));
    note(calls);
    let new = run_new(&second, &json!({"def":new_def,"run":new_run}));
    compare("edit and runs", &second, old, new);
    let mut expected: Vec<(String, String)> = old_schedule.into_values().collect();
    let mut actual: Vec<(String, String)> =
        rows_as(&f, f.b, schedule_sql, &[]).iter().map(|r| (r.get(0), r.get(1))).collect();
    expected.sort();
    actual.sort();
    assert_eq!(actual, expected, "registered schedules differ from the old routes");
    println!("PASS replay: {} old-route steps match, schedules match ({} registered)", first.len() + second.len(), actual.len());
}

const FALLBACK: &str = "Briefing did not produce visible source items.";

fn zone_for(w: &World, who: uuid::Uuid, zone: &str) {
    w.f.rt
        .block_on(w.f.root.execute(
            "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',jsonb_build_object('timezone',$2::text))",
            &[&who, &zone],
        ))
        .unwrap();
}

fn make_definition(w: &World, who: uuid::Uuid, cadence: &str) -> String {
    let made = w.call(who, "POST", "/definitions", json!({"title":format!("Plan {MARK}"),"briefingType":"morning","cadence":cadence}));
    assert_eq!(made["status"], 201, "{made}");
    made["body"]["definition"]["id"].as_str().unwrap().to_owned()
}

#[test]
#[ignore = "Only through verify-gate"]
fn manual_and_scheduled_runs_store_once_notify_once_and_keep_text_out_of_every_side_table() {
    let w = World::new("UTC");
    let (a, b) = (w.f.a, w.f.b);
    zone_for(&w, b, "UTC");
    let id = make_definition(&w, a, "daily");
    let runs = |kind: &str| -> i64 {
        w.f.rt
            .block_on(w.f.root.query_one(
                "SELECT count(*) FROM app.briefing_runs WHERE owner_user_id=$1 AND run_kind::text=$2",
                &[&a, &kind],
            ))
            .unwrap()
            .get(0)
    };
    let notes = || w.count("SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1 AND module_id='briefings'", a);

    // A manual run answers at once with ids, reads as pending, then as ready after the worker ran it.
    let queued = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({}));
    assert_eq!(queued["status"], 202, "{queued}");
    let (job, run) = (queued["body"]["jobId"].as_str().unwrap().to_owned(), queued["body"]["runId"].as_str().unwrap().to_owned());
    let read = |who: uuid::Uuid| w.call(who, "GET", &format!("/definitions/{id}/runs/{run}?jobId={job}"), Value::Null);
    let before = read(a);
    assert_eq!((before["status"].clone(), before["body"]["state"].clone()), (json!(200), json!("pending")), "{before}");
    assert_eq!(runs("manual"), 0);
    w.work();
    let after = read(a);
    assert_eq!(after["body"]["state"], "ready", "{after}");
    assert_eq!(runs("manual"), 1);
    let stored: String = w.f.rt.block_on(w.f.root.query_one("SELECT summary_text FROM app.briefing_runs WHERE id=$1", &[&run.parse::<uuid::Uuid>().unwrap()])).unwrap().get(0);
    assert!(!stored.trim().is_empty(), "with no model the run keeps a plain digest");
    let reason: Option<String> = w.f.rt.block_on(w.f.root.query_one("SELECT source_metadata->>'degradedReason' FROM app.briefing_runs WHERE id=$1", &[&run.parse::<uuid::Uuid>().unwrap()])).unwrap().get(0);
    assert_eq!(reason.as_deref(), Some("synthesis_failed"), "the host gives guests one fixed failure text, so an unset model reads as a failed call");
    assert_eq!(notes(), 0, "a manual run does not notify");
    println!("PASS manual run: queued, pending, then ready with a plain digest, no notification");

    // The same key while the first job waits is refused. After it finishes the key may be reused.
    let first = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({"idempotencyKey":"k1"}));
    let again = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({"idempotencyKey":"k1"}));
    assert_eq!((first["status"].clone(), again["status"].clone(), again["body"]["code"].clone()), (json!(202), json!(409), json!("briefing_run_in_flight")), "{again}");
    w.work();
    let reuse = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({"idempotencyKey":"k1"}));
    assert_eq!(reuse["status"], 202, "{reuse}");
    w.work();
    assert_eq!(runs("manual"), 3);
    println!("PASS key: refused while queued (409), accepted again once the first finished");

    // A scheduled fire stores one run and notifies once. A second fire the same day does neither.
    w.make_schedule_due(a);
    w.work();
    assert_eq!((runs("scheduled"), notes()), (1, 1));
    w.make_schedule_due(a);
    w.work();
    assert_eq!((runs("scheduled"), notes()), (1, 1), "the same local day never runs or notifies twice");
    println!("PASS scheduled run: one run and one notification, the second fire the same day did nothing");

    let note = w.f.rt.block_on(w.f.root.query_one(
        "SELECT title, coalesce(body,''), event_key, to_jsonb(n)::text FROM app.notifications n WHERE recipient_user_id=$1 AND module_id='briefings'",
        &[&a],
    )).unwrap();
    let (title, body, event_key, whole): (String, String, String, String) = (note.get(0), note.get(1), note.get(2), note.get(3));
    assert_eq!(title, "Your morning briefing is ready");
    assert_eq!(body, "");
    assert!(event_key.starts_with("briefing-run-"));
    assert!(!whole.contains(MARK) && !whole.contains(FALLBACK), "{whole}");

    // The definition title is planted. It must be in no queue row, no notification and no log table.
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log')",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")), "{tables:?}");
    for table in &tables {
        for needle in [MARK, FALLBACK] {
            let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&needle])).unwrap().get(0);
            assert_eq!(hits, 0, "{table} holds briefing text");
        }
    }
    let payloads: Vec<String> = w.f.rt.block_on(w.f.root.query("SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%.briefings-run%'", &[])).unwrap().iter().map(|r| r.get(0)).collect();
    assert!(payloads.len() >= 4, "{payloads:?}");
    for payload in &payloads {
        let value: Value = serde_json::from_str(payload).unwrap();
        // The queue wraps the module's params in its own metadata envelope. Only the params are the module's.
        let params = value["params"].as_object().unwrap();
        let keys: std::collections::BTreeSet<&str> = params.keys().map(String::as_str).collect();
        assert!(keys.is_subset(&["definition-id", "briefing-run-id", "briefing-type", "run-kind"].into_iter().collect()), "{payload}");
    }
    println!("PASS privacy: scanned {} tables and {} job payloads, found no briefing text", tables.len(), payloads.len());
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_read_run_status_or_queue_a_run_and_the_check_fails_without_row_security() {
    let w = World::new("UTC");
    let (a, b) = (w.f.a, w.f.b);
    zone_for(&w, b, "UTC");
    let id = make_definition(&w, a, "manual");
    let queued = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({}));
    let (job, run) = (queued["body"]["jobId"].as_str().unwrap().to_owned(), queued["body"]["runId"].as_str().unwrap().to_owned());
    // B has a view share, so B can name the definition. B is still not the job's owner.
    w.f.rt
        .block_on(w.f.root.execute(
            "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('briefing_definition',$1,$2,$3,'view')",
            &[&id.parse::<uuid::Uuid>().unwrap(), &a, &b],
        ))
        .unwrap();
    let probe = |who| w.call(who, "GET", &format!("/definitions/{id}/runs/{run}?jobId={job}"), Value::Null);
    assert_eq!(probe(a)["body"]["state"], "pending");
    assert_eq!(probe(b)["status"], 404, "B must not learn that A has a run queued");
    assert_eq!(w.call(b, "POST", &format!("/definitions/{id}/run"), json!({}))["status"], 404, "B cannot queue a run of A's definition");
    let queue_rows = |who| -> i64 {
        rows_as(&w.f, who, "SELECT count(*) FROM moss_queue.jobs WHERE queue LIKE '%.briefings-run-now'", &[])[0].get(0)
    };
    assert_eq!((queue_rows(a), queue_rows(b)), (1, 0));
    println!("GREEN: B reads 404 for A's queued run and sees no queue rows");

    // With row security removed from the queue, the same read leaks the pending state.
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE moss_queue.jobs DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = probe(b);
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE moss_queue.jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE moss_queue.jobs FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(open["body"]["state"], "pending", "RED expected: B sees A's queued run with row security removed, got {open}");
    println!("RED: with row security removed from the queue B sees A's queued run");
    assert_eq!(probe(b)["status"], 404, "restored");
    println!("GREEN: row security restored, B reads 404 again");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_run_with_no_source_modules_installed_records_visible_gaps_and_no_source_text() {
    let w = World::new("UTC");
    let a = w.f.a;
    let made = w.call(a, "POST", "/definitions", json!({
        "title":format!("Plan {MARK}"),"briefingType":"morning","cadence":"manual",
        "selectedToolNames":["tasks.list","calendar.listVisibleEvents","email.listVisibleMessages"]}));
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["definition"]["id"].as_str().unwrap().to_owned();
    let queued = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({}));
    assert_eq!(queued["status"], 202, "{queued}");
    w.work();
    let metadata: Value = w.f.rt.block_on(w.f.root.query_one(
        "SELECT source_metadata FROM app.briefing_runs WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1",
        &[&a],
    )).unwrap().get(0);
    let gaps: Vec<(String, String)> = metadata["gaps"].as_array().unwrap().iter()
        .map(|g| (g["source"].as_str().unwrap().to_owned(), g["reason"].as_str().unwrap().to_owned()))
        .collect();
    for source in ["tasks", "calendar", "email"] {
        assert!(gaps.contains(&(source.to_owned(), "tool_failed".to_owned())), "{source} gap missing in {gaps:?}");
    }
    assert!(gaps.contains(&("priority".to_owned(), "unwired".to_owned())), "{gaps:?}");
    assert!(!metadata.to_string().contains(MARK), "{metadata}");
    println!("PASS installed run with no source modules: {} visible gaps recorded, no text", gaps.len());
}

const WRITTEN: &str = "WRITTEN-BY-MODEL-91ac";

#[test]
#[ignore = "Only through verify-gate"]
fn model_written_text_is_stored_for_the_owner_only_and_reaches_no_other_table_or_payload() {
    let w = World::new("UTC");
    let (a, b) = (w.f.a, w.f.b);
    zone_for(&w, b, "UTC");
    *w.ai.reply.lock().unwrap() = Some(format!("Calm day {WRITTEN}.\n\n## Prepare\nBring notes at 9 AM."));
    let id = make_definition(&w, a, "daily");
    let queued = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({}));
    assert_eq!(queued["status"], 202, "{queued}");
    let run = queued["body"]["runId"].as_str().unwrap().parse::<uuid::Uuid>().unwrap();
    w.work();
    w.make_schedule_due(a);
    w.work();

    // The model was asked once per run, through the router port, with the trusted block first.
    let prompts = w.ai.prompts.lock().unwrap().clone();
    assert!(prompts.len() >= 2, "{prompts:?}");
    assert_eq!(prompts[0]["maxOutputTokens"], 2000);
    assert!(prompts[0]["prompt"].as_str().unwrap().starts_with("<trusted_instructions>"));

    // The owner's run holds the written text and a model name, and is not marked as a fallback.
    let row = w.f.rt.block_on(w.f.root.query_one(
        "SELECT summary_text, source_metadata FROM app.briefing_runs WHERE id=$1", &[&run])).unwrap();
    let (text, meta): (String, Value) = (row.get(0), row.get(1));
    assert!(text.contains(WRITTEN), "{text}");
    assert_eq!(meta["aiModel"]["id"], "router");
    assert_ne!(meta["degraded"], json!(true));
    let read = w.call(a, "GET", &format!("/definitions/{id}/runs/{run}"), Value::Null);
    assert!(read["body"].to_string().contains(WRITTEN), "the owner reads the written text: {read}");
    println!("PASS owner run: written text stored, model named, not a fallback");

    // Nothing but the run table holds the text.
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root.query(
            "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
             OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log')", &[])
            .await.unwrap().iter().map(|r| r.get(0)).collect()
    });
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&WRITTEN])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds the written text");
    }
    println!("PASS leak scan: {} tables and every job payload hold no written text", tables.len());

    // A second person cannot read it. Without row security the same read leaks it.
    let others = |who| -> i64 { rows_as(&w.f, who, "SELECT count(*) FROM app.briefing_runs WHERE summary_text LIKE '%'||$1||'%'", &[&WRITTEN])[0].get(0) };
    assert_eq!((others(a) > 0, others(b)), (true, 0));
    println!("GREEN: B sees none of A's runs");
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.briefing_runs DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = others(b);
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.briefing_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE app.briefing_runs FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(open > 0, "RED expected: B reads A's text with row security removed");
    println!("RED: with row security removed from the runs table B reads A's text");
    assert_eq!(others(b), 0, "restored");
    println!("GREEN: row security restored");
}

const EVENING_TEXT: &str = "EVENING-BY-MODEL-5d27";

#[test]
#[ignore = "Only through verify-gate"]
fn an_evening_run_is_written_through_the_router_for_the_owner_only_and_leaks_nowhere() {
    let w = World::new("UTC");
    let (a, b) = (w.f.a, w.f.b);
    zone_for(&w, b, "UTC");
    *w.ai.reply.lock().unwrap() = Some(format!("A steady day {EVENING_TEXT}.\n\nWhat got done\nShipped it."));
    let made = w.call(a, "POST", "/definitions", json!({"title":format!("Evening {MARK}"),"briefingType":"evening","cadence":"manual"}));
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["definition"]["id"].as_str().unwrap().to_owned();
    let queued = w.call(a, "POST", &format!("/definitions/{id}/run"), json!({}));
    assert_eq!(queued["status"], 202, "{queued}");
    let run = queued["body"]["runId"].as_str().unwrap().parse::<uuid::Uuid>().unwrap();
    w.work();

    // The router saw the evening prompt, with the fixed trusted block first and the lens block after.
    let prompts = w.ai.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1, "{prompts:?}");
    let prompt = prompts[0]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("<trusted_instructions>"));
    assert!(prompt.contains("<external_source type=\"tasks_reconciliation\">"));
    assert!(!prompt.contains(MARK), "the definition title is not briefing input");

    let row = w.f.rt.block_on(w.f.root.query_one("SELECT summary_text, source_metadata FROM app.briefing_runs WHERE id=$1", &[&run])).unwrap();
    let (text, meta): (String, Value) = (row.get(0), row.get(1));
    assert!(text.contains(EVENING_TEXT), "{text}");
    assert_eq!(meta["aiModel"]["id"], "router");
    assert!(meta.get("dayPlanAuto").is_none(), "no calendar signals, so nothing is reserved: {meta}");
    println!("PASS installed evening run: written text stored, model named, nothing reserved");

    // Nothing but the run table holds the text.
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root.query(
            "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
             OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log')", &[])
            .await.unwrap().iter().map(|r| r.get(0)).collect()
    });
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&EVENING_TEXT])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds the evening text");
    }
    println!("PASS leak scan: {} tables and every job payload hold no evening text", tables.len());

    // A second person cannot read it. Without row security the same read leaks it.
    let others = |who| -> i64 { rows_as(&w.f, who, "SELECT count(*) FROM app.briefing_runs WHERE summary_text LIKE '%'||$1||'%'", &[&EVENING_TEXT])[0].get(0) };
    assert_eq!((others(a) > 0, others(b)), (true, 0));
    println!("GREEN: B sees none of A's evening runs");
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.briefing_runs DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = others(b);
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.briefing_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE app.briefing_runs FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(open > 0, "RED expected: B reads A's evening text with row security removed");
    println!("RED: with row security removed from the runs table B reads A's evening text");
    assert_eq!(others(b), 0, "restored");
    println!("GREEN: row security restored");
}
