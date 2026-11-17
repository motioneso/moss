#[path = "support/heartbeat_fault.rs"]
mod heartbeat_fault;
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
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
};
use support::Fixture;
use uuid::Uuid;

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No AI in Calendar tools")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in Calendar tools")
    }
}
struct Tasks {
    actor: Uuid,
    id: Uuid,
}
impl moss_calendar_host::References for Tasks {
    fn task(&self, scope: &CallScope, id: &str) -> anyhow::Result<Value> {
        Ok(
            if scope.access().actor_user_id() == self.actor && id == self.id.to_string() {
                json!({"task":{"id":id,"ownerUserId":self.actor,"title":"Live task title","status":"todo","dueAt":"2026-11-09T10:00:00.000Z","doAt":null,"effort":"medium"}})
            } else {
                json!({"task":null})
            },
        )
    }
    fn briefing_run(&self, scope: &CallScope, id: &str) -> anyhow::Result<Value> {
        Ok(
            if scope.access().actor_user_id() == self.actor && id == self.id.to_string() {
                json!({"run":{"id":id,"briefingType":"evening","status":"succeeded","createdAt":"2026-11-08T00:00:00.000Z"}})
            } else {
                json!({"run":null})
            },
        )
    }
}
struct Installed {
    f: Fixture,
    app: Application,
    _data: tempfile::TempDir,
    _registry: tempfile::TempDir,
    task: Uuid,
}
impl Installed {
    fn new() -> Self {
        let f = Fixture::new();
        f.rt.block_on(async {
            // Test binaries share the disposable database, but each owns a fresh temporary
            // package directory. Do not recover the preceding test's now-deleted artifacts.
            f.root.execute("DELETE FROM moss_modules.catalog", &[]).await.unwrap();
            assert_eq!(f.root.query_one("SELECT count(*) FROM moss_modules.catalog", &[]).await.unwrap().get::<_, i64>(0), 0);
            println!("PASS fresh disposable host catalog before signed package installation");
            if !f.root.query_one("SELECT to_regnamespace('moss_queue') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0) {
                f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
            }
            if !f.root.query_one("SELECT to_regclass('moss_modules.paused_modules') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0) {
                f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
            }
            f.root.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale','{\"timezone\":\"UTC\"}')",&[&f.a]).await.unwrap();
            f.root.execute("UPDATE app.day_plans SET local_day=(now() AT TIME ZONE 'UTC')::date WHERE id=$1",&[&f.plan]).await.unwrap();
            f.root.execute("UPDATE app.calendar_events SET starts_at=now()-interval '30 minutes',ends_at=now()+interval '30 minutes',title='Meeting 🪴 café' WHERE id=$1",&[&f.event]).await.unwrap();
        });
        let data = tempfile::tempdir().unwrap();
        let registry = tempfile::tempdir().unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let bytes = moss_calendar_host::package::pack(&root, &f.core()).unwrap();
        let (key, publisher, artifact) = registry::publish(registry.path(), &bytes);
        let database = f.db.clone();
        let task = Uuid::new_v4();
        let refs = Arc::new(Tasks {
            actor: f.a,
            id: task,
        });
        let app = Application::open_extended_with(
            data.path(),
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
                browser_dir: None,
            },
            move |next| {
                Ok(Arc::new(
                    moss_calendar_host::CalendarPorts::new(database, next)?.with_references(refs),
                ))
            },
        )
        .unwrap();
        let source = app
            .installer
            .refresh(
                &f.access(f.a),
                Source::Folder(registry.path().into()),
                &key,
                &publisher,
                "calendar-test-registry",
            )
            .unwrap();
        app.installer
            .install(&f.access(f.a), &source, &artifact, true)
            .unwrap();
        Self {
            f,
            app,
            _data: data,
            _registry: registry,
            task,
        }
    }
    fn call(&self, actor: Uuid, tool: &str, parameters: Value) -> Value {
        match self.app.installer.call(
            "calendar",
            self.f.access(actor),
            "tool",
            &json!({"tool":tool,"parameters":parameters}).to_string(),
        ) {
            Ok(result) => json!({"ok":serde_json::from_str::<Value>(&result).unwrap()}),
            Err(error) => json!({"error":error.to_string()}),
        }
    }
    fn oracle(&self, actor: Uuid, tool: &str, parameters: &Value) -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("pnpm")
            .args(["exec", "tsx", "modules/calendar/tools/tool-oracle.ts"])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"actor":actor,"tool":tool,"parameters":parameters,"tasks":[self.task]})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "TypeScript tool oracle failed (stderr omitted to avoid database diagnostics)"
        );
        let value: Value = serde_json::from_slice(&result.stdout)
            .expect("TypeScript oracle must return only a JSON result");
        // The shared host intentionally sanitizes every guest Err at runtime.rs:293.
        // Compare rejection outcomes here; message/status parity is explicitly deferred.
        if value.get("error").is_some() {
            json!({"error":"The module could not finish this request"})
        } else {
            value
        }
    }
    fn plan(&self) -> Value {
        self.plan_on(&chrono::Utc::now().format("%Y-%m-%d").to_string())
    }
    fn plan_on(&self, day: &str) -> Value {
        let result = self
            .app
            .installer
            .call(
                "calendar",
                self.f.access(self.f.a),
                "api",
                &json!({"name":"getPlan","parameters":{"localDay":day,"timeZone":"UTC"}})
                    .to_string(),
            )
            .unwrap();
        serde_json::from_str::<Value>(&result).unwrap()["plan"].clone()
    }
    fn compare_draft(&self, actor: Uuid, input: Value) {
        let before = self.plan();
        let expected = self.oracle(actor, "calendar.dayPlanDraft", &input);
        let mut actual = self.call(actor, "calendar.dayPlanDraft", input.clone());
        if expected.get("plan").is_some() {
            let mut plan = self.plan();
            let original = before["blocks"].as_array().unwrap();
            let mut index = 0;
            for block in plan["blocks"].as_array_mut().unwrap() {
                if !original.iter().any(|b| b["id"] == block["id"]) {
                    block["id"] = json!(format!("$new-{index}"));
                    index += 1;
                }
            }
            actual["plan"] = plan;
        } else {
            assert_eq!(
                self.plan(),
                before,
                "Rejected chat edit changed the stored draft"
            );
        }
        assert_eq!(actual, expected, "Draft tool differential: {input}");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_tools_match_production_typescript_and_keep_drafts_untimed() {
    let t = Installed::new();
    let f = &t.f;
    // Ordinary event reads include an explicit share; heartbeat reads must exclude it.
    f.rt.block_on(f.root.execute("INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('calendar_event',$1,$2,$3,'view')",&[&f.event,&f.a,&f.b])).unwrap();
    heartbeat_fault::witness(f);
    for actor in [f.a, f.b, f.admin] {
        for input in [
            json!({}),
            json!({"horizonHours":48,"limit":1}),
            json!({"limit":null}),
            json!({"actorUserId":f.a}),
            json!({"limit":21}),
        ] {
            let actual = t.call(actor, "calendar.heartbeatWindow", input.clone());
            assert_eq!(actual, t.oracle(actor, "calendar.heartbeatWindow", &input));
            if actor != f.a && actual.get("ok").is_some() {
                assert_eq!(actual["ok"]["data"]["items"], json!([]));
                assert_eq!(actual["ok"]["data"]["freshness"], "unknown");
            }
        }
    }
    // Two more events exercise the cap and the material revision's extra lookahead row.
    f.rt.block_on(f.root.execute("INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id) SELECT gen_random_uuid(),connector_account_id,owner_user_id,'Next 🪴',now()+interval '1 hour',now()+interval '2 hours','tool-next' FROM app.calendar_events WHERE id=$1",&[&f.event])).unwrap();
    let input = json!({"limit":1});
    assert_eq!(
        t.call(f.a, "calendar.heartbeatWindow", input.clone()),
        t.oracle(f.a, "calendar.heartbeatWindow", &input)
    );
    assert_eq!(
        t.call(f.a, "calendar.heartbeatWindow", input)["ok"]["data"]["truncated"],
        true
    );
    f.rt.block_on(f.root.execute(
        "UPDATE app.calendar_events SET updated_at=now()-interval '4 hours' WHERE owner_user_id=$1",
        &[&f.a],
    ))
    .unwrap();
    assert_eq!(
        t.call(f.a, "calendar.heartbeatWindow", json!({})),
        t.oracle(f.a, "calendar.heartbeatWindow", &json!({}))
    );
    assert_eq!(
        t.call(f.a, "calendar.heartbeatWindow", json!({}))["ok"]["data"]["freshness"],
        "stale"
    );

    for (actor, input) in [
        (f.b, json!({"planId":f.plan,"expectedRevision":1})),
        (f.admin, json!({"planId":f.plan,"expectedRevision":1})),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":1,"startsAt":null}),
        ),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":1,"additions":[{"taskId":t.task,"pendingChange":null}]}),
        ),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":1,"eveningIntent":{"notes":"Evening intent"}}),
        ),
        (f.a, json!({"planId":f.plan,"expectedRevision":1})),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":2,"additions":[{"taskId":t.task,"title":" Untimed work "}]}),
        ),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":3,"additions":[{"taskId":t.task}]}),
        ),
        (
            f.a,
            json!({"planId":f.plan,"expectedRevision":3,"additions":[{"taskId":Uuid::new_v4()}]}),
        ),
    ] {
        t.compare_draft(actor, input);
    }
    let saved = t.plan();
    assert_eq!(
        saved["blocks"][0]["actualPlacement"]["startsAt"],
        "2026-11-08T10:00:00Z"
    );
    assert_eq!(saved["blocks"][1]["pendingChange"], Value::Null);
    assert_eq!(saved["blocks"][1]["actualPlacement"], Value::Null);
    // Pick an actor day outside UTC's today/tomorrow window, at any hour of the day.
    let now = chrono::Utc::now();
    let utc_day = now.date_naive();
    let east = now
        .with_timezone(&chrono::FixedOffset::east_opt(14 * 3600).unwrap())
        .date_naive();
    let (zone, day) = if east > utc_day {
        ("Pacific/Kiritimati", east.succ_opt().unwrap())
    } else {
        (
            "Etc/GMT+12",
            now.with_timezone(&chrono::FixedOffset::west_opt(12 * 3600).unwrap())
                .date_naive(),
        )
    };
    assert!(day < utc_day || day > utc_day.succ_opt().unwrap());
    f.rt.block_on(async {
        f.root
            .execute(
                "UPDATE app.preferences SET value_json=$2 WHERE owner_user_id=$1 AND key='locale'",
                &[&f.a, &json!({"timezone":zone})],
            )
            .await
            .unwrap();
        f.root
            .execute(
                "UPDATE app.day_plans SET local_day=$2::text::date WHERE id=$1",
                &[&f.plan, &day.to_string()],
            )
            .await
            .unwrap();
    });
    let input = json!({"planId":f.plan,"expectedRevision":3});
    let expected = t.oracle(f.a, "calendar.dayPlanDraft", &input);
    let mut actual = t.call(f.a, "calendar.dayPlanDraft", input);
    assert!(
        actual.get("ok").is_some(),
        "Saved actor timezone was ignored"
    );
    actual["plan"] = t.plan_on(&day.to_string());
    assert_eq!(actual, expected);
    // An old plan is rejected even at the current revision.
    f.rt.block_on(f.root.execute(
        "UPDATE app.day_plans SET local_day=(now() AT TIME ZONE 'UTC')::date-2 WHERE id=$1",
        &[&f.plan],
    ))
    .unwrap();
    let input = json!({"planId":f.plan,"expectedRevision":4});
    assert_eq!(
        t.call(f.a, "calendar.dayPlanDraft", input.clone()),
        t.oracle(f.a, "calendar.dayPlanDraft", &input)
    );
    println!("PASS real signed Calendar Wasm tools against production TypeScript: success values and rejection/rollback outcomes for owned heartbeat, shared-event exclusion, freshness, cap, Unicode revision, private drafts, conflicts, untimed additions and timing keys. Host sanitizes errors; messages/statuses are not compared. Public Tasks lookup is a test stand-in; no UI/provider/device claim.");
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_cache_evict_job_removes_only_the_actors_own_event() {
    let t = Installed::new();
    let f = &t.f;
    // Production runs this job on the worker role, which alone holds DELETE (SQL 0113).
    // This disposable database gives the app role the simpler owner-only delete rule (production also requires a calendar connector account, SQL 0113) so
    // the guest's own visibility check and the database rule are both exercised. Real
    // worker-role dispatch belongs to the host job runner and is not proven here.
    f.rt.block_on(f.root.batch_execute(
        "GRANT DELETE ON app.calendar_events TO jarvis_app_runtime;
         CREATE POLICY calendar_events_delete_standin ON app.calendar_events FOR DELETE
         TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id())",
    ))
    .unwrap();
    let job = |actor: Uuid| {
        let payload =
            json!({"queue":"calendar-cache-evict-event","parameters":{"target-item-id":f.event}});
        t.app
            .installer
            .call("calendar", f.access(actor), "job", &payload.to_string())
            .map(|out| serde_json::from_str::<Value>(&out).unwrap())
    };
    let count = || {
        f.rt.block_on(f.root.query_one(
            "SELECT count(*) FROM app.calendar_events WHERE id=$1",
            &[&f.event],
        ))
        .unwrap()
        .get::<_, i64>(0)
    };
    // Another user and an administrator cannot evict, or even detect, the owner's event.
    for actor in [f.b, f.admin] {
        assert_eq!(job(actor).unwrap(), json!({"evicted":false}));
        assert_eq!(count(), 1, "a foreign job removed private data");
    }
    assert_eq!(job(f.a).unwrap(), json!({"evicted":true}));
    assert_eq!(count(), 0);
    assert_eq!(job(f.a).unwrap(), json!({"evicted":false}));
    println!("PASS installed Calendar cache-evict job: owner removes own event; other user and administrator cannot; repeat is a no-op");
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_saved_reads_match_production_envelopes_and_public_summaries() {
    let t = Installed::new();
    let f = &t.f;
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    f.rt.block_on(async {
        f.root.execute("UPDATE app.day_plans SET source_run_id=$2,evening_intent=$3 WHERE id=$1",&[&f.plan,&t.task,&json!({
            "priorityTaskIds":[t.task,f.event],"corrections":[{"taskId":t.task,"note":"Keep","source":"actor"}],
            "commitments":[{"taskId":f.event,"decision":"defer"}]
        })]).await.unwrap();
        f.root.execute("UPDATE app.day_plan_blocks SET task_id=$2 WHERE id=$1",&[&f.block,&t.task]).await.unwrap();
    });
    let path = format!("/day-plan?date={day}&timeZone=UTC");
    let paths = [path.as_str(), "/day-plan?date=2035-01-01&timeZone=UTC"];
    let tasks = json!({t.task.to_string():{"ownerUserId":f.a,"title":"Live task title","status":"todo","dueAt":"2026-11-09T10:00:00.000Z","doAt":null,"effort":"medium"}});
    let runs = json!({t.task.to_string():{"ownerUserId":f.a,"briefingType":"evening","status":"succeeded","createdAt":"2026-11-08T00:00:00.000Z"}});
    let mut comparisons = 0;
    for missing_source in [false, true] {
        if missing_source {
            f.rt.block_on(f.root.execute(
                "UPDATE app.day_plans SET source_run_id=$2 WHERE id=$1",
                &[&f.plan, &f.event],
            ))
            .unwrap();
        }
        for actor in [f.a, f.b, f.admin] {
            let mut child = Command::new("pnpm")
                .args(["exec", "tsx", "modules/calendar/tools/saved-read-oracle.ts"])
                .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(json!({"actor":actor,"tasks":tasks,"runs":runs,
                "requests":paths.iter().map(|p|json!({"method":"GET","url":format!("/api/calendar{p}")})).collect::<Vec<_>>()
            }).to_string().as_bytes()).unwrap();
            let result = child.wait_with_output().unwrap();
            assert!(
                result.status.success(),
                "Saved-read production oracle failed (database diagnostics omitted)"
            );
            let expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(expected.len(), paths.len());
            for (path, expected) in paths.iter().zip(expected) {
                let raw = t
                    .app
                    .dispatch_extended(
                        f.access(actor),
                        "GET",
                        &format!("/api/m/calendar{path}"),
                        "null",
                    )
                    .unwrap();
                let actual: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(
                    actual, expected,
                    "Installed saved-read response differs from production"
                );
                comparisons += 1;
            }
        }
    }
    println!("PASS {comparisons} installed saved-plan/production comparisons: owner, foreign, admin, empty day, deduplicated live task summaries and present/missing source summaries (public adapters are stand-ins)");
}
