//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{Host, Limits},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-7d2e41";

/// Wellness declares no model port. This stub only satisfies the host's configuration.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Wellness does not call a model")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Wellness does not embed")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("WELLNESS_COMPONENT_WASM")
            .expect("Run modules/wellness/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Reads as the app role with the actor set, so row security applies as it does at run time.
fn rows_as(f: &support::Fixture, actor: uuid::Uuid, sql: &str) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) = tokio_postgres::connect(
            &std::env::var("JS48_APP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.execute(
            "SELECT set_config('app.actor_user_id', $1, true)",
            &[&actor.to_string()],
        )
        .await
        .unwrap();
        let rows = tx.query(sql, &[]).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
}

struct World {
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            let ready = f
                .root
                .query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[])
                .await
                .unwrap()
                .get::<_, bool>(0);
            if !ready {
                f.root
                    .batch_execute(moss_platform_jobs::MIGRATION)
                    .await
                    .unwrap();
                f.root
                    .batch_execute(moss_module_host::jobs::MIGRATION)
                    .await
                    .unwrap();
            }
        });
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[]))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_wellness_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(NoModel),
                version: "0.1.0".parse().unwrap(),
                browser_dir: None,
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
            |next| {
                let database = f.db.clone();
                Ok(Arc::new(
                    moss_module_host::account_preferences::AccountPreferencesPorts::new(
                        database,
                        moss_module_host::account_preferences::wellness_bindings(),
                        next,
                    )?,
                ))
            },
        )
        .unwrap();
        let source = app
            .installer
            .refresh(
                &f.access(f.a),
                Source::Folder(reg.path().into()),
                &key,
                &publisher,
                "wellness-test-registry",
            )
            .unwrap();
        app.installer
            .install(&f.access(f.a), &source, &artifact, true)
            .unwrap();
        Self {
            f,
            app,
            _dirs: (dir, reg),
        }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(
                    self.f.access(actor),
                    method,
                    &format!("/api/m/wellness{path}"),
                    &body.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    }
    fn add_user(&self) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Well Parity',false)",
            &[&id, &format!("{id}@example.test")],
        )).unwrap();
        id
    }
}

fn set_policy(w: &World, using: &str) {
    w.f.rt
        .block_on(w.f.root.execute(
            "DROP POLICY wellness_checkins_select ON app.wellness_checkins",
            &[],
        ))
        .unwrap();
    w.f.rt
        .block_on(w.f.root.execute(
            &format!("CREATE POLICY wellness_checkins_select ON app.wellness_checkins FOR SELECT TO jarvis_app_runtime USING ({using})"),
            &[],
        ))
        .unwrap();
}

