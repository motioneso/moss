//! The Mac link against the installed Meetings package and a real database. The sign-in,
//! paired-device and model checks are a stand-in, because pairing is not built.
//! Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use moss_meetings_host::capture::{Browser, CaptureAuthority, Native};
use moss_module_host::runtime::{CallScope, Request};
use serde_json::{json, Value};
use sha2::Digest;
use std::sync::{Arc, Mutex};
use support::install::install_all;
use uuid::Uuid;

const MARK: &str = "PLANTED-CAPTURE-MARKER-3c9d";
const K1: &str = "11111111-1111-4111-8111-111111111111";
const K2: &str = "22222222-2222-4222-8222-222222222222";
const CONN: &str = "44444444-4444-4444-8444-444444444444";
const DEVICE: &str = "55555555-5555-4555-8555-555555555555";
const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const FAR: &str = "2030-01-01T00:00:00.000Z";

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No model in this test")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in this test")
    }
}

/// Every signed-in person has a browser session. Only the owner named in `mac` has a paired Mac.
struct Auth {
    mac: Mutex<Option<Uuid>>,
    credential: Mutex<Option<(Uuid, String)>>,
}
impl CaptureAuthority for Auth {
    fn browser(&self, owner: Uuid, _: &str) -> anyhow::Result<Option<Browser>> {
        Ok(Some(Browser { session_id: owner, expires_at: FAR.into() }))
    }
    fn native(&self, owner: Uuid, _: &str) -> anyhow::Result<Option<Native>> {
        Ok((*self.mac.lock().unwrap() == Some(owner))
            .then(|| Native { device_id: DEVICE.into(), device_name: "Mac".into(), capability_revision: 1, expires_at: FAR.into() }))
    }
    fn recording(&self, owner: Uuid, _: &str, _: i64) -> anyhow::Result<Option<String>> {
        Ok((*self.mac.lock().unwrap() == Some(owner)).then(|| FAR.into()))
    }
    fn processing_route(&self, _: Uuid) -> anyhow::Result<Option<String>> {
        Ok(Some("route-1".into()))
    }
    fn grant_credential(&self, owner: Uuid, _: &str) -> anyhow::Result<Option<String>> {
        Ok(self.credential.lock().unwrap().as_ref().filter(|(who, _)| *who == owner).map(|(_, text)| text.clone()))
    }
}

static SERIAL: Mutex<()> = Mutex::new(());

