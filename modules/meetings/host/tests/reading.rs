//! The model's reading of a recording, against the installed Meetings and Memory packages and a
//! real database, with a scripted model and a recording chat. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_meetings_host::{authority::MeetingsAuthority, chat::MainChat};
use moss_memory_host::recording::RecordingAuthority;
use moss_module_host::{
    ai::Intelligence,
    runtime::{CallScope, Request},
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use support::install::install_full;
use uuid::Uuid;

const IDEA: &str = "PLANTED-IDEA-MARKER-93c2";

#[derive(Default)]
struct Script {
    replies: Mutex<Vec<String>>,
}
impl Intelligence for Script {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        let mut replies = self.replies.lock().unwrap();
        anyhow::ensure!(!replies.is_empty(), "The scripted model has no reply left");
        Ok(json!({"text": replies.remove(0)}))
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in this test")
    }
}

/// Keeps every notice the jobs post.
#[derive(Default)]
struct Chat(Mutex<Vec<(Uuid, String, String)>>);
impl MainChat for Chat {
    fn post(&self, owner: Uuid, text: &str, key: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().push((owner, text.to_owned(), key.to_owned()));
        Ok(())
    }
}

struct World {
    f: support::Fixture,
    app: support::install::Installed,
    model: Arc<Script>,
    chat: Arc<Chat>,
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        let (model, chat) = (Arc::new(Script::default()), Arc::new(Chat::default()));
        let app = install_full(&f, model.clone(), Some(chat.clone()));
        Self { f, app, model, chat }
    }
    fn call(&self, actor: Uuid, method: &str, target: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {target}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// Records one meeting for `actor`, has the model read it as `reading`, and returns its id.
    fn read(&self, actor: Uuid, reading: Value) -> String {
        let made = self.call(actor, "POST", "/records", json!({"requestKey": Uuid::new_v4(), "title": "Budget"}));
        let id = made["body"]["meeting"]["id"].as_str().unwrap().to_owned();
        let batch = json!({"requestKey": Uuid::new_v4(), "expectedVersion": 0,
            "sources": [{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],
            "events": [{"cursor":1,"segment":{"meetingId":id,"segmentId":"s1","sourceId":"mic","epoch":1,"startMs":10,"endMs":19,
                "revision":1,"text":"talk about the wind","finality":"final","provenance":"transcription","speakerId":null}}],
            "stopCutoffMs": null});
        assert_eq!(self.call(actor, "POST", &format!("/records/{id}/transcript"), batch)["status"], 201);
        let cite = json!({"kind":"transcript","meetingId":id,"segmentId":"s1","segmentRevision":1,"startCharacter":0,"endCharacter":4});
        let reply = json!({"overview":"Wind.","decisions":[{"text":"Try it","evidence":[cite.clone()]}],"openQuestions":[],
            "actions":[{"text":"Send","evidence":[cite],"ownerPhrase":null,"duePhrase":null}],"warnings":[],"recording":reading});
        self.model.replies.lock().unwrap().push(reply.to_string());
        let body = json!({"requestKey": Uuid::new_v4(), "expectedOutputVersion": 0, "expectedTranscriptRevision": 1,
            "expectedNotesRevision": 0, "templateId": "general", "templateVersion": 1});
        let done = self.call(actor, "POST", &format!("/records/{id}/outputs"), body);
        assert_eq!(done["status"], 200, "{done}");
        id
    }
    /// Runs queued jobs until none is left.
    fn run_jobs(&self) {
        let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
        for _ in 0..10 {
            if !self.app.app.installer.run_job(&worker).unwrap() {
                return;
            }
        }
        panic!("jobs did not settle");
    }
    fn count(&self, sql: &str) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[])).unwrap().get(0)
    }
}

