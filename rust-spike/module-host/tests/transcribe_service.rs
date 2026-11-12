//! The host speech port, reached the way a guest reaches it: through the real component host
//! and the transcribe port, against a fake speech server on this machine.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use common::fake_speech_server::{hex, segments_for, FakeSpeechServer, Mode};
use moss_module_host::{
    ai::{EmbeddingActivity, EmbeddingCall, EmbeddingEndpoint, EmbeddingStore, RouterIntelligence},
    local::LocalPorts,
    manifest::{Capability, Manifest},
    runtime::{Host, Limits},
    services::ServicePorts,
    transcribe::{TranscriptionRoute, TranscriptionStore, MAX_AUDIO_BYTES},
};
use moss_platform_contracts::Actor;
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

const CREDENTIAL: &str = "sk-speech-credential-marker-31b7e2";

/// The route the fake configuration holds. A test changes it to move the route.
struct Route {
    base: Mutex<Option<url::Url>>,
    model: Mutex<String>,
    credential: Mutex<String>,
}
struct Store(Arc<Route>);
#[async_trait::async_trait]
impl TranscriptionStore for Store {
    async fn route(&self, _: Actor) -> Result<TranscriptionRoute> {
        let Some(base) = self.0.base.lock().unwrap().clone() else {
            anyhow::bail!("not set up")
        };
        Ok(TranscriptionRoute {
            base,
            model: self.0.model.lock().unwrap().clone(),
            provider: "provider-one".into(),
            credential: Secret::new(self.0.credential.lock().unwrap().clone()),
        })
    }
}
struct NoEmbeddings;
#[async_trait::async_trait]
impl EmbeddingStore for NoEmbeddings {
    async fn for_actor(&self, _: Actor) -> Result<EmbeddingEndpoint> {
        anyhow::bail!("none")
    }
}
struct NoAi;
#[async_trait::async_trait]
impl moss_platform_routing::ConfigurationStore for NoAi {
    async fn for_actor(&self, _: Actor) -> std::result::Result<moss_platform_routing::Configuration, moss_platform_contracts::Error> {
        Ok(Default::default())
    }
}
#[async_trait::async_trait]
impl moss_platform_routing::CapabilityTransport for NoAi {
    async fn generate(&self, _: Actor, _: &moss_platform_routing::Model, _: &[moss_platform_routing::Turn], _: u32) -> std::result::Result<String, moss_platform_contracts::Error> {
        Err(moss_platform_contracts::Error::Unavailable)
    }
}
#[derive(Default)]
struct Rows(Mutex<Vec<String>>);
#[async_trait::async_trait]
impl EmbeddingActivity for Rows {
    async fn record(&self, call: EmbeddingCall) {
        self.0.lock().unwrap().push(format!("{}|{}|{}|{}", call.model, call.action, call.outcome, call.result));
    }
}

