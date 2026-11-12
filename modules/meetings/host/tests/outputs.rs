//! Meeting summaries against the installed package and a real database, with a scripted model.
//! Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_module_host::{
    ai::Intelligence,
    runtime::{CallScope, Request},
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::install::install_with;

const MARK: &str = "PLANTED-SUMMARY-MARKER-4b19";
const K1: &str = "00000000-0000-4000-8000-000000000001";
const K2: &str = "00000000-0000-4000-8000-000000000002";
const K3: &str = "00000000-0000-4000-8000-000000000003";
const K4: &str = "00000000-0000-4000-8000-000000000004";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";

/// Hands back the next scripted reply and keeps every prompt it was shown.
#[derive(Default)]
struct Script {
    replies: Mutex<Vec<String>>,
    prompts: Mutex<Vec<String>>,
}
impl Intelligence for Script {
    fn generate(&self, _: &CallScope, request: &Request) -> anyhow::Result<Value> {
        self.prompts.lock().unwrap().push(request.parameters["prompt"].as_str().unwrap_or_default().to_owned());
        let mut replies = self.replies.lock().unwrap();
        anyhow::ensure!(!replies.is_empty(), "The scripted model has no reply left");
        Ok(json!({"text": replies.remove(0)}))
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in this test")
    }
}

struct World {
    f: support::Fixture,
    app: support::install::Installed,
    model: Arc<Script>,
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        let model = Arc::new(Script::default());
        let app = install_with(&f, model.clone());
        Self { f, app, model }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, target: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {target}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    fn say(&self, reply: Value) {
        self.model.replies.lock().unwrap().push(reply.to_string());
    }
    fn meeting(&self, actor: uuid::Uuid) -> String {
        let made = self.call(actor, "POST", "/records", json!({"requestKey": uuid::Uuid::new_v4(), "title": "Budget"}));
        assert_eq!(made["status"], 201, "{made}");
        made["body"]["meeting"]["id"].as_str().unwrap().to_owned()
    }
    /// A meeting with one final transcript segment and the model's reply for it queued.
    fn with_transcript(&self, actor: uuid::Uuid) -> String {
        let id = self.meeting(actor);
        let saved = self.call(actor, "POST", &format!("/records/{id}/transcript"), batch(&id));
        assert_eq!(saved["status"], 201, "{saved}");
        id
    }
    fn generate(&self, actor: uuid::Uuid, id: &str, key: &str, version: i64) -> Value {
        self.call(actor, "POST", &format!("/records/{id}/outputs"), generate_body(key, version, 1, 0))
    }
}

