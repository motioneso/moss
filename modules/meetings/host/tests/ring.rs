//! Ring receivers against the installed Meetings package and a real database: resumable uploads,
//! imports, voice recordings and the import job. The model and the voice Chat are scripted.
//! Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use access_context::AccessContext;
use moss_meetings_host::chat::{VoiceChat, VoiceRequest};
use moss_module_host::{
    ai::Intelligence,
    runtime::{CallScope, Request},
    staged::stage_body,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use support::install::install_ring;
use uuid::Uuid;

const MARK: &str = "PLANTED-RING-MARKER-5b81";
const CHUNK: usize = 1024 * 1024;

/// Answers `availability` and `create`. Each window gets the next scripted line.
struct Speech {
    lines: Mutex<Vec<String>>,
    seen: Mutex<Vec<usize>>,
}
impl Intelligence for Speech {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No text model in this test")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings in this test")
    }
    fn transcribe(&self, _: &CallScope, r: &Request) -> anyhow::Result<Value> {
        if r.operation == "availability" {
            return Ok(json!({"available": true, "route": "route-1", "model": "scripted"}));
        }
        let audio = r.parameters["audioBase64"].as_str().unwrap_or_default();
        self.seen.lock().unwrap().push(audio.len());
        let mut lines = self.lines.lock().unwrap();
        let text = if lines.is_empty() { String::new() } else { lines.remove(0) };
        Ok(json!({"ok": true, "route": "route-1", "segments": [{"startMs": 0, "endMs": 900, "text": text}]}))
    }
}

/// Keeps every voice request handed off.
#[derive(Default)]
struct Voice(Mutex<Vec<(Uuid, String, bool, String)>>);
impl VoiceChat for Voice {
    fn hand_off(&self, owner: Uuid, r: &VoiceRequest) -> anyhow::Result<String> {
        self.0.lock().unwrap().push((owner, r.transcript.to_owned(), r.automatic, r.state.to_owned()));
        Ok(Uuid::new_v4().to_string())
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A canonical 16 kHz mono 16-bit WAV of `ms` milliseconds of silence.
fn wav(ms: usize) -> Vec<u8> {
    let body = ms * 32;
    let mut out = Vec::with_capacity(44 + body);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + body) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16000u32.to_le_bytes());
    out.extend_from_slice(&32000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(body as u32).to_le_bytes());
    out.resize(44 + body, 0);
    out
}

fn packets() -> Vec<u8> {
    vec![0, 3, 1, 2, 3, 1, 2, 4, 5]
}

/// A ring sidecar whose clock starts at `start` seconds and runs `ms` milliseconds.
fn sidecar(start: u64, ms: u64) -> Vec<u8> {
    format!(
        "{{\"record\":[\"{start}\",\"start\"]}},{{\"btn\":[\"{}\",\"1\"]}},{{\"record\":[\"{}\",\"end\"]}},{{\"duration\":[\"{}\",\"{ms}\"]}}",
        start + 1,
        start + ms / 1000,
        start + ms / 1000
    )
    .into_bytes()
}

struct Files {
    packets: Vec<u8>,
    sidecar: Vec<u8>,
    wav: Vec<u8>,
}
impl Files {
    fn new(ms: usize) -> Self {
        Self { packets: packets(), sidecar: sidecar(1_700_000_000, ms as u64), wav: wav(ms) }
    }
    fn manifest(&self, device: &str, recording: &str, destination: Value) -> Value {
        let file = |b: &[u8]| json!({"byteLength": b.len(), "sha256": hex(b)});
        json!({"version": 3, "sourceDeviceId": device, "recordingId": recording, "destination": destination,
            "packets": file(&self.packets), "sidecar": file(&self.sidecar), "wav": file(&self.wav)})
    }
    fn part(&self, kind: &str) -> &[u8] {
        match kind {
            "packets" => &self.packets,
            "sidecar" => &self.sidecar,
            _ => &self.wav,
        }
    }
}

