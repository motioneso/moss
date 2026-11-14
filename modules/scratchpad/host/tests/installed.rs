//! Real installed-package proofs. Run only through scripts/run-gate.sh.
mod support;
#[path = "support/replay.rs"]
mod replay;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use support::{install::Installed, Fixture};
use uuid::Uuid;

const MARK: &str = "PLANTED-NOTE-MARKER-4f1c9b";
const LEAK: &str = "PLANTED-LEAK-MARKER-7e2d51";

struct World {
    f: Fixture,
    app: Installed,
}
impl World {
    fn new() -> Self {
        let f = Fixture::new();
        let app = support::install::install(&f);
        World { f, app }
    }
    fn call(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/scratchpad{path}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {path}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// How many note rows `actor` can read straight from the table through their own policies.
    fn visible(&self, actor: Uuid) -> i64 {
        self.f.rt.block_on(async {
            let cx = DataContext::open(&self.f.db, &self.f.access(actor)).await.unwrap();
            cx.db().query_one("SELECT count(*) FROM app.scratchpads", &[]).await.unwrap().get(0)
        })
    }
    fn stored(&self, owner: Uuid) -> String {
        self.f.rt.block_on(self.f.root.query_one("SELECT body FROM app.scratchpads WHERE user_id=$1", &[&owner])).unwrap().get(0)
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_and_an_admin_cannot_read_or_change_the_note() {
    let w = World::new();
    let saved = w.call(w.f.a, "PUT", "/note", json!({"body": format!("alpha {MARK}"), "revision": 0}));
    assert_eq!((saved["status"].clone(), saved["body"]["revision"].clone()), (json!(200), json!(1)));

    // B and the admin see an empty note, and a save against A's revision is refused.
    for other in [w.f.b, w.f.admin] {
        let read = w.call(other, "GET", "/note", Value::Null);
        assert_eq!((read["body"]["body"].clone(), read["body"]["revision"].clone()), (json!(""), json!(0)));
        assert_eq!(w.visible(other), 0);
        let blocked = w.call(other, "PUT", "/note", json!({"body": "taken over", "revision": 1}));
        assert_eq!(blocked["status"], 409);
        assert!(!blocked.to_string().contains(MARK), "a conflict must not show another person's note");
    }
    let appended = w.call(w.f.b, "POST", "/append", json!({"text": "from b"}));
    assert_eq!(appended["body"]["revision"], 1, "b's append starts b's own note");
    assert_eq!(w.stored(w.f.a), format!("alpha {MARK}"));
    assert_eq!(w.stored(w.f.b), "from b");
    // B's note moves to revision 2, so only A's note is at revision 1 when row security comes off.
    w.call(w.f.b, "POST", "/append", json!({"text": "again"}));

    // The same checks must fail with row security removed, then pass once restored.
    let off = "ALTER TABLE app.scratchpads DISABLE ROW LEVEL SECURITY";
    let on = "ALTER TABLE app.scratchpads ENABLE ROW LEVEL SECURITY; ALTER TABLE app.scratchpads FORCE ROW LEVEL SECURITY";
    w.f.rt.block_on(w.f.root.batch_execute(off)).unwrap();
    let open = w.visible(w.f.admin);
    let taken = w.call(w.f.admin, "PUT", "/note", json!({"body": "taken over", "revision": 1}));
    w.f.rt.block_on(w.f.root.batch_execute(on)).unwrap();
    assert!(open >= 2, "RED expected: the admin sees other people's notes with row security removed");
    assert_eq!(taken["status"], 200, "RED expected: the admin overwrites a note with row security removed");
    println!("RED: the admin sees {open} note(s) and overwrote one with row security removed");
    w.f.rt.block_on(w.f.root.execute("UPDATE app.scratchpads SET body=$1,revision=1 WHERE user_id=$2", &[&format!("alpha {MARK}"), &w.f.a])).unwrap();
    assert_eq!(w.visible(w.f.admin), 0);
    assert_eq!(w.call(w.f.admin, "PUT", "/note", json!({"body": "again", "revision": 1}))["status"], 409);
    println!("GREEN: row security restored, the admin sees 0 notes and cannot save over another note");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_four_routes_work_end_to_end_for_one_person() {
    let w = World::new();
    let a = w.f.a;
    let empty = w.call(a, "GET", "/note", Value::Null);
    assert_eq!(empty["body"], json!({"body": "", "revision": 0, "updatedAt": null, "maxChars": 64000,
        "syncToNotes": false, "notesFolderConfigured": false, "shortcut": "mod+shift+s"}));
    assert_eq!(w.call(a, "PUT", "/note", json!({"body": "one", "revision": 0}))["body"]["revision"], 1);
    let stale = w.call(a, "PUT", "/note", json!({"body": "two", "revision": 0}));
    assert_eq!((stale["status"].clone(), stale["body"]["body"].clone(), stale["body"]["revision"].clone()), (json!(409), json!("one"), json!(1)));
    assert!(stale["body"]["updatedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(w.call(a, "PUT", "/note", json!({"body": "two", "revision": 1}))["body"]["revision"], 2);
    assert_eq!(w.call(a, "POST", "/append", json!({"text": " three "}))["body"]["appended"], "\nthree");
    assert_eq!(w.stored(a), "two\nthree");
    assert_eq!(w.call(a, "PUT", "/note", json!({"body": "", "revision": 3}))["status"], 200);
    assert_eq!(w.call(a, "POST", "/append", json!({"text": "first"}))["body"]["appended"], "first");
    assert_eq!(w.call(a, "PUT", "/note", json!({"body": "x".repeat(64001), "revision": 5}))["status"], 413);
    w.call(a, "PUT", "/note", json!({"body": "x".repeat(63999), "revision": 5}));
    let full = w.call(a, "POST", "/append", json!({"text": "yy"}));
    assert_eq!((full["status"].clone(), full["body"].clone()), (json!(413), json!({"code": "scratchpad_too_large", "maxChars": 64000})));

    // Settings: copying needs a notes folder, and a left-out field keeps its value.
    let refused = w.call(a, "PATCH", "/settings", json!({"syncToNotes": true}));
    assert_eq!((refused["status"].clone(), refused["body"].clone()), (json!(409), json!({"code": "scratchpad_notes_folder_missing"})));
    w.f.rt.block_on(w.f.root.execute(
        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path','\"/notes\"'::jsonb)", &[&a])).unwrap();
    assert_eq!(w.call(a, "GET", "/note", Value::Null)["body"]["notesFolderConfigured"], true);
    assert_eq!(w.call(a, "PATCH", "/settings", json!({"syncToNotes": true}))["body"], json!({"syncToNotes": true, "shortcut": "mod+shift+s"}));
    assert_eq!(w.call(a, "PATCH", "/settings", json!({"shortcut": "alt+j"}))["body"], json!({"syncToNotes": true, "shortcut": "alt+j"}));
    assert_eq!(w.call(a, "PATCH", "/settings", json!({"shortcut": "ctrl+k"}))["status"], 400);
    // A new person's first settings change creates their note.
    assert_eq!(w.call(w.f.b, "PATCH", "/settings", json!({"shortcut": "alt+m"}))["body"], json!({"syncToNotes": false, "shortcut": "alt+m"}));
    assert_eq!(w.call(w.f.b, "GET", "/note", Value::Null)["body"]["revision"], 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn note_text_never_reaches_job_payloads_activity_rows_or_the_log() {
    let w = World::new();
    w.call(w.f.a, "PUT", "/note", json!({"body": format!("body {LEAK}"), "revision": 0}));
    w.call(w.f.a, "POST", "/append", json!({"text": format!("more {LEAK}")}));
    w.call(w.f.a, "PATCH", "/settings", json!({"shortcut": "mod+k"}));
    w.call(w.f.a, "PUT", "/note", json!({"body": format!("stale {LEAK}"), "revision": 0}));
    w.call(w.f.a, "PUT", "/note", json!({"body": LEAK.repeat(5000), "revision": 2}));
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
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&LEAK])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds note text");
    }
    println!("scanned {} tables for the planted text, found none", tables.len());
    // The planted text is in the note table, so the scan can see it.
    let stored: i64 = w.f.rt.block_on(w.f.root.query_one("SELECT count(*) FROM app.scratchpads t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&LEAK])).unwrap().get(0);
    assert_eq!(stored, 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn every_route_answers_exactly_as_the_old_route_did() {
    let w = World::new();
    // Person A goes through the old Fastify routes, person B through the package, on one database.
    let run_new = |steps: &[Value]| -> Vec<Value> {
        steps
            .iter()
            .map(|step| {
                let path = replay::new_path(step["url"].as_str().unwrap());
                w.call(w.f.b, step["method"].as_str().unwrap(), path, step.get("body").cloned().unwrap_or(Value::Null))
            })
            .collect()
    };
    let compare = |label: &str, steps: &[Value], old: Vec<Value>, new: Vec<Value>| {
        assert_eq!(old.len(), new.len());
        for (i, (o, n)) in old.iter().zip(&new).enumerate() {
            println!("{label} {i}: old {} new {}", o["status"], n["status"]);
        }
        for (i, (old, new)) in old.into_iter().zip(new).enumerate() {
            let mut old = json!({"status": old["status"], "body": old["body"]});
            let mut new = json!({"status": new["status"], "body": new["body"]});
            replay::mask(&mut old);
            replay::mask(&mut new);
            assert_eq!(old, new, "{label} step {i} ({}) differs from the old route", steps.get(i).map(|s| s.to_string().chars().take(160).collect::<String>()).unwrap_or_default());
        }
    };
    let first = replay::steps_without_a_notes_folder();
    compare("no notes folder", &first, replay::old_routes(w.f.a, &first), run_new(&first));
    assert_eq!(w.stored(w.f.a), w.stored(w.f.b), "the stored notes differ");
    for person in [w.f.a, w.f.b] {
        w.f.rt
            .block_on(w.f.root.execute(
                "INSERT INTO app.preferences (owner_user_id, key, value_json) VALUES ($1, 'notes-source-path', '\"/notes\"'::jsonb)",
                &[&person],
            ))
            .unwrap();
    }
    let second = replay::steps_with_a_notes_folder();
    compare("notes folder set", &second, replay::old_routes(w.f.a, &second), run_new(&second));
    println!("PASS replay: {} old-route steps match", first.len() + second.len());
}