#[test]
#[ignore = "Only through verify-gate"]
fn check_ins_stay_private_and_a_second_person_is_refused() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let created = w.call(
        a,
        "POST",
        "/wellness/checkins",
        json!({"feelingCore":"happy","feelingSecondary":"Joy","note":MARK,"intensity":4}),
    );
    assert_eq!(created["status"], 201, "{created}");
    let id = created["body"]["checkin"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["body"]["checkin"]["ownerUserId"], a.to_string());

    let list = w.call(a, "GET", "/wellness/checkins", json!(null));
    assert_eq!(list["body"]["checkins"].as_array().unwrap().len(), 1);

    // The second person sees nothing, through the routes or the database.
    let theirs = w.call(b, "GET", "/wellness/checkins", json!(null));
    assert_eq!(theirs["body"]["checkins"], json!([]));
    let changed = w.call(
        b,
        "PATCH",
        &format!("/wellness/checkins/{id}"),
        json!({"feelingCore":"happy","note":"stolen"}),
    );
    assert_eq!(changed["status"], 404, "{changed}");
    assert!(rows_as(&w.f, b, "SELECT id FROM app.wellness_checkins").is_empty());
    assert_eq!(
        rows_as(&w.f, a, "SELECT id FROM app.wellness_checkins").len(),
        1
    );
    println!("PASS rls: the second person reads no check-ins and changes none");

    // With the owner rule removed, the second person can read the row. The rule is put back.
    set_policy(&w, "true");
    let leaked = rows_as(&w.f, b, "SELECT id FROM app.wellness_checkins");
    set_policy(&w, "owner_user_id = app.current_actor_user_id()");
    // The database also holds rows from earlier runs, so look for this run's row by id.
    assert!(
        leaked.iter().any(|row| row.get::<_, uuid::Uuid>(0).to_string() == id),
        "without the policy the second person must see the check-in"
    );
    assert!(rows_as(&w.f, b, "SELECT id FROM app.wellness_checkins").is_empty());
    println!("PASS rls: removing the policy lets the second person in, restoring it shuts them out");

    // The saved choice is per person.
    let first = w.call(a, "GET", "/wellness/ai-consent", json!(null));
    assert_eq!(first["body"], json!({"effective":true,"explicit":null}));
    let off = w.call(a, "PUT", "/wellness/ai-consent", json!({"granted":false}));
    assert_eq!(off["body"], json!({"effective":false,"explicit":false}));
    assert_eq!(
        w.call(b, "GET", "/wellness/ai-consent", json!(null))["body"],
        json!({"effective":true,"explicit":null})
    );
    println!("PASS consent: one person's choice does not change another's");

    // The note reaches no job payload, no activity row and no other person's answer.
    let jobs: i64 =
        w.f.rt
            .block_on(w.f.root.query_one(
                "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
                &[&format!("%{MARK}%")],
            ))
            .unwrap()
            .get(0);
    assert_eq!(jobs, 0);
    // The activity log records only calls to service ports. Wellness makes none, so the log is
    // empty today, and this check guards against check-in text ever entering it.
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(
            &w.app.services.activity("wellness", &w.f.access(actor)).unwrap(),
        )
        .unwrap();
        assert!(!activity.contains(MARK), "activity holds check-in text");
        assert!(!activity.contains("stolen"));
    }
    assert!(!w
        .call(b, "GET", "/wellness/checkins", json!(null))
        .to_string()
        .contains(MARK));
    println!("PASS privacy: the note is in no job payload, no activity row and no second-person answer");
    let _ = Host::new(Limits::default()).unwrap();
    let _ = AccessContext::new(a, "wellness-proof");
}