struct World {
    f: support::Fixture,
    app: support::install::Installed,
    speech: Arc<Speech>,
    voice: Arc<Voice>,
    _files: tempfile::TempDir,
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        let speech = Arc::new(Speech { lines: Mutex::new(vec![]), seen: Mutex::new(vec![]) });
        let voice = Arc::new(Voice::default());
        let files = tempfile::tempdir().unwrap();
        let app = install_ring(&f, speech.clone(), None, Some((files.path().to_owned(), voice.clone())));
        Self { f, app, speech, voice, _files: files }
    }
    fn call(&self, actor: Uuid, method: &str, target: &str, body: Value) -> Value {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), &body.to_string())
            .unwrap_or_else(|e| panic!("{method} {target}: {e:?}"));
        serde_json::from_str(&text).unwrap()
    }
    /// Sends raw bytes the way the shell does, as a staged binary body.
    fn chunk(&self, actor: Uuid, id: &str, kind: &str, index: usize, bytes: Vec<u8>) -> Value {
        let request = format!("staged:{}", Uuid::new_v4());
        let (_guard, body) = stage_body(&request, bytes);
        let text = self
            .app
            .app
            .dispatch_extended(AccessContext::new(actor, request), "PUT", &format!("/api/m/meetings/recording-uploads/{id}/{kind}/{index}"), &body)
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }
    /// Reserves, sends every chunk and finalizes. Returns the import id.
    fn upload(&self, actor: Uuid, files: &Files, device: &str, recording: &str, destination: Value) -> String {
        let reserved = self.call(actor, "POST", "/recording-uploads", files.manifest(device, recording, destination));
        assert_eq!(reserved["status"], 201, "{reserved}");
        let id = reserved["body"]["id"].as_str().unwrap().to_owned();
        self.send(actor, files, &id);
        let done = self.call(actor, "POST", &format!("/recording-uploads/{id}/finalize"), json!({}));
        assert_eq!(done["status"], 200, "{done}");
        assert_eq!(done["body"]["ready"], true, "{done}");
        id
    }
    fn send(&self, actor: Uuid, files: &Files, id: &str) {
        for kind in ["packets", "sidecar", "wav"] {
            for (index, part) in files.part(kind).chunks(CHUNK).enumerate() {
                let sent = self.chunk(actor, id, kind, index, part.to_vec());
                assert_eq!(sent["status"], 200, "{kind} {index}: {sent}");
            }
        }
    }
    fn run_jobs(&self) {
        let worker = Secret::new(std::env::var("JS48_WORKER_URL").unwrap());
        for _ in 0..80 {
            self.app.app.installer.run_job(&worker).unwrap();
            let waiting = self.count(
                "SELECT count(*) FROM moss_queue.jobs WHERE state IN ('pending','running') AND queue LIKE '%recording-import%' AND (data::text NOT LIKE '%abandoned%')",
            );
            if waiting == 0 {
                return;
            }
        }
        panic!("jobs did not settle");
    }
    fn count(&self, sql: &str) -> i64 {
        self.f.rt.block_on(self.f.root.query_one(sql, &[])).unwrap().get(0)
    }
}

fn ids() -> (String, String) {
    (Uuid::new_v4().to_string(), format!("{:010}_ring-{}", 1_700_000_000u64, &Uuid::new_v4().simple().to_string()[..8]))
}