struct Fixture {
    _data: tempfile::TempDir,
    services: Arc<ServicePorts>,
    manifest: Manifest,
    host: Host,
    rows: Arc<Rows>,
    route: Arc<Route>,
}
fn fixture(base: Option<&str>) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let rows = Arc::new(Rows::default());
    let route = Arc::new(Route {
        base: Mutex::new(base.map(|b| b.parse().unwrap())),
        model: Mutex::new("whisper-one".into()),
        credential: Mutex::new(CREDENTIAL.into()),
    });
    let intelligence = RouterIntelligence::new(NoAi, NoAi, NoEmbeddings)
        .unwrap()
        .with_activity(rows.clone())
        .with_transcription(Arc::new(Store(route.clone())));
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(intelligence),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let mut manifest = common::manifest("1.0.0");
    manifest.capabilities.push(Capability {
        port: "transcribe".into(),
        operations: ["create".into(), "availability".into()].into(),
        resources: ["audio".into()].into(),
        allow_private: false,
    });
    Fixture { _data: data, services, manifest, host: Host::new(Limits::default()).unwrap(), rows, route }
}
impl Fixture {
    fn call(&self, operation: &str, parameters: Value) -> Result<Value> {
        let wasm = wat::parse_str(include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/transcribe@"))?;
        let request = json!({"operation":operation,"resource":"audio","parameters":parameters});
        let out = self.host.call(
            &wasm,
            Arc::new(self.manifest.clone()),
            AccessContext::new(uuid::Uuid::new_v4(), "speech-test"),
            self.services.clone(),
            "route",
            &request.to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
    fn route_digest(&self) -> String {
        self.call("availability", json!({})).unwrap()["route"].as_str().unwrap().to_owned()
    }
    fn create(&self, audio: &[u8], extra: Value) -> Value {
        let mut parameters = json!({"audioBase64":STANDARD.encode(audio),"expectedRoute":self.route_digest()});
        for (k, v) in extra.as_object().unwrap() {
            parameters[k] = v.clone();
        }
        self.call("create", parameters).unwrap()
    }
}
fn wav(seed: u8) -> Vec<u8> {
    let mut bytes = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
    bytes.extend((0..4000).map(|i| (i as u32 * 31 + seed as u32) as u8));
    bytes
}

#[test]
fn the_fake_gets_the_exact_bytes_and_the_answer_is_repeatable() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let audio = wav(1);
    let reply = f.create(&audio, json!({"language":"en","prompt":"Moss, Ranger"}));
    assert_eq!(reply["ok"], true, "{reply}");
    let got = fake.received.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].audio, audio);
    assert_eq!(got[0].sha256, hex(&Sha256::digest(&audio)));
    assert_eq!(got[0].path, "/v1/audio/transcriptions");
    assert_eq!(got[0].authorization.to_ascii_lowercase(), format!("authorization: bearer {}", CREDENTIAL.to_ascii_lowercase()));
    let fields = &got[0].fields;
    assert_eq!(fields["model"], "whisper-one");
    assert_eq!(fields["language"], "en");
    assert_eq!(fields["prompt"], "Moss, Ranger");
    assert_eq!(fields["response_format"], "verbose_json");
    assert_eq!(fields["timestamp_granularities[]"], "segment");
    assert_eq!(fields["file-name"], "audio.wav");
    let expected: Vec<Value> = segments_for(&got[0].sha256)
        .iter()
        .map(|s| json!({"startMs":(s["start"].as_f64().unwrap() * 1000.0).round() as i64,"endMs":(s["end"].as_f64().unwrap() * 1000.0).round() as i64,"text":s["text"]}))
        .collect();
    assert_eq!(reply["segments"], json!(expected));
    drop(got);
    let again = f.create(&audio, json!({}));
    assert_eq!(again["segments"], reply["segments"]);
    assert_eq!(fake.received.lock().unwrap().len(), 2);
    // Language and prompt are left out of the form when the package sends none.
    assert!(!fake.received.lock().unwrap()[1].fields.contains_key("language"));
}

#[test]
fn a_moved_route_sends_nothing() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let params = json!({"audioBase64":STANDARD.encode(wav(2)),"expectedRoute":f.route_digest()});
    *f.route.model.lock().unwrap() = "whisper-two".into();
    let reply = f.call("create", params.clone()).unwrap();
    assert_eq!((reply["ok"].clone(), reply["reason"].clone(), reply["stage"].clone()), (json!(false), json!("route-changed"), json!("configuration")));
    *f.route.model.lock().unwrap() = "whisper-one".into();
    *f.route.credential.lock().unwrap() = "another-key".into();
    assert_eq!(f.call("create", params).unwrap()["reason"], "route-changed");
    assert!(fake.received.lock().unwrap().is_empty());
}

#[test]
fn a_route_that_moves_during_the_request_is_refused_after_the_answer() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let route = f.route.clone();
    *fake.on_request.lock().unwrap() = Some(Box::new(move || *route.model.lock().unwrap() = "whisper-two".into()));
    let reply = f.create(&wav(3), json!({}));
    assert_eq!((reply["reason"].clone(), reply["stage"].clone(), reply["retryable"].clone()), (json!("route-changed"), json!("response"), json!(false)));
    assert!(reply.get("segments").is_none());
    assert_eq!(fake.received.lock().unwrap().len(), 1);
}

#[test]
fn every_refusal_has_its_reason_stage_and_retry_flag() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let cases = [
        (Mode::Status(401), "provider-authentication", "response", false),
        (Mode::Status(403), "provider-authentication", "response", false),
        (Mode::Status(429), "provider-rate-limited", "response", true),
        (Mode::Status(408), "provider-timeout", "response", true),
        (Mode::Status(500), "provider-unavailable", "response", true),
        (Mode::Status(503), "provider-unavailable", "response", true),
        (Mode::Status(404), "provider-response-invalid", "response", false),
        (Mode::Status(400), "provider-response-invalid", "response", false),
        (Mode::NotJson, "provider-response-invalid", "validation", false),
        (Mode::NoSegments, "provider-response-invalid", "validation", false),
        (Mode::BadSegment, "provider-response-invalid", "validation", false),
        (Mode::BackwardsSegment, "provider-response-invalid", "validation", false),
        (Mode::TooManySegments, "provider-response-invalid", "validation", false),
        (Mode::TooMuchText, "provider-response-invalid", "response", false),
        (Mode::Oversize, "provider-response-invalid", "response", false),
    ];
    for (mode, reason, stage, retry) in cases {
        fake.set_mode(mode.clone());
        let reply = f.create(&wav(4), json!({}));
        let shown = (reply["reason"].as_str().unwrap_or_default().to_owned(), reply["stage"].as_str().unwrap_or_default().to_owned(), reply["retryable"].as_bool());
        let status = if let Mode::Status(code) = mode { code.to_string() } else { String::new() };
        // A body over the text limit is over the 2 MiB limit too, so it stops at the response.
        let stage = if matches!(mode, Mode::TooMuchText) && shown.1 == "validation" { "validation" } else { stage };
        assert_eq!(shown, (reason.to_owned(), stage.to_owned(), Some(retry)), "status {status} {reply}");
        assert_eq!(reply["ok"], false);
    }
}