struct World {
    f: support::Fixture,
    app: support::install::Installed,
    auth: Arc<Auth>,
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl World {
    fn new() -> Self {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let f = support::Fixture::new();
        let auth = Arc::new(Auth { mac: Mutex::new(Some(f.a)), credential: Mutex::new(None) });
        let app = install_all(&f, Arc::new(NoAi), None, None, Some(auth.clone()));
        Self { f, app, auth, _serial: serial }
    }
    fn call(&self, actor: Uuid, method: &str, target: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {target}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    fn count(&self, sql: &str) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[])).unwrap().get(0)
    }
    fn meeting(&self, actor: Uuid, title: &str) -> String {
        let made = self.call(actor, "POST", "/records", json!({"requestKey": Uuid::new_v4().to_string(), "title": title}));
        made["body"]["meeting"]["id"].as_str().unwrap_or_else(|| panic!("{made}")).to_owned()
    }
    /// Claims the grant with the hash of a credential that names `owner` and the grant, then makes
    /// that credential the one the stand-in presents.
    fn pair_credential(&self, owner: Uuid, grant: &str) -> String {
        let credential = format!("mm1_{owner}.{grant}.{SECRET}");
        let hash = sha2::Sha256::digest(credential.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let poll = self.call(owner, "POST", "/capture/commands", json!({"connectionId": CONN, "verifier": SECRET}));
        assert_eq!(poll["body"]["command"]["grantId"], grant, "{poll}");
        let claim = self.call(owner, "POST", "/capture/claim", json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": hash}));
        assert_eq!(claim["status"], 200, "{claim}");
        *self.auth.credential.lock().unwrap() = Some((owner, credential.clone()));
        credential
    }
    fn link(&self, actor: Uuid) {
        let inventory = json!({
            "defaultMicrophoneId": "mic-uid",
            "microphones": [{"deviceId": "mic-uid", "sourceId": "mic", "label": "Microphone"}],
            "applications": [],
            "computerAudio": {"available": true, "excludedProcessTreeIds": ["moss"]},
            "microphonePermission": "granted", "systemAudioPermission": "granted",
        });
        let hash = sha2::Sha256::digest(SECRET.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let done = self.call(actor, "POST", "/capture/connection", json!({"connectionId": CONN, "verifierHash": hash, "inventory": inventory}));
        assert_eq!(done["status"], 200, "{done}");
    }
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn a_link_start_cancel_and_claim_run_against_the_real_database() {
    let w = World::new();
    let a = w.f.a;
    w.link(a);
    let devices = w.call(a, "GET", "/capture/devices", Value::Null);
    assert_eq!(devices["body"]["devices"].as_array().unwrap().len(), 1, "{devices}");
    assert_eq!(devices["body"]["processingReady"], true);
    let meeting = w.meeting(a, "Weekly");
    let start = |key: &str| w.call(a, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": key}));
    let first = start(K1);
    assert_eq!(first["status"], 200, "{first}");
    let again = start(K1);
    assert_eq!(again["body"]["capture"]["grantId"], first["body"]["capture"]["grantId"], "{again}");
    // Two charged starts leave one limits row whose list holds two instants.
    assert_eq!(w.count("SELECT count(*) FROM app.meeting_capture_start_limits"), 1);
    assert_eq!(w.count("SELECT cardinality(started_at)::bigint FROM app.meeting_capture_start_limits"), 2);
    // The maintenance check is queued with the grant id and a sequence only.
    let payloads = w.f.rt.block_on(w.f.root.query("SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%capture-maintenance%'", &[])).unwrap();
    assert!(!payloads.is_empty());
    for row in &payloads {
        let p: Value = serde_json::from_str(&row.get::<_, String>(0)).unwrap();
        let found = holder(&p).unwrap_or_else(|| panic!("no grant-id in {p}"));
        let keys: Vec<&String> = found.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["grant-id", "sequence"], "{p}");
    }
    // The Mac polls, claims, and a second claim with another credential conflicts.
    let poll = w.call(a, "POST", "/capture/commands", json!({"connectionId": CONN, "verifier": SECRET}));
    let grant = poll["body"]["command"]["grantId"].as_str().unwrap_or_else(|| panic!("{poll}")).to_owned();
    let claim = |hash: &str| w.call(a, "POST", "/capture/claim", json!({"connectionId": CONN, "verifier": SECRET, "grantId": grant, "credentialHash": hash}));
    assert_eq!(claim(&"a".repeat(64))["status"], 200);
    assert_eq!(claim(&"b".repeat(64))["status"], 409);
    assert_eq!(w.count(&format!("SELECT count(*) FROM app.meeting_capture_grants WHERE id = '{grant}' AND status = 'active'")), 1);
    // Cancelling a key that never started records the cancellation, and a late start with it conflicts.
    let cancel = w.call(a, "POST", &format!("/records/{meeting}/capture/cancel-start"), json!({"requestKey": K2}));
    assert_eq!(cancel["body"]["cancelled"], true, "{cancel}");
    assert_eq!(w.count("SELECT count(*) FROM app.meeting_capture_start_cancellations"), 1);
    assert_eq!(start(K2)["status"], 409);
    // The old relink routes answer 410.
    let gone = w.call(a, "POST", "/recording-capability/attempt", json!({"requestKey": K1, "proofHash": "a".repeat(64), "policyVersion": 1}));
    assert_eq!(gone["status"], 410, "{gone}");
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn another_person_cannot_see_or_change_a_link_and_row_security_is_the_reason() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    w.link(a);
    let meeting = w.meeting(a, "Private");
    let started = w.call(a, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": K1}));
    assert_eq!(started["status"], 200, "{started}");
    let grant = started["body"]["capture"]["grantId"].as_str().unwrap().to_owned();

    let theirs = w.call(b, "GET", "/capture/devices", Value::Null);
    assert_eq!(theirs["body"]["devices"].as_array().unwrap().len(), 0, "{theirs}");
    assert_ne!(w.call(b, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": K2}))["status"], 200);
    let stopped = w.call(b, "POST", &format!("/records/{meeting}/capture/cancel-start"), json!({"requestKey": K1}));
    assert_ne!(stopped["status"], 200, "{stopped}");
    assert_eq!(w.count(&format!("SELECT count(*) FROM app.meeting_capture_grants WHERE id = '{grant}' AND status = 'approved'")), 1);

    let rows_seen_by = |actor: Uuid, table: &str| -> i64 {
        w.f.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(&w.f.db, &w.f.access(actor)).await.unwrap();
            cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0)
        })
    };
    for table in ["app.meeting_capture_grants", "app.meeting_capture_connections", "app.meeting_capture_start_limits"] {
        assert_eq!(rows_seen_by(b, table), 0, "{table}: visible before the test removed protection");
        assert!(rows_seen_by(a, table) > 0, "{table}: owner cannot see own rows");
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let leaked = rows_seen_by(b, table);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(leaked > 0, "RED expected: {table} shows another person's rows with row security removed");
        println!("RED {table}: another person sees {leaked} row(s) with row security removed");
        assert_eq!(rows_seen_by(b, table), 0, "{table}: not restored");
        println!("GREEN {table}: row security restored");
    }
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn meeting_text_stays_out_of_queued_work_activity_and_link_rows() {
    let w = World::new();
    let a = w.f.a;
    w.link(a);
    let meeting = w.meeting(a, MARK);
    let noted = w.call(a, "PUT", &format!("/records/{meeting}/notes"), json!({"requestKey": K2, "expectedRevision": 0, "personalNotes": MARK}));
    assert_eq!(noted["status"], 200, "{noted}");
    let started = w.call(a, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": K1}));
    assert_eq!(started["status"], 200, "{started}");
    let refused = w.call(a, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": "bad"}));
    w.call(a, "POST", &format!("/records/{meeting}/capture/cancel-start"), json!({"requestKey": K1}));
    for answer in [&started, &refused] {
        assert!(!answer.to_string().contains(MARK), "{answer}");
    }
    let count = |t: &str| format!("SELECT CASE WHEN to_regclass('{t}') IS NULL THEN 0 ELSE (SELECT count(*) FROM {t} x WHERE x::text LIKE '%{MARK}%') END");
    let tables = [
        "moss_queue.jobs", "app.moss_activity_detail", "app.moss_model_activity_log", "app.meeting_capture_grants",
        "app.meeting_capture_connections", "app.meeting_capture_start_cancellations", "app.meeting_capture_start_limits",
    ];
    let found: Vec<(&str, i64)> = tables.iter().map(|t| (*t, w.count(&count(t)))).collect();
    let leaked: i64 = found.iter().map(|(_, n)| n).sum();
    assert_eq!(leaked, 0, "meeting text reached queued work, activity or link rows: {found:?}");
    let _ = &w.auth;
}

/// The object that carries the grant id, wherever the queue nests the command parameters.
fn holder(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(m) if m.contains_key("grant-id") => Some(v),
        Value::Object(m) => m.values().find_map(holder),
        Value::Array(a) => a.iter().find_map(holder),
        _ => None,
    }
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn the_mac_sends_status_control_and_audio_with_its_credential_against_the_real_database() {
    let w = World::new();
    let a = w.f.a;
    w.link(a);
    let meeting = w.meeting(a, "Standup");
    let started = w.call(a, "POST", &format!("/records/{meeting}/capture/start"), json!({"requestKey": K1}));
    assert_eq!(started["status"], 200, "{started}");
    let grant = started["body"]["capture"]["grantId"].as_str().unwrap().to_owned();
    let generation = w.count(&format!("SELECT coalesce((state_json::jsonb->>'generation')::bigint, 1) FROM app.meeting_capture_grants WHERE id = '{grant}'"));
    // Without a credential every Mac call is the same 401.
    let inventory = json!({
        "defaultMicrophoneId": "mic-uid",
        "microphones": [{"deviceId": "mic-uid", "sourceId": "mic", "label": "Microphone"}],
        "applications": [],
        "computerAudio": {"available": true, "excludedProcessTreeIds": ["moss"]},
        "microphonePermission": "granted", "systemAudioPermission": "granted",
    });
    let status = |phase: &str| {
        w.call(a, "POST", "/capture/status", json!({"meetingId": meeting, "grantId": grant, "inventory": inventory, "observed": {"generation": generation, "phase": phase}}))
    };
    let early = status("recording");
    assert_eq!(early["status"], 401, "{early}");
    w.pair_credential(a, &grant);
    let ok = status("recording");
    assert_eq!(ok["status"], 200, "{ok}");
    // A credential for another grant is refused.
    *w.auth.credential.lock().unwrap() = Some((a, format!("mm1_{a}.{}.{SECRET}", Uuid::new_v4())));
    assert_eq!(status("recording")["status"], 401);
    *w.auth.credential.lock().unwrap() = Some((a, format!("mm1_{a}.{grant}.{}", "Z".repeat(43))));
    assert_eq!(status("recording")["status"], 401, "wrong secret must be refused");
    *w.auth.credential.lock().unwrap() = Some((a, format!("mm1_{a}.{grant}.{SECRET}")));
    // Control and audio.
    let paused = w.call(a, "POST", "/capture/control", json!({"meetingId": meeting, "grantId": grant, "requestKey": K2, "expectedGeneration": generation, "command": "pause"}));
    assert_eq!(paused["status"], 200, "{paused}");
    let generation = w.count(&format!("SELECT coalesce((state_json::jsonb->>'generation')::bigint, 1) FROM app.meeting_capture_grants WHERE id = '{grant}'"));
    let samples: Vec<u8> = (0..8000i32).flat_map(|n| ((((n % 100) - 50) * 100) as i16).to_le_bytes()).collect();
    let audio = w.call(a, "POST", "/capture/audio", json!({
        "meetingId": meeting, "grantId": grant, "requestKey": Uuid::new_v4().to_string(), "generation": generation, "epoch": 1,
        "sourceId": "mic", "sequence": 0, "startMs": 0, "endMs": 1000, "sampleRateHz": 8000,
        "pcmBase64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &samples),
    }));
    assert!(audio["status"].as_i64().is_some(), "{audio}");
    println!("AUDIO answer: {audio}");
    assert_eq!(w.count(&format!("SELECT count(*) FROM moss_queue.jobs x WHERE x::text LIKE '%{}%'", "pcmBase64")), 0);
    // Another person with their own credential for this grant is refused.
    *w.auth.credential.lock().unwrap() = Some((w.f.b, format!("mm1_{}.{grant}.{SECRET}", w.f.b)));
    let theirs = w.call(w.f.b, "POST", "/capture/status", json!({"meetingId": meeting, "grantId": grant, "inventory": inventory, "observed": {"generation": generation, "phase": "recording"}}));
    assert_eq!(theirs["status"], 401, "{theirs}");
}