#[test]
#[ignore = "Only through verify-gate"]
fn rust_answers_match_the_old_routes_step_for_step() {
    let w = World::new();
    let old_actor = w.add_user();
    let new_actor = w.add_user();
    let missing = "99999999-9999-4999-8999-999999999999";
    let steps: Vec<Value> = vec![
        json!({"method":"GET","url":"/api/wellness/ai-consent"}),
        json!({"method":"PUT","url":"/api/wellness/ai-consent","body":{"granted":false}}),
        json!({"method":"PUT","url":"/api/wellness/ai-consent","body":{"granted":"yes"}}),
        json!({"method":"PUT","url":"/api/wellness/ai-consent","body":{}}),
        json!({"method":"GET","url":"/api/wellness/ai-consent"}),
        json!({"method":"GET","url":"/api/wellness/checkins"}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","feelingSecondary":"Joy","sensations":["warm"],"intensity":4,"energy":3,"note":"fine"}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"sad"}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"nope"}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","feelingSecondary":"Fear"}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","intensity":11}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","energy":0}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","sensations":"tight"}}),
        json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","identifiedVia":"wheel"}}),
        json!({"method":"GET","url":"/api/wellness/checkins"}),
        json!({"method":"GET","url":"/api/wellness/checkins?limit=2"}),
        json!({"method":"GET","url":"/api/wellness/checkins?limit=0"}),
        json!({"method":"GET","url":"/api/wellness/checkins?limit=501"}),
        json!({"method":"GET","url":"/api/wellness/checkins?since=soon"}),
        json!({"method":"GET","url":"/api/wellness/checkins?cursor=not-a-cursor"}),
        json!({"method":"PATCH","url":format!("/api/wellness/checkins/{missing}"),"body":{"note":"x"}}),
    ];
    let old = replay::old_routes(old_actor, &steps, &json!({}));
    let mut new = vec![];
    for step in &steps {
        let method = step["method"].as_str().unwrap();
        let url = step["url"]
            .as_str()
            .unwrap()
            .replace("/api/wellness", "/wellness");
        let body = step.get("body").cloned().unwrap_or(json!(null));
        let answer = w.call(new_actor, method, &url, body);
        new.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    let (mut old, mut new) = (old, new);
    old.iter_mut().for_each(replay::mask);
    new.iter_mut().for_each(replay::mask);
    for (n, (o, r)) in old.iter().zip(&new).enumerate() {
        assert_eq!(r, o, "step {n}: {}", steps[n]);
    }
    println!("PASS parity: {} steps match the old routes", steps.len());

    // Steps that use a created check-in's id, run on each side with its own id.
    let seed = json!({"method":"POST","url":"/api/wellness/checkins","body":{"feelingCore":"happy","feelingSecondary":"Joy","note":"keep","energy":2}});
    let old_id = replay::old_routes(old_actor, &[seed.clone()], &json!({}))[0]["body"]["checkin"]
        ["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let new_id = w.call(new_actor, "POST", "/wellness/checkins", seed["body"].clone())["body"]
        ["checkin"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id_steps: Vec<Value> = vec![
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{"feelingCore":"happy","intensity":5}}),
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{"feelingCore":"sad"}}),
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{"feelingCore":"sad","feelingSecondary":null}}),
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{"feelingCore":"happy","note":null,"energy":null}}),
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{"feelingCore":"happy","intensity":99}}),
        json!({"method":"PATCH","url":"/api/wellness/checkins/{id}","body":{}}),
        json!({"method":"GET","url":"/api/wellness/checkins?limit=1"}),
    ];
    let mut old = replay::old_routes(old_actor, &id_steps, &json!({"id":old_id}));
    let mut new = vec![];
    for step in &id_steps {
        let method = step["method"].as_str().unwrap();
        let url = step["url"]
            .as_str()
            .unwrap()
            .replace("/api/wellness", "/wellness")
            .replace("{id}", &new_id);
        let answer = w.call(new_actor, method, &url, step["body"].clone());
        new.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    old.iter_mut().for_each(replay::mask);
    new.iter_mut().for_each(replay::mask);
    for (n, (o, r)) in old.iter().zip(&new).enumerate() {
        assert_eq!(r, o, "id step {n}: {}", id_steps[n]);
    }
    println!("PASS parity: {} id steps match the old routes", id_steps.len());
}

/// A person's medicines and doses stay theirs. Row security is seen failing with the rule removed.
fn set_medication_policy(w: &World, table: &str, policy: &str, using: &str) {
    w.f.rt
        .block_on(w.f.root.execute(&format!("DROP POLICY {policy} ON app.{table}"), &[]))
        .unwrap();
    w.f.rt
        .block_on(w.f.root.execute(
            &format!("CREATE POLICY {policy} ON app.{table} FOR SELECT TO jarvis_app_runtime USING ({using})"),
            &[],
        ))
        .unwrap();
}