#[test]
fn a_bad_clip_or_missing_setup_is_refused_before_anything_is_sent() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let digest = f.route_digest();
    for audio in [String::new(), "not base64 !!".to_owned()] {
        let reply = f.call("create", json!({"audioBase64":audio,"expectedRoute":digest})).unwrap();
        assert_eq!((reply["reason"].clone(), reply["stage"].clone()), (json!("invalid-audio"), json!("validation")), "{reply}");
    }
    // A clip over the old 3.8 MB limit is stopped by the 1 MiB module message limit before the port sees it.
    let huge = STANDARD.encode(vec![0u8; MAX_AUDIO_BYTES + 1]);
    let refused = f.call("create", json!({"audioBase64":huge,"expectedRoute":digest})).unwrap_err().to_string();
    assert!(refused.contains("too large"), "{refused}");
    // A large clip that fits the test guest goes through.
    assert_eq!(f.call("create", json!({"audioBase64":STANDARD.encode(vec![7u8; 30_000]),"expectedRoute":digest})).unwrap()["ok"], true);
    assert_eq!(fake.received.lock().unwrap().len(), 1);
    let none = fixture(None);
    assert_eq!(none.call("availability", json!({})).unwrap(), json!({"available":false}));
    let reply = none.call("create", json!({"audioBase64":STANDARD.encode(wav(5)),"expectedRoute":digest})).unwrap();
    assert_eq!((reply["reason"].clone(), reply["stage"].clone()), (json!("configuration-unavailable"), json!("configuration")));
}

#[test]
fn a_package_cannot_choose_the_model_or_send_a_malformed_request() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let digest = f.route_digest();
    let audio = STANDARD.encode(wav(6));
    for bad in [
        json!({"audioBase64":audio,"expectedRoute":digest,"model":"gpt-x"}),
        json!({"audioBase64":audio,"expectedRoute":digest,"provider":"x"}),
        json!({"audioBase64":audio,"expectedRoute":digest,"url":"http://example.com"}),
        json!({"audioBase64":audio}),
        json!({"audioBase64":audio,"expectedRoute":"short"}),
        json!({"audioBase64":audio,"expectedRoute":digest,"language":"x".repeat(33)}),
        json!({"audioBase64":audio,"expectedRoute":digest,"prompt":"x".repeat(4097)}),
        json!({"expectedRoute":digest}),
        json!([]),
    ] {
        assert!(f.call("create", bad).is_err());
    }
    assert!(f.call("availability", json!({"x":1})).is_err());
    assert!(f.call("delete", json!({})).is_err());
    assert!(fake.received.lock().unwrap().is_empty());
}

#[test]
fn activity_rows_and_answers_never_carry_audio_text_or_the_credential() {
    let fake = FakeSpeechServer::start();
    let f = fixture(Some(&fake.url));
    let reply = f.create(&wav(8), json!({"prompt":"private-vocabulary-marker"}));
    fake.set_mode(Mode::Status(500));
    f.create(&wav(8), json!({}));
    let rows = f.rows.0.lock().unwrap().join("\n");
    assert_eq!(rows.lines().count(), 2, "{rows}");
    assert!(rows.contains("whisper-one|transcribe|ok|4020 bytes") || rows.contains("whisper-one|transcribe|ok|"), "{rows}");
    assert!(rows.contains("whisper-one|transcribe|error|provider-unavailable"), "{rows}");
    let segment_text = reply["segments"][0]["text"].as_str().unwrap();
    for secret in [CREDENTIAL, "private-vocabulary-marker", segment_text] {
        assert!(!rows.contains(secret), "{secret} reached activity");
    }
    assert!(!reply.to_string().contains(CREDENTIAL));
    assert!(!f.call("availability", json!({})).unwrap().to_string().contains(CREDENTIAL));
}
