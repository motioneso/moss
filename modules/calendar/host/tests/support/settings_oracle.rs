use super::{kv_guard::Captured, support::Fixture};
use moss_module_host::{application::Application, runtime::Request};
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

const POLICY: &str = "assistant.action_policy.v1.calendar.calendar_writeback";
fn snapshot(f: &Fixture, actor: Uuid) -> Value {
    f.rt.block_on(async {
        let keys = keys();
        let rows = f.root.query("SELECT key,value_json,revision FROM app.preferences WHERE owner_user_id=$1 AND key=ANY($2) ORDER BY key", &[&actor,&keys]).await.unwrap();
        json!(rows.into_iter().map(|r| json!({"key":r.get::<_,String>(0),"value":r.get::<_,Value>(1),"revision":r.get::<_,i32>(2)})).collect::<Vec<_>>())
    })
}
fn keys() -> Vec<&'static str> {
    let mut keys = moss_calendar_host::PREFERENCE_KEYS.to_vec();
    keys.push(POLICY);
    keys
}
fn reset(f: &Fixture, actor: Uuid) {
    f.rt.block_on(f.root.execute(
        "DELETE FROM app.preferences WHERE owner_user_id=$1 AND key=ANY($2)",
        &[&actor, &keys()],
    ))
    .unwrap();
}
fn call(app: &Application, f: &Fixture, actor: Uuid, method: &str, body: Value) -> Value {
    serde_json::from_str(
        &app.dispatch_extended(
            f.access(actor),
            method,
            "/api/m/calendar/briefing-settings",
            &body.to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}

pub fn verify(app: &Application, f: &Fixture, captured: &Captured) {
    let patches = json!([{}, {"lookaheadDays":0}, {"lookaheadDays":1}, {"lookaheadDays":2.0},
        {"suggestTasks":false,"suggestTimeBlocks":false}, {"createTasks":true,"blockTime":true},
        {"prepTaskMode":"off","timeBlockMode":"off"}, {"prepTaskMode":"suggest","timeBlockMode":"suggest"},
        {"prepTaskMode":"auto","timeBlockMode":"auto"}, {"createTasks":false,"blockTime":false},
        {"lookaheadDays":0,"prepTaskMode":"off","timeBlockMode":"suggest"}]);
    for actor in [f.a, f.b, f.admin] {
        reset(f, actor);
        let mut child = Command::new("pnpm")
            .args(["exec", "tsx", "modules/calendar/tools/settings-oracle.ts"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
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
                json!({"actor":actor,"patches":patches})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Production settings oracle failed (database diagnostics omitted)"
        );
        let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
        let stored = snapshot(f, actor);
        reset(f, actor);
        assert_eq!(expected.len(), patches.as_array().unwrap().len());
        for (patch, expected) in patches.as_array().unwrap().iter().zip(expected) {
            let actual = call(app, f, actor, "PATCH", patch.clone());
            assert_eq!(
                json!({"status":actual["status"],"body":actual["body"]}),
                expected
            );
        }
        assert_eq!(
            snapshot(f, actor),
            stored,
            "Preference, revision or writeback-policy mismatch"
        );
    }
    println!("PASS 33 installed-Wasm / production settings PATCH comparisons plus stored values, revisions and policy");

    let owner = snapshot(f, f.a);
    for actor in [f.b, f.admin] {
        assert_eq!(
            call(
                app,
                f,
                actor,
                "PATCH",
                json!({"lookaheadDays":2,"timeBlockMode":"auto"})
            )["status"],
            200
        );
        assert_eq!(
            call(
                app,
                f,
                actor,
                "PATCH",
                json!({"ownerUserId":f.a,"prepTaskMode":"auto"})
            )["status"],
            400
        );
        assert_eq!(
            snapshot(f, f.a),
            owner,
            "Foreign settings patch changed the owner's preferences"
        );
    }
    // The trusted wrapper independently rejects forged parameters and rolls back a valid
    // settings write when the guest fails. Use the real captured authenticated call scope.
    let _ = call(app, f, f.a, "GET", Value::Null);
    let scope = captured.scope.lock().unwrap().clone().unwrap();
    let guarded = captured.guarded.lock().unwrap().clone().unwrap();
    assert!(guarded
        .invoke(
            &scope,
            "kv",
            &Request {
                operation: "set".into(),
                resource: "calendar.briefing-settings".into(),
                parameters: json!({"ownerUserId":f.b})
            }
        )
        .is_err());
    guarded
        .invoke(
            &scope,
            "kv",
            &Request {
                operation: "set".into(),
                resource: "calendar.briefing-settings".into(),
                parameters: json!({"lookaheadDays":2,"timeBlockMode":"auto"}),
            },
        )
        .unwrap();
    guarded.finish_call(&scope, false).unwrap();
    assert_eq!(
        snapshot(f, f.a),
        owner,
        "Failed guest call committed its settings or policy"
    );
    println!("PASS foreign/admin writes preserve owner settings; forged host owner rejected; failed guest rolls back preferences and policy");
    concurrent_saves(app, f, captured);
    privacy(f);
}

fn concurrent_saves(app: &Application, f: &Fixture, captured: &Captured) {
    let _ = call(app, f, f.a, "GET", Value::Null);
    let first = captured.scope.lock().unwrap().clone().unwrap();
    let _ = call(app, f, f.a, "GET", Value::Null);
    let second = captured.scope.lock().unwrap().clone().unwrap();
    let guarded = captured.guarded.lock().unwrap().clone().unwrap();
    let request = Request {
        operation: "set".into(),
        resource: "calendar.briefing-settings".into(),
        parameters: json!({"lookaheadDays":1}),
    };
    guarded.invoke(&first, "kv", &request).unwrap();
    std::thread::scope(|threads| {
        let waiting = threads.spawn(|| guarded.invoke(&second, "kv", &request));
        // Wait for PostgreSQL's actual lock wait, not an assumed thread schedule.
        let mut observed = false;
        for _ in 0..200 {
            observed = f.rt.block_on(async {
                f.root.query_one("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='jarvis_app_runtime' AND wait_event='advisory')", &[]).await.unwrap().get::<_,bool>(0)
            });
            if observed {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(observed, "Second save never reached the account lock");
        guarded.finish_call(&first, true).unwrap();
        waiting.join().unwrap().unwrap();
        guarded.finish_call(&second, true).unwrap();
    });
    assert_eq!(
        call(app, f, f.a, "GET", Value::Null)["body"]["settings"]["lookaheadDays"],
        1
    );
    println!(
        "PASS concurrent saves wait for the account transaction without blocking its completion"
    );
}

fn privacy(f: &Fixture) {
    let key = "calendar.prep_task_mode";
    let isolation = |actor, write| {
        f.rt.block_on(async {
        let cx=DataContext::open(&f.db,&f.access(actor)).await.unwrap();
        let count=if write {
            cx.db().execute("UPDATE app.preferences SET value_json='\"auto\"' WHERE owner_user_id=$1 AND key=$2",&[&f.a,&key]).await.unwrap()
        } else {
            cx.db().query("SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key=$2",&[&f.a,&key]).await.unwrap().len() as u64
        };
        // The attempted write is never committed, even when the control disables RLS.
        count==0
    })
    };
    for actor in [f.b, f.admin] {
        assert!(isolation(actor, false));
        assert!(isolation(actor, true));
    }
    f.rt.block_on(
        f.root
            .batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"),
    )
    .unwrap();
    let red_read = isolation(f.b, false);
    let red_write = isolation(f.b, true);
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(
        !red_read && !red_write,
        "Privacy assertion did not detect removed RLS"
    );
    println!("RED preferences: same foreign read/write assertions fail with RLS removed");
    for actor in [f.b, f.admin] {
        assert!(isolation(actor, false));
        assert!(isolation(actor, true));
    }
    println!("GREEN preferences: same foreign/admin read/write assertions pass with RLS restored");
}