#[test]
#[ignore = "Only through verify-gate"]
fn medicines_and_doses_stay_private_and_a_second_person_is_refused() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let made = w.call(
        a,
        "POST",
        "/wellness/medications",
        json!({"name":MARK,"dosage":MARK,"notes":MARK,"frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}),
    );
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["medication"]["id"].as_str().unwrap().to_owned();
    let dose = w.call(
        a,
        "POST",
        &format!("/wellness/medications/{id}/logs"),
        json!({"status":"taken","scheduledFor":"2026-03-15T08:00:00.000Z","dose":MARK}),
    );
    assert_eq!(dose["status"], 201, "{dose}");

    // The second person sees nothing and changes nothing, through the routes or the database.
    assert_eq!(w.call(b, "GET", "/wellness/medications", json!(null))["body"]["medications"], json!([]));
    let day = w.call(b, "GET", "/wellness/medications/schedule?date=2026-03-15", json!(null));
    assert_eq!(day["body"]["slots"], json!([]));
    let patched = w.call(b, "PATCH", &format!("/wellness/medications/{id}"), json!({"name":"stolen"}));
    assert_eq!(patched["status"], 404, "{patched}");
    let logged = w.call(
        b,
        "POST",
        &format!("/wellness/medications/{id}/logs"),
        json!({"status":"taken","scheduledFor":"2026-03-16T08:00:00.000Z"}),
    );
    assert_eq!(logged["status"], 404, "{logged}");
    for table in ["medications", "medication_logs"] {
        assert!(rows_as(&w.f, b, &format!("SELECT id FROM app.{table}")).is_empty(), "{table}");
        assert_eq!(rows_as(&w.f, a, &format!("SELECT id FROM app.{table}")).len(), 1, "{table}");
    }
    println!("PASS rls: the second person reads no medicines or doses and changes none");

    // With each owner rule removed, the second person reads the rows. The rules are put back.
    let rule = "owner_user_id = app.current_actor_user_id()";
    for (table, policy) in [("medications", "medications_select"), ("medication_logs", "medication_logs_select")] {
        set_medication_policy(&w, table, policy, "true");
        let leaked = rows_as(&w.f, b, &format!("SELECT id FROM app.{table}"));
        set_medication_policy(&w, table, policy, rule);
        assert!(!leaked.is_empty(), "without the rule on {table} the second person must see its rows");
        assert!(rows_as(&w.f, b, &format!("SELECT id FROM app.{table}")).is_empty());
    }
    println!("PASS rls: removing each rule lets the second person in, restoring it shuts them out");

    // The text reaches no job payload, no activity row and no other person's answer.
    let jobs: i64 = w.f.rt
        .block_on(w.f.root.query_one(
            "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1",
            &[&format!("%{MARK}%")],
        ))
        .unwrap()
        .get(0);
    assert_eq!(jobs, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("wellness", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK), "activity holds medication text");
        assert!(!activity.contains("stolen"));
    }
    for path in ["/wellness/medications", "/wellness/medications/logs"] {
        assert!(!w.call(b, "GET", path, json!(null)).to_string().contains(MARK));
    }
    println!("PASS privacy: medication text is in no job payload, no activity row and no second-person answer");
}