fn batch(id: &str) -> Value {
    json!({"requestKey": K4, "expectedVersion": 0,
        "sources": [{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],
        "events": [{"cursor":1,"segment":{"meetingId":id,"segmentId":"s1","sourceId":"mic","epoch":1,"startMs":10,"endMs":19,
            "revision":1,"text":format!("budget {MARK} review"),"finality":"final","provenance":"transcription","speakerId":null}}],
        "stopCutoffMs": null})
}

fn generate_body(key: &str, output_version: i64, transcript_revision: i64, notes_revision: i64) -> Value {
    json!({"requestKey": key, "expectedOutputVersion": output_version, "expectedTranscriptRevision": transcript_revision,
        "expectedNotesRevision": notes_revision, "templateId": "general", "templateVersion": 1})
}

fn content(id: &str, overview: &str) -> Value {
    let cite = json!({"kind":"transcript","meetingId":id,"segmentId":"s1","segmentRevision":1,"startCharacter":0,"endCharacter":6});
    json!({"overview": overview, "decisions": [{"text": "Review the budget", "evidence": [cite.clone()]}],
        "openQuestions": ["Who signs off?"],
        "actions": [{"text": "Send the budget", "evidence": [cite], "ownerPhrase": null, "duePhrase": null}],
        "warnings": []})
}

#[test]
#[ignore = "Only through verify-gate"]
fn generate_replays_edits_keeps_versions_and_marks_stale() {
    let w = World::new();
    let a = w.f.a;
    let id = w.with_transcript(a);
    w.say(content(&id, "We reviewed the budget."));
    let first = w.generate(a, &id, K1, 0);
    assert_eq!(first["status"], 200, "{first}");
    assert_eq!(first["body"]["status"], "saved");
    assert_eq!(first["body"]["artifact"]["version"], 1);
    // The model saw the transcript text, and only that meeting's.
    assert!(w.model.prompts.lock().unwrap()[0].contains(MARK));

    let again = w.generate(a, &id, K1, 0);
    assert_eq!((again["status"].clone(), again["body"]["replayed"].clone()), (json!(200), json!(true)));
    assert_eq!(w.model.prompts.lock().unwrap().len(), 1, "a replay must not call the model");
    let changed = w.call(a, "POST", &format!("/records/{id}/outputs"), generate_body(K1, 0, 1, 5));
    assert_eq!((changed["status"].clone(), changed["body"]["code"].clone()), (json!(409), json!("meeting_output_request_conflict")));

    // An edit saves version 2 and leaves version 1 as it was.
    let edit = json!({"requestKey": K2, "expectedOutputVersion": 1, "content": content(&id, "Edited overview.")});
    let edited = w.call(a, "PUT", &format!("/records/{id}/outputs"), edit);
    assert_eq!(edited["status"], 200, "{edited}");
    assert_eq!(edited["body"]["version"], 2);
    let v1 = w.call(a, "GET", &format!("/records/{id}/outputs/1"), Value::Null);
    assert_eq!(v1["body"]["artifact"]["content"]["overview"], "We reviewed the budget.");
    assert_eq!(v1["body"]["artifact"]["stale"], false);
    let stale_edit = json!({"requestKey": K3, "expectedOutputVersion": 1, "content": content(&id, "x")});
    let refused = w.call(a, "PUT", &format!("/records/{id}/outputs"), stale_edit);
    assert_eq!((refused["status"].clone(), refused["body"]["code"].clone()), (json!(409), json!("meeting_output_version_conflict")));

    // Changing the notes marks every version stale.
    let notes = w.call(a, "PUT", &format!("/records/{id}/notes"), json!({"requestKey": K3, "expectedRevision": 0, "personalNotes": "later"}));
    assert_eq!(notes["status"], 200, "{notes}");
    let v1 = w.call(a, "GET", &format!("/records/{id}/outputs/1"), Value::Null);
    assert_eq!(v1["body"]["artifact"]["stale"], true);
    let list = w.call(a, "GET", &format!("/records/{id}/outputs"), Value::Null);
    assert_eq!(list["body"]["headVersion"], 2);
    assert_eq!(list["body"]["artifacts"].as_array().unwrap().len(), 2);
    let missing = w.call(a, "GET", &format!("/records/{id}/outputs/9"), Value::Null);
    assert_eq!((missing["status"].clone(), missing["body"]["code"].clone()), (json!(404), json!("meeting_output_unavailable")));
    let none = w.call(a, "GET", &format!("/records/{MISSING}/outputs"), Value::Null);
    assert_eq!((none["status"].clone(), none["body"]["code"].clone()), (json!(404), json!("meeting_not_found")));
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_bad_model_reply_is_stored_as_a_failed_result_and_replays() {
    let w = World::new();
    let a = w.f.a;
    let id = w.with_transcript(a);
    // A citation that does not exist in the transcript fails the evidence check.
    let mut bad = content(&id, "Bad.");
    bad["decisions"][0]["evidence"][0]["endCharacter"] = json!(9999);
    w.say(bad);
    let failed = w.generate(a, &id, K1, 0);
    assert_eq!(failed["status"], 422, "{failed}");
    assert_eq!(failed["body"]["status"], "failed");
    let again = w.generate(a, &id, K1, 0);
    assert_eq!(again, failed, "a failed result replays unchanged");
    let list = w.call(a, "GET", &format!("/records/{id}/outputs"), Value::Null);
    assert_eq!(list["body"]["artifacts"].as_array().unwrap().len(), 0);
    // A request for the wrong output version is refused with the current versions.
    let wrong = w.call(a, "POST", &format!("/records/{id}/outputs"), generate_body(K2, 4, 1, 0));
    assert_eq!((wrong["status"].clone(), wrong["body"]["code"].clone()), (json!(409), json!("meeting_output_version_conflict")));
    assert_eq!(wrong["body"]["currentVersions"]["transcriptRevision"], 1);
    let invalid = w.call(a, "POST", &format!("/records/{id}/outputs"), json!({"requestKey": K2}));
    assert_eq!(invalid["status"], 400, "{invalid}");
}

/// Reads one table as the database owner, so row-level security does not hide anything.
fn count(w: &World, sql: &str) -> i64 {
    w.f.rt.block_on(async { w.f.root.query_one(sql, &[]).await.unwrap().get(0) })
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_and_an_administrator_see_no_summary_and_nothing_leaks() {
    let w = World::new();
    let (a, b, admin) = (w.f.a, w.f.b, w.f.admin);
    let id = w.with_transcript(a);
    w.say(content(&id, &format!("Overview {MARK}")));
    assert_eq!(w.generate(a, &id, K1, 0)["status"], 200);

    let probe = |actor: uuid::Uuid| -> Vec<Value> {
        vec![
            w.call(actor, "GET", &format!("/records/{id}/outputs"), Value::Null),
            w.call(actor, "GET", &format!("/records/{id}/outputs/1"), Value::Null),
            w.call(actor, "POST", &format!("/records/{id}/outputs"), generate_body(K2, 1, 1, 0)),
            w.call(actor, "PUT", &format!("/records/{id}/outputs"), json!({"requestKey": K3, "expectedOutputVersion": 1, "content": content(&id, "x")})),
        ]
    };
    for actor in [b, admin] {
        for reply in probe(actor) {
            assert_eq!(reply["status"], 404, "{reply}");
            assert_eq!(reply["body"]["code"], "meeting_not_found");
            assert!(!reply.to_string().contains(MARK));
        }
    }
    assert_eq!(w.model.prompts.lock().unwrap().len(), 1, "another person's call must not reach the model");

    // The protection is real: with row-level security off, the same person reads the summary.
    let tables = "'meeting_records','meeting_output_artifacts','meeting_output_requests'";
    let toggle = |on: bool| {
        let verb = if on { "ENABLE" } else { "DISABLE" };
        w.f.rt.block_on(async {
            for t in ["meeting_records", "meeting_output_artifacts", "meeting_output_requests"] {
                w.f.root.batch_execute(&format!("ALTER TABLE app.{t} {verb} ROW LEVEL SECURITY")).await.unwrap();
            }
        });
    };
    assert_eq!(count(&w, &format!("SELECT count(*) FROM pg_class WHERE relname IN ({tables}) AND relrowsecurity")), 3);
    toggle(false);
    let leaked = w.call(b, "GET", &format!("/records/{id}/outputs/1"), Value::Null);
    toggle(true);
    assert_eq!(leaked["status"], 200, "with protection removed person B should see the summary: {leaked}");
    assert_eq!(w.call(b, "GET", &format!("/records/{id}/outputs/1"), Value::Null)["status"], 404);

    // Summary text never lands in a queue payload, an activity row or a log row.
    let payloads = count(&w, &format!("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE '%{MARK}%'"));
    assert_eq!(payloads, 0);
    let stored = count(
        &w,
        &format!("SELECT count(*) FROM app.meeting_output_requests WHERE result_json::text LIKE '%{MARK}%'"),
    );
    assert_eq!(stored, 1, "the finished result is stored for the owner only");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_pasted_transcript_queues_a_metadata_only_job_that_writes_the_summary() {
    let w = World::new();
    let a = w.f.a;
    let made = w.call(
        a,
        "POST",
        "/manual-transcripts",
        json!({"requestKey": K1, "transcript": format!("budget {MARK} review"), "typeId": "idea", "recordedAt": "2026-01-02T03:04:05Z"}),
    );
    assert_eq!(made["status"], 201, "{made}");
    let id = made["body"]["meetingId"].as_str().unwrap().to_owned();
    let jobs: Vec<Value> = w.f.rt.block_on(async {
        w.f.root
            .query("SELECT payload FROM moss_queue.jobs WHERE queue LIKE '%meetings.stop-summary'", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<_, Value>(0))
            .collect()
    });
    assert_eq!(jobs.len(), 1);
    let text = jobs[0].to_string();
    assert!(text.contains(&id) && !text.contains(MARK), "payload: {text}");

    // The summary reads the pasted segment, so fetch its identity first.
    let read = w.call(a, "GET", &format!("/records/{id}/transcript?maxSegments=10&maxCharacters=1000"), Value::Null);
    let segment = find(&read["body"], "segments").and_then(|s| s.get(0).cloned()).expect("a segment");
    let cite = json!({"kind":"transcript","meetingId":id,"segmentId":segment["segmentId"],"segmentRevision":segment["revision"],
        "startCharacter":0,"endCharacter":6});
    w.say(json!({"overview":"Pasted.","decisions":[{"text":"Review","evidence":[cite.clone()]}],"openQuestions":[],
        "actions":[{"text":"Send","evidence":[cite],"ownerPhrase":null,"duePhrase":null}],"warnings":[]}));
    let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
    assert!(w.app.app.installer.run_job(&worker).unwrap());
    let list = w.call(a, "GET", &format!("/records/{id}/outputs"), Value::Null);
    assert_eq!(list["body"]["artifacts"].as_array().unwrap().len(), 1, "{list}");
    assert_eq!(list["body"]["automaticSummary"]["status"], "saved");
}

fn find(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(map) => map.get(key).cloned().or_else(|| map.values().find_map(|v| find(v, key))),
        Value::Array(items) => items.iter().find_map(|v| find(v, key)),
        _ => None,
    }
}