fn reading(side: &str, confidence: f64, groups: Value) -> Value {
    json!({"title": "Wind ideas", "typeId": "brain-dump", "side": side, "confidence": confidence,
        "reason": "A hobby project", "ideaGroups": groups})
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_reading_is_filed_and_only_a_doubtful_side_posts_a_notice() {
    let w = World::new();
    let a = w.f.a;
    let doubtful = w.read(a, reading("work", 0.5, json!([])));
    let (side, confidence, type_id, version): (String, f64, String, i32) = w.f.rt.block_on(async {
        let row = w.f.root
            .query_one("SELECT side, confidence, type_id, output_version FROM app.meeting_recording_metadata WHERE meeting_id = $1", &[&doubtful.parse::<Uuid>().unwrap()])
            .await
            .unwrap();
        (row.get(0), row.get(1), row.get(2), row.get(3))
    });
    assert_eq!((side.as_str(), confidence, type_id.as_str(), version), ("work", 0.5, "brain-dump", 1));

    let sure = w.read(a, reading("personal", 0.9, json!([])));
    w.run_jobs();
    let posts = w.chat.0.lock().unwrap().clone();
    assert_eq!(posts.len(), 1, "only the doubtful reading posts: {posts:?}");
    assert_eq!(posts[0].0, a);
    assert!(posts[0].1.contains(&doubtful) && posts[0].1.contains("work"), "{}", posts[0].1);
    assert!(!posts.iter().any(|p| p.1.contains(&sure)));

    // The notice is stored in no one else's name.
    assert_eq!(w.count(&format!("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE '%A hobby project%'")), 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn ideas_become_memory_facts_on_the_recordings_own_side_and_text_stays_out_of_queues() {
    let w = World::new();
    let a = w.f.a;
    let groups = json!([{"title": "Wind", "ideas": [format!("Animate the grass {IDEA}"), "Gusts"]}]);
    let personal = w.read(a, reading("personal", 0.9, groups.clone()));
    let work = w.read(a, reading("work", 0.9, json!([{"title": "Plan", "ideas": ["Ship it"]}])));
    w.run_jobs();
    let side_of = |id: &str, side: &str| {
        w.count(&format!("SELECT count(*) FROM app.memory_recording_receipts WHERE source_id = '{id}'::uuid AND side = '{side}' AND state = 'applied'"))
    };
    assert_eq!((side_of(&personal, "personal"), side_of(&personal, "work")), (2, 0));
    assert_eq!((side_of(&work, "work"), side_of(&work, "personal")), (1, 0));
    assert_eq!(w.count(&format!("SELECT count(*) FROM app.memory_recording_receipts WHERE owner_user_id = '{}'::uuid", w.f.b)), 0);

    assert_eq!(w.count("SELECT count(*) FROM app.memory_recording_receipts"), 3);

    // The idea text reaches no queue payload, activity row or model log.
    let leaked = w.count(&format!(
        "SELECT (SELECT count(*) FROM moss_queue.jobs j WHERE j::text LIKE '%{IDEA}%') \
         + CASE WHEN to_regclass('app.moss_activity_detail') IS NULL THEN 0 ELSE (SELECT count(*) FROM app.moss_activity_detail x WHERE x::text LIKE '%{IDEA}%') END \
         + CASE WHEN to_regclass('app.moss_model_activity_log') IS NULL THEN 0 ELSE (SELECT count(*) FROM app.moss_model_activity_log x WHERE x::text LIKE '%{IDEA}%') END"
    ));
    assert_eq!(leaked, 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_make_meetings_vouch_for_a_recording_and_the_check_fails_without_the_protection() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let id = w.read(a, reading("personal", 0.9, json!([])));
    let authority = MeetingsAuthority::new(w.f.db.clone());
    let source = |owner: Uuid| authority.current(&owner.to_string(), &id).map(|s| s.side);
    assert_eq!(source(a).as_deref(), Some("personal"));
    assert_eq!(source(b), None, "person B must not see person A's reading");

    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.meeting_recording_metadata DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = source(b);
    w.f.rt.block_on(w.f.root.batch_execute(
        "ALTER TABLE app.meeting_recording_metadata ENABLE ROW LEVEL SECURITY; ALTER TABLE app.meeting_recording_metadata FORCE ROW LEVEL SECURITY",
    ))
    .unwrap();
    println!("RED: person B sees {open:?} with row security removed");
    assert_eq!(open.as_deref(), Some("personal"), "RED expected with the protection removed");
    assert_eq!(source(b), None, "protection restored");
}
