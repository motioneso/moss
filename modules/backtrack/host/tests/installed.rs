//! Real installed-package proofs. Run only through scripts/run-gate.sh.
mod support;
use safety_core::db::DataContext;
use safety_core::secret::Secret;
use serde_json::{json, Value};
use support::{install::Installed, Fixture};
use uuid::Uuid;

const MARK: &str = "PLANTED-SCREEN-MARKER-4f1c9b";
const LEAK: &str = "PLANTED-LEAK-MARKER-7e2d51";

struct World {
    f: Fixture,
    app: Installed,
}
impl World {
    fn new() -> Self {
        let f = Fixture::new();
        let app = support::install::install(&f);
        // Instance switch on, as an admin would set it.
        f.rt.block_on(f.root.execute(
            "INSERT INTO app.instance_settings(key,value) VALUES('backtrack.storage','{\"value\":\"on\"}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
            &[],
        ))
        .unwrap();
        World { f, app }
    }
    fn link(&self, owner: Uuid) -> Uuid {
        let device = Uuid::new_v4();
        self.app.macs.0.lock().unwrap().insert(owner, device);
        device
    }
    fn call(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/backtrack{path}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {path}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    fn count(&self, sql: &str, owner: Uuid) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[&owner])).unwrap().get(0)
    }
    fn segments(&self, owner: Uuid) -> i64 {
        self.count("SELECT count(*) FROM app.backtrack_segments WHERE owner_user_id=$1", owner)
    }
    /// What `actor` can read straight from a table through their own row policies.
    fn visible(&self, actor: Uuid, table: &str) -> i64 {
        self.f.rt.block_on(async {
            let cx = DataContext::open(&self.f.db, &self.f.access(actor)).await.unwrap();
            cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0)
        })
    }
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}
fn stamp(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn segment(minutes_ago: i64, body: &str) -> Value {
    let start = now() - chrono::Duration::minutes(minutes_ago + 5);
    let end = now() - chrono::Duration::minutes(minutes_ago);
    json!({"startedAt": stamp(start), "endedAt": stamp(end), "appName": "Safari", "bundleId": "com.apple.Safari",
        "windowTitle": format!("Title {body}"), "address": "https://example.test/a", "body": body})
}
fn upload(segments: Vec<Value>) -> Value {
    json!({"sentAt": stamp(now()), "segments": segments})
}

#[test]
#[ignore = "Only through verify-gate"]
fn each_person_sees_and_deletes_only_their_own_text() {
    let w = World::new();
    w.link(w.f.a);
    w.link(w.f.b);
    assert_eq!(w.call(w.f.a, "POST", "/ingest", upload(vec![segment(30, &format!("alpha {MARK}"))]))["body"]["accepted"], 1);
    assert_eq!(w.call(w.f.b, "POST", "/ingest", upload(vec![segment(30, "beta")]))["body"]["accepted"], 1);
    let a = w.call(w.f.a, "GET", "/status", Value::Null);
    let b = w.call(w.f.b, "GET", "/status", Value::Null);
    assert_eq!((a["body"]["days"].clone(), b["body"]["days"].clone(), a["body"]["storage"].clone()), (json!(1), json!(1), json!("on")));

    // B deletes everything. A keeps theirs.
    assert_eq!(w.call(w.f.b, "DELETE", "/segments", Value::Null)["body"]["deleted"], 1);
    assert_eq!((w.segments(w.f.a), w.segments(w.f.b)), (1, 0));
    // An admin who is neither A nor B sees nothing of either.
    for table in ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"] {
        assert_eq!(w.visible(w.f.admin, table), 0, "{table}");
    }
    assert_eq!(w.call(w.f.admin, "GET", "/status", Value::Null)["body"]["days"], 0);

    // The same checks must fail with row security removed, then pass once restored.
    w.call(w.f.a, "PUT", "/preferences", json!({"paused": true}));
    for table in ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"] {
        assert_eq!(w.visible(w.f.b, table) , if table == "app.backtrack_deletions" { 1 } else { 0 }, "{table} before");
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open = w.visible(w.f.admin, table);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(open > 0, "RED expected: {table} shows other people's rows with row security removed");
        println!("RED {table}: another person sees {open} row(s) with row security removed");
        assert_eq!(w.visible(w.f.admin, table), 0, "{table} after restore");
        println!("GREEN {table}: row security restored");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn pause_stores_nothing_and_resume_stores_again() {
    let w = World::new();
    w.link(w.f.a);
    assert_eq!(w.call(w.f.a, "PUT", "/preferences", json!({"paused": true}))["body"], json!({"paused": true}));
    let r = w.call(w.f.a, "POST", "/ingest", upload(vec![segment(10, MARK)]));
    assert_eq!((r["status"].clone(), r["body"]["code"].clone()), (json!(409), json!("backtrack_paused")));
    assert_eq!(w.segments(w.f.a), 0);
    w.call(w.f.a, "PUT", "/preferences", json!({"paused": false}));
    assert_eq!(w.call(w.f.a, "POST", "/ingest", upload(vec![segment(10, "again")]))["body"]["accepted"], 1);
    // Pausing for A does not pause B.
    w.link(w.f.b);
    w.call(w.f.a, "PUT", "/preferences", json!({"paused": true}));
    assert_eq!(w.call(w.f.b, "POST", "/ingest", upload(vec![segment(10, "b")]))["body"]["accepted"], 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn storage_off_unlinked_and_clock_errors_use_their_codes_and_store_nothing() {
    let w = World::new();
    let r = w.call(w.f.a, "POST", "/ingest", upload(vec![segment(10, MARK)]));
    assert_eq!((r["status"].clone(), r["body"]["code"].clone()), (json!(401), json!("companion_credential_invalid")));
    w.link(w.f.a);
    let skewed = json!({"sentAt": stamp(now() - chrono::Duration::hours(2)), "segments": [segment(10, MARK)]});
    let r = w.call(w.f.a, "POST", "/ingest", skewed);
    assert_eq!((r["status"].clone(), r["body"]["code"].clone()), (json!(422), json!("backtrack_clock")));
    w.f.rt.block_on(w.f.root.execute("UPDATE app.instance_settings SET value='{\"value\":\"off\"}'::jsonb WHERE key='backtrack.storage'", &[])).unwrap();
    let r = w.call(w.f.a, "POST", "/ingest", upload(vec![segment(10, MARK)]));
    assert_eq!((r["status"].clone(), r["body"]["code"].clone()), (json!(409), json!("backtrack_unavailable")));
    // Delete still works with storage off and no Mac.
    assert_eq!(w.call(w.f.a, "DELETE", "/segments", Value::Null)["status"], 200);
    assert_eq!(w.segments(w.f.a), 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_replayed_upload_and_a_late_pre_delete_upload_add_nothing() {
    let w = World::new();
    w.link(w.f.a);
    let batch = upload(vec![segment(40, "one"), segment(30, "two")]);
    assert_eq!(w.call(w.f.a, "POST", "/ingest", batch.clone())["body"]["accepted"], 2);
    let again = w.call(w.f.a, "POST", "/ingest", batch.clone());
    assert_eq!((again["body"]["accepted"].clone(), again["body"]["duplicates"].clone()), (json!(0), json!(2)));
    assert_eq!(w.segments(w.f.a), 2);
    // Delete everything, then the lost-response retry arrives: discarded, not stored.
    assert_eq!(w.call(w.f.a, "DELETE", "/segments", Value::Null)["body"]["deleted"], 2);
    let late = w.call(w.f.a, "POST", "/ingest", batch);
    assert_eq!((late["body"]["accepted"].clone(), late["body"]["discarded"].clone()), (json!(0), json!(2)));
    // A capture that starts after the delete is kept.
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let mut fresh = segment(0, "fresh");
    fresh["startedAt"] = json!(stamp(now() - chrono::Duration::milliseconds(500)));
    assert_eq!(w.call(w.f.a, "POST", "/ingest", upload(vec![fresh]))["body"]["accepted"], 1);
    // A range delete only discards what falls inside it (person B has no earlier deletes).
    w.link(w.f.b);
    let from = stamp(now() - chrono::Duration::hours(5));
    let to = stamp(now() - chrono::Duration::hours(4));
    w.call(w.f.b, "DELETE", "/segments", json!({"from": from, "to": to}));
    let outside = segment(60, "outside");
    let mut inside = segment(0, "inside");
    inside["startedAt"] = json!(stamp(now() - chrono::Duration::minutes(290)));
    inside["endedAt"] = json!(stamp(now() - chrono::Duration::minutes(280)));
    let r = w.call(w.f.b, "POST", "/ingest", upload(vec![outside, inside]));
    assert_eq!((r["body"]["accepted"].clone(), r["body"]["discarded"].clone()), (json!(1), json!(1)));
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_hourly_sweep_removes_old_text_and_markers_for_its_owner_only() {
    let w = World::new();
    w.link(w.f.b);
    w.link(w.f.b);
    for who in [w.f.b, w.f.b] {
        w.call(who, "POST", "/ingest", upload(vec![segment(10, "fresh")]));
    }
    let device = Uuid::new_v4();
    w.f.rt.block_on(async {
        for who in [w.f.b, w.f.b] {
            for (name, started, created) in [("old-start", "38 days", "1 hour"), ("old-created", "1 hour", "38 days"), ("edge-keep", "36 days 23 hours", "36 days 23 hours")] {
                w.f.root.execute(
                    &format!("INSERT INTO app.backtrack_segments(owner_user_id,device_id,started_at,ended_at,app_name,bundle_id,window_title,body,body_hash,client_started_at,created_at) \
                      VALUES($1,$2,now()-interval '{started}',now()-interval '{started}'+interval '1 minute','A','b','t',$3::text,sha256(convert_to($3::text,'UTF8')),now()-interval '{started}',now()-interval '{created}')"),
                    &[&who, &device, &name.to_string()],
                ).await.unwrap_or_else(|e| panic!("{e:?}"));
            }
            w.f.root.execute("INSERT INTO app.backtrack_deletions(owner_user_id,range,created_at) VALUES($1,tstzrange(now()-interval '39 days',now()-interval '38 days','[)'),now()-interval '39 days'),($1,tstzrange(now()-interval '2 days',now()-interval '1 day','[)'),now()-interval '1 day')", &[&who]).await.unwrap();
        }
    });
    // Person A's schedule exists because they uploaded. Make it due and run the worker.
    w.f.rt.block_on(w.f.root.execute("UPDATE moss_queue.schedules SET next_at=now()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%backtrack.upkeep'", &[&w.f.b])).unwrap();
    let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
    for _ in 0..5 {
        w.app.app.installer.run_job(&worker).unwrap();
    }
    let kept = |who| w.count("SELECT count(*) FROM app.backtrack_segments WHERE owner_user_id=$1", who);
    let markers = |who| w.count("SELECT count(*) FROM app.backtrack_deletions WHERE owner_user_id=$1", who);
    assert_eq!((kept(w.f.b), markers(w.f.b)), (2, 1), "A's expired rows are gone, fresh and edge rows stay");
    assert_eq!((kept(w.f.b), markers(w.f.b)), (4, 2), "B's rows are untouched by A's job");
    println!("sweep: A kept {} segments and {} marker; B untouched", kept(w.f.b), markers(w.f.b));
}

#[test]
#[ignore = "Only through verify-gate"]
fn screen_text_never_reaches_job_payloads_activity_rows_or_the_log() {
    let w = World::new();
    w.link(w.f.b);
    let mut s = segment(10, &format!("body {LEAK}"));
    s["address"] = json!(format!("https://example.test/{LEAK}"));
    assert_eq!(w.call(w.f.b, "POST", "/ingest", upload(vec![s]))["body"]["accepted"], 1);
    // Refusals and a deletion carry no text either.
    w.call(w.f.b, "PUT", "/preferences", json!({"paused": true}));
    w.call(w.f.b, "POST", "/ingest", upload(vec![segment(10, LEAK)]));
    let gone = w.call(w.f.b, "DELETE", "/segments", Value::Null);
    println!("delete answered {}", gone["status"]);
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log')",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")), "{tables:?}");
    let mut scanned = 0;
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&LEAK])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds screen text");
        scanned += 1;
    }
    println!("scanned {scanned} tables for the planted text, found none");
    // The planted text is in the segment table, so the scan can see it.
    let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.backtrack_segments t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&LEAK])).unwrap().get(0);
    assert_eq!(stored, 0, "the delete removed it");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_account_export_holds_only_the_actors_own_text() {
    let w = World::new();
    w.link(w.f.b);
    w.link(w.f.b);
    w.call(w.f.b, "POST", "/ingest", upload(vec![segment(10, "mine")]));
    w.call(w.f.b, "POST", "/ingest", upload(vec![segment(10, "theirs")]));
    let rows = w.f.rt.block_on(async {
        let cx = DataContext::open(&w.f.db, &w.f.bccess(w.f.b)).await.unwrap();
        moss_backtrack_host::store::export(&cx).await.unwrap()
    });
    let rows = rows.as_array().unwrap().clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["body"], "mine");
    assert_eq!(rows[0]["bodyHash"].as_str().unwrap().len(), 64);
    assert!(rows[0].get("search").is_none());
}