fn meeting() -> Value {
    json!({"intent": "meeting"})
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn a_meeting_import_resumes_finalizes_and_transcribes() {
    let w = World::new();
    let a = w.f.a;
    let (device, recording) = ids();
    // 45 s of audio makes three transcription windows of at most 20 s.
    let files = Files::new(45_000);
    *w.speech.lines.lock().unwrap() = vec![format!("first {MARK}"), "second".into(), "third".into()];

    let reserved = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    assert_eq!(reserved["status"], 201, "{reserved}");
    let id = reserved["body"]["id"].as_str().unwrap().to_owned();
    assert_eq!(reserved["body"]["chunkBytes"], CHUNK);

    // The same manifest answers with the same upload, and a different one for the same recording conflicts.
    let again = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    assert_eq!(again["body"]["id"], id, "{again}");
    let other = Files::new(46_000);
    let clash = w.call(a, "POST", "/recording-uploads", other.manifest(&device, &recording, meeting()));
    assert_eq!(clash["status"], 409, "{clash}");

    // The wav is 1.4 MB, so it needs two chunks. Send the first, then ask where the upload stands.
    let wav_parts: Vec<&[u8]> = files.wav.chunks(CHUNK).collect();
    assert_eq!(wav_parts.len(), 2);
    assert_eq!(w.chunk(a, &id, "wav", 0, wav_parts[0].to_vec())["status"], 200);
    let early = w.call(a, "POST", &format!("/recording-uploads/{id}/finalize"), json!({}));
    assert_ne!(early["status"], 200, "finalize accepted an incomplete upload: {early}");
    let status = w.call(a, "GET", &format!("/recording-uploads/{id}"), Value::Null);
    assert_eq!(status["body"]["received"], json!({"packets": 0, "sidecar": 0, "wav": 1}), "{status}");

    // A resend of the same chunk is a no-op. Different bytes for the same chunk conflict.
    assert_eq!(w.chunk(a, &id, "wav", 0, wav_parts[0].to_vec())["status"], 200);
    let mut changed = wav_parts[0].to_vec();
    changed[100] ^= 1;
    assert_eq!(w.chunk(a, &id, "wav", 0, changed)["status"], 409);

    // The rest arrives after the "interruption".
    w.send(a, &files, &id);
    let done = w.call(a, "POST", &format!("/recording-uploads/{id}/finalize"), json!({}));
    assert_eq!(done["status"], 200, "{done}");
    assert_eq!(done["body"]["ready"], true);

    w.run_jobs();
    assert_eq!(w.speech.seen.lock().unwrap().len(), 3, "three windows");
    assert!(w.speech.seen.lock().unwrap().iter().all(|n| *n < 900_000), "a window must stay under the message limit");
    let imported = w.call(a, "GET", &format!("/recording-imports/{id}"), Value::Null);
    assert_eq!(imported["body"]["state"], "complete", "{imported}");
    let meeting_id = imported["body"]["meetingId"].as_str().unwrap();
    let transcript = w.call(a, "GET", &format!("/records/{meeting_id}/transcript"), Value::Null);
    assert!(transcript.to_string().contains(MARK), "{transcript}");

    // Reserving the finished recording again finds the same import and does not transcribe again.
    let replay = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    assert_eq!(replay["body"]["id"], id, "{replay}");
    w.run_jobs();
    assert_eq!(w.speech.seen.lock().unwrap().len(), 3);
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn size_range_and_audio_limits_are_enforced() {
    let w = World::new();
    let a = w.f.a;
    let (device, recording) = ids();
    let files = Files::new(2_000);
    let reserved = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    let id = reserved["body"]["id"].as_str().unwrap().to_owned();
    // Wrong length, past the last chunk, unknown file kind, and an index with a leading zero.
    assert_eq!(w.chunk(a, &id, "wav", 0, vec![0; 10])["status"], 400);
    assert_eq!(w.chunk(a, &id, "wav", 1, vec![0; 10])["status"], 400);
    assert_eq!(w.chunk(a, &id, "video", 0, vec![0; 10])["status"], 400);
    assert_eq!(w.chunk(a, &id, "packets", 7, files.packets.clone())["status"], 400);
    // More than two hours of audio is refused at reserve time.
    let long = Files { packets: packets(), sidecar: sidecar(1_700_000_000, 2_000), wav: wav(7_200_001) };
    let (d2, r2) = ids();
    let refused = w.call(a, "POST", "/recording-uploads", long.manifest(&d2, &r2, meeting()));
    assert_eq!(refused["status"], 413, "{refused}");
    // A manifest with a wav that is not whole 1 ms steps is invalid.
    let mut odd = Files::new(2_000);
    odd.wav.push(0);
    let (d3, r3) = ids();
    assert_eq!(w.call(a, "POST", "/recording-uploads", odd.manifest(&d3, &r3, meeting()))["status"], 400);
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn a_bad_wav_or_packet_stream_is_refused_at_finalize() {
    let w = World::new();
    let a = w.f.a;
    for (label, mutate) in [
        ("header", Box::new(|f: &mut Files| f.wav[0] = b'X') as Box<dyn Fn(&mut Files)>),
        ("rate", Box::new(|f: &mut Files| f.wav[24] = 0x80)),
        ("packets", Box::new(|f: &mut Files| f.packets = vec![0, 5, 1])),
    ] {
        let (device, recording) = ids();
        let mut files = Files::new(2_000);
        mutate(&mut files);
        let reserved = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
        if reserved["status"] != 201 {
            continue;
        }
        let id = reserved["body"]["id"].as_str().unwrap().to_owned();
        w.send(a, &files, &id);
        let done = w.call(a, "POST", &format!("/recording-uploads/{id}/finalize"), json!({}));
        assert_eq!(done["status"], 400, "{label}: {done}");
        assert_eq!(done["body"]["code"], "recording_import_invalid", "{label}: {done}");
    }
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn a_voice_recording_waits_for_enablement_and_hands_off_text() {
    let w = World::new();
    let a = w.f.a;
    let (device, _) = ids();
    let recording = format!("amsg_{:010}_voice-1", 1_700_000_000u64);
    let files = Files::new(3_000);
    let voice_destination = |enablement: &str| json!({"intent": "voice-request", "enablementId": enablement, "capturedAt": null});

    // Without an enablement a voice recording cannot be reserved as a meeting or a voice request.
    let none = w.call(a, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    assert_eq!(none["status"], 409, "{none}");
    assert_eq!(none["body"]["code"], "voice_recording_ineligible");

    let enabled = w.call(a, "POST", "/voice-enablement", json!({"version": 2, "sourceDeviceId": device, "requestKey": "k1", "recordingIds": []}));
    assert_eq!(enabled["status"], 201, "{enabled}");
    let enablement = enabled["body"]["id"].as_str().unwrap().to_owned();
    // The same request replays; a changed inventory with the same key conflicts.
    let replay = w.call(a, "POST", "/voice-enablement", json!({"version": 2, "sourceDeviceId": device, "requestKey": "k1", "recordingIds": []}));
    assert_eq!(replay["body"]["id"], enablement.as_str());
    let clash = w.call(a, "POST", "/voice-enablement", json!({"version": 2, "sourceDeviceId": device, "requestKey": "k1", "recordingIds": [recording.clone()]}));
    assert_eq!(clash["status"], 409);

    *w.speech.lines.lock().unwrap() = vec![format!("what is next {MARK}")];
    let id = w.upload(a, &files, &device, &recording, voice_destination(&enablement));
    w.run_jobs();
    let imported = w.call(a, "GET", &format!("/recording-imports/{id}"), Value::Null);
    assert_eq!(imported["body"]["state"], "complete", "{imported}");
    // The transcript went to Chat and nowhere in the response.
    assert!(!imported.to_string().contains(MARK), "{imported}");
    let handed = w.voice.0.lock().unwrap().clone();
    assert_eq!(handed.len(), 1);
    assert_eq!(handed[0].0, a);
    assert!(handed[0].1.contains(MARK));
    // No capture time was sent, so the request is not dispatched automatically.
    assert!(!handed[0].2);
    let list = w.call(a, "GET", "/voice-recordings", Value::Null);
    assert!(!list.to_string().contains(MARK), "{list}");
    let disabled = w.call(a, "POST", &format!("/voice-enablement/{enablement}/disable"), json!({}));
    assert_eq!(disabled["status"], 200, "{disabled}");
}

#[test]
#[ignore = "run through scripts/run-gate.sh"]
fn another_person_cannot_see_or_change_an_import_and_text_stays_out_of_logs() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let (device, recording) = ids();
    let files = Files::new(3_000);
    *w.speech.lines.lock().unwrap() = vec![format!("private {MARK}")];
    let id = w.upload(a, &files, &device, &recording, meeting());
    w.run_jobs();

    // Another person is told the upload does not exist, and cannot send a chunk or finalize it.
    let target = format!("/recording-uploads/{id}");
    assert_eq!(w.call(b, "GET", &target, Value::Null)["status"], 404);
    assert_eq!(w.call(b, "GET", &format!("/recording-imports/{id}"), Value::Null)["status"], 404);
    assert_eq!(w.call(b, "POST", &format!("{target}/finalize"), json!({}))["status"], 404);
    assert_eq!(w.chunk(b, &id, "wav", 0, files.wav[..CHUNK.min(files.wav.len())].to_vec())["status"], 404);
    // Another person reserving the same recording gets their own import, not a's.
    let theirs = w.call(b, "POST", "/recording-uploads", files.manifest(&device, &recording, meeting()));
    assert_eq!(theirs["status"], 201, "{theirs}");
    assert_ne!(theirs["body"]["id"], id.as_str());

    // With row security off, another person reads a's rows. With it back on they do not.
    let rows_seen_by = |actor: Uuid, table: &str, id: &str| -> i64 {
        w.f.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(&w.f.db, &w.f.access(actor)).await.unwrap();
            cx.db()
                .query_one(&format!("SELECT count(*) FROM {table} WHERE {}::text = $1", if table.ends_with("imports") { "id" } else { "import_id" }), &[&id])
                .await
                .unwrap()
                .get(0)
        })
    };
    for table in ["app.meeting_recording_imports", "app.meeting_recording_chunks"] {
        assert_eq!(rows_seen_by(b, table, &id), 0, "{table}: visible before the test removed protection");
        assert!(rows_seen_by(a, table, &id) > 0, "{table}: owner cannot see own rows");
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let leaked = rows_seen_by(b, table, &id);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(leaked > 0, "RED expected: {table} shows another person's rows with row security removed");
        println!("RED {table}: another person sees {leaked} row(s) with row security removed");
        assert_eq!(rows_seen_by(b, table, &id), 0, "{table}: not restored");
        println!("GREEN {table}: row security restored");
    }

    // The transcript text stays out of queued work, activity rows and the import record.
    let count = |t: &str| format!("SELECT CASE WHEN to_regclass('{t}') IS NULL THEN 0 ELSE (SELECT count(*) FROM {t} x WHERE x::text LIKE '%{MARK}%') END");
    let leaked: i64 = ["moss_queue.jobs", "app.moss_activity_detail", "app.moss_model_activity_log", "app.meeting_recording_imports", "app.meeting_recording_chunks"]
        .iter()
        .map(|t| w.count(&count(t)))
        .sum();
    assert_eq!(leaked, 0, "transcript text reached queued work, activity or import rows");
}