fn run_both(w: &World, old: uuid::Uuid, new: uuid::Uuid, steps: &[Value], old_vars: &Value, new_vars: &Value) {
    let mut old_answers = replay::old_routes(old, steps, old_vars);
    let mut new_answers = vec![];
    for step in steps {
        let mut url = step["url"].as_str().unwrap().replace("/api/wellness", "/wellness");
        for (name, value) in new_vars.as_object().unwrap() {
            url = url.replace(&format!("{{{name}}}"), value.as_str().unwrap());
        }
        let answer = w.call(new, step["method"].as_str().unwrap(), &url, step.get("body").cloned().unwrap_or(json!(null)));
        new_answers.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    // Moments are compared as written before they are masked, because masking hides their shape.
    let moments = |answers: &[Value]| -> Vec<Value> {
        answers.iter().map(|a| json!([a["body"]["log"]["scheduledFor"], a["body"]["slots"].as_array().map(|s| s.iter().map(|x| x["scheduledFor"].clone()).collect::<Vec<_>>())])).collect()
    };
    assert_eq!(moments(&new_answers), moments(&old_answers), "scheduled moments differ");
    old_answers.iter_mut().for_each(replay::mask);
    new_answers.iter_mut().for_each(replay::mask);
    // Every difference is listed at once, so one run shows them all.
    let differences: Vec<String> = old_answers
        .iter()
        .zip(&new_answers)
        .enumerate()
        .filter(|(_, (o, r))| o != r)
        .map(|(n, (o, r))| format!("step {n}: {}\n  old: {o}\n  new: {r}", steps[n]))
        .collect();
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[test]
#[ignore = "Only through verify-gate"]
fn rust_medications_match_the_old_routes_step_for_step() {
    let w = World::new();
    let (old, new) = (w.add_user(), w.add_user());
    let create = |body: Value| json!({"method":"POST","url":"/api/wellness/medications","body":body});
    let kinds = [
        json!({"name":"Daily","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"],"dosage":" 5 mg ","form":"tablet","notes":"with food"}),
        json!({"name":"Twice","frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00","20:30"],"remindersEnabled":true}),
        json!({"name":"Days","frequencyType":"specific_weekdays","weekdays":[1,3,5],"timesPerDay":1,"scheduleTimes":["09:15"]}),
        json!({"name":"Hours","frequencyType":"every_n_hours","intervalHours":6,"timesPerDay":4,"scheduleTimes":["05:30"]}),
        json!({"name":"Prn","frequencyType":"as_needed"}),
        json!({"name":"Cycle","frequencyType":"cyclical","cycleDaysOn":3,"cycleDaysOff":2,"cycleAnchorDate":"2026-03-01","timesPerDay":1,"scheduleTimes":["10:00"]}),
        json!({"name":"Every","frequencyType":"every_interval","intervalUnit":"weeks","intervalCount":2,"weekdays":[7],"startDate":"2026-03-01","timesPerDay":1,"scheduleTimes":["07:00"]}),
        json!({"name":"Monthly","frequencyType":"monthly","monthKind":"weekdayPosition","monthWeekdayPosition":"third","monthWeekday":7,"startDate":"2026-01-01","timesPerDay":1,"scheduleTimes":["18:00"]}),
        json!({"name":"Last","frequencyType":"monthly","monthKind":"date","monthDayIsLast":true,"startDate":"2026-01-01","endDate":"2026-12-31","timesPerDay":1,"scheduleTimes":["06:00"]}),
    ];
    let mut steps: Vec<Value> = kinds.iter().cloned().map(create).collect();
    let bad = [
        json!({}),
        json!({"name":"x"}),
        json!({"name":"x","frequencyType":"hourly"}),
        json!({"name":"x","frequencyType":"once_daily"}),
        json!({"name":"x","frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"every_n_hours"}),
        json!({"name":"x","frequencyType":"specific_weekdays","weekdays":[0],"scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"cyclical","scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"every_interval","scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"every_interval","intervalUnit":"days","intervalCount":1,"startDate":"2026-02-30","scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"monthly","monthKind":"date","startDate":"2026-01-01","scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"as_needed","remindersEnabled":true}),
        json!({"name":"x","frequencyType":"as_needed","scheduleTimes":["08:00"]}),
        json!({"name":"x","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"],"startDate":null}),
        json!({"name":"  ","frequencyType":"as_needed"}),
    ];
    steps.extend(bad.into_iter().map(create));
    steps.push(json!({"method":"GET","url":"/api/wellness/medications"}));
    run_both(&w, old, new, &steps, &json!({}), &json!({}));
    println!("PASS parity: {} create and list steps match the old routes", steps.len());

    // Steps that use created medicines run on each side with its own ids.
    let ids = |who: uuid::Uuid, old_side: bool| -> Value {
        let listed = if old_side {
            replay::old_routes(who, &[json!({"method":"GET","url":"/api/wellness/medications"})], &json!({}))[0]["body"].clone()
        } else {
            w.call(who, "GET", "/wellness/medications", json!(null))["body"].clone()
        };
        let by = |name: &str| listed["medications"].as_array().unwrap().iter().find(|m| m["name"] == name).unwrap()["id"].clone();
        json!({"daily":by("Daily"),"twice":by("Twice"),"hours":by("Hours"),"prn":by("Prn"),"every":by("Every")})
    };
    let (old_ids, new_ids) = (ids(old, true), ids(new, false));
    let day = |d: &str| json!({"method":"GET","url":format!("/api/wellness/medications/schedule?date={d}")});
    let dose = |who: &str, body: Value| json!({"method":"POST","url":format!("/api/wellness/medications/{{{who}}}/logs"),"body":body});
    let patch = |who: &str, body: Value| json!({"method":"PATCH","url":format!("/api/wellness/medications/{{{who}}}"),"body":body});
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let missing = "99999999-9999-4999-8999-999999999999";
    let steps: Vec<Value> = vec![
        day("2026-03-15"),
        day("2026-03-16"),
        day("2026-03-29"),
        day("2026-03-08"),
        day("2026-03-21"),
        day("2026-02-28"),
        day("2026-12-31"),
        day("2026-10-19"),
        day("2026-03-08"),
        json!({"method":"GET","url":"/api/wellness/medications/schedule"}),
        day("soon"),
        dose("daily", json!({"status":"taken","scheduledFor":"2026-03-15T08:00:00.000Z"})),
        dose("daily", json!({"status":"skipped","scheduledFor":"2026-03-15T08:00:00.000Z"})),
        dose("twice", json!({"status":"taken","scheduledFor":"2026-03-15T20:30:00Z","dose":"1"})),
        dose("hours", json!({"status":"taken","scheduledFor":"2026-03-15T11:30:00.000Z"})),
        dose("prn", json!({"status":"prn","prnReason":"headache","dose":"200 mg"})),
        dose("prn", json!({"status":"prn"})),
        dose("prn", json!({"status":"prn","prnReason":"x","scheduledFor":"2026-03-15T08:00:00.000Z"})),
        dose("daily", json!({"status":"taken"})),
        dose("daily", json!({"status":"prn"})),
        dose("daily", json!({"status":"maybe"})),
        dose("daily", json!({})),
        dose("every", json!({"status":"taken","scheduledFor":"2026-03-15T07:00:00.000Z"})),
        json!({"method":"POST","url":format!("/api/wellness/medications/{missing}/logs"),"body":{"status":"taken","scheduledFor":"2026-03-15T08:00:00.000Z"}}),
        day("2026-03-15"),
        day("2026-03-14"),
        day("2026-03-16"),
        dose("daily", json!({"status":"taken","scheduledFor":format!("{today}T08:00:00.000Z")})),
        dose("prn", json!({"status":"prn","prnReason":"today"})),
        json!({"method":"GET","url":"/api/wellness/medications/logs"}),
        json!({"method":"GET","url":"/api/wellness/medications/logs?sinceDays=7"}),
        json!({"method":"GET","url":"/api/wellness/medications/logs?sinceDays=90"}),
        json!({"method":"GET","url":"/api/wellness/medications/logs?sinceDays=0"}),
        json!({"method":"GET","url":"/api/wellness/medications/logs?sinceDays=91"}),
        json!({"method":"GET","url":"/api/wellness/medications/logs?sinceDays=x"}),
        patch("daily", json!({"name":"Renamed","active":false})),
        day("2026-03-15"),
        patch("daily", json!({"active":true,"dosage":null,"form":null,"notes":null})),
        patch("daily", json!({"frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["07:00","19:00"]})),
        patch("daily", json!({"frequencyType":"as_needed"})),
        patch("daily", json!({"remindersEnabled":true})),
        patch("twice", json!({"remindersEnabled":false})),
        patch("twice", json!({"frequencyType":"every_n_hours"})),
        patch("twice", json!({})),
        patch("twice", json!({"name":""})),
        json!({"method":"PATCH","url":format!("/api/wellness/medications/{missing}"),"body":{"name":"x"}}),
        json!({"method":"GET","url":"/api/wellness/medications"}),
    ];
    run_both(&w, old, new, &steps, &old_ids, &new_ids);
    println!("PASS parity: {} schedule, dose, summary and change steps match the old routes", steps.len());
}
