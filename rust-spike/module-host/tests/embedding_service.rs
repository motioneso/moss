//! The host embedding service, reached the way a guest reaches it: through the real component
//! host and the embed port, against a fake model on this machine.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use common::fake_embedding_model::{axis, FakeEmbeddingModel, Mode};
use moss_module_host::{
    ai::{
        EmbeddingActivity, EmbeddingCall, EmbeddingEndpoint, EmbeddingStore, Intelligence,
        RouterIntelligence, DEFAULT_EMBEDDING_MODEL, NOT_SET_UP,
    },
    local::LocalPorts,
    manifest::{Capability, Manifest},
    runtime::{CallScope, Host, Limits, Request},
    services::ServicePorts,
};
use moss_platform_contracts::Actor;
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

const CREDENTIAL: &str = "sk-credential-marker-7f3a91";
const MARKER: &str = "planted-private-marker-5c2e08";

struct Store {
    url: Option<url::Url>,
    model: String,
    version: Option<String>,
}
#[async_trait::async_trait]
impl EmbeddingStore for Store {
    async fn for_actor(&self, _: Actor) -> Result<EmbeddingEndpoint> {
        let Some(url) = self.url.clone() else {
            anyhow::bail!(NOT_SET_UP)
        };
        Ok(EmbeddingEndpoint {
            url,
            model: self.model.clone(),
            version: self.version.clone(),
            credential: Secret::new(CREDENTIAL.to_owned()),
        })
    }
}
#[derive(Default)]
struct Rows(Mutex<Vec<String>>);
#[async_trait::async_trait]
impl EmbeddingActivity for Rows {
    async fn record(&self, call: EmbeddingCall) {
        self.0.lock().unwrap().push(format!(
            "{}|{}|{}|{}",
            call.model, call.action, call.outcome, call.result
        ));
    }
}
struct NoAi;
#[async_trait::async_trait]
impl moss_platform_routing::ConfigurationStore for NoAi {
    async fn for_actor(
        &self,
        _: Actor,
    ) -> std::result::Result<moss_platform_routing::Configuration, moss_platform_contracts::Error>
    {
        Ok(Default::default())
    }
}
#[async_trait::async_trait]
impl moss_platform_routing::CapabilityTransport for NoAi {
    async fn generate(
        &self,
        _: Actor,
        _: &moss_platform_routing::Model,
        _: &[moss_platform_routing::Turn],
        _: u32,
    ) -> std::result::Result<String, moss_platform_contracts::Error> {
        Err(moss_platform_contracts::Error::Unavailable)
    }
}

struct Fixture {
    _data: tempfile::TempDir,
    services: Arc<ServicePorts>,
    intelligence: Arc<RouterIntelligence<NoAi, NoAi, Store>>,
    manifest: Manifest,
    host: Host,
    rows: Arc<Rows>,
}
fn fixture(store: Store) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let rows = Arc::new(Rows::default());
    let intelligence = Arc::new(
        RouterIntelligence::new(NoAi, NoAi, store)
            .unwrap()
            .with_activity(rows.clone()),
    );
    struct Shared(Arc<RouterIntelligence<NoAi, NoAi, Store>>);
    impl Intelligence for Shared {
        fn generate(&self, s: &CallScope, r: &Request) -> Result<Value> {
            self.0.generate(s, r)
        }
        fn embed(&self, s: &CallScope, r: &Request) -> Result<Value> {
            self.0.embed(s, r)
        }
        fn embedding_model(&self, s: &CallScope) -> Result<(String, String)> {
            self.0.embedding_model(s)
        }
    }
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(Shared(intelligence.clone())),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let mut manifest = common::manifest("1.0.0");
    manifest.capabilities.push(Capability {
        port: "embed".into(),
        operations: ["create".into()].into(),
        resources: ["embeddings".into()].into(),
        allow_private: false,
    });
    Fixture {
        _data: data,
        services,
        intelligence,
        manifest,
        host: Host::new(Limits::default()).unwrap(),
        rows,
    }
}
impl Fixture {
    fn embed(&self, parameters: Value) -> Result<Value> {
        let wasm = wat::parse_str(
            include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/embed@"),
        )?;
        let request = json!({"operation":"create","resource":"embeddings","parameters":parameters});
        let out = self.host.call(
            &wasm,
            Arc::new(self.manifest.clone()),
            AccessContext::new(uuid::Uuid::new_v4(), "embedding-test"),
            self.services.clone(),
            "route",
            &request.to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
}
fn model_store(fake: &FakeEmbeddingModel) -> Store {
    Store {
        url: Some(fake.url.parse().unwrap()),
        model: DEFAULT_EMBEDDING_MODEL.into(),
        version: None,
    }
}
fn start() -> FakeEmbeddingModel {
    FakeEmbeddingModel::start(BTreeMap::from([("alpha".to_owned(), axis(0))]))
}

#[test]
fn documents_and_queries_carry_their_prefix() {
    let fake = start();
    let f = fixture(model_store(&fake));
    f.embed(json!({"text":"alpha"})).unwrap();
    f.embed(json!({"text":"alpha","kind":"document"})).unwrap();
    let reply = f.embed(json!({"text":"alpha","kind":"query"})).unwrap();
    assert_eq!(
        *fake.received.lock().unwrap(),
        ["search_document: alpha", "search_document: alpha", "search_query: alpha"]
    );
    // The hand-made vector answers for the text without its prefix.
    assert_eq!(reply["embedding"][0], 1.0);
    assert!(f.embed(json!({"text":"alpha","kind":"other"})).is_err());
}

#[test]
fn only_exactly_768_finite_numbers_are_accepted() {
    let fake = start();
    let f = fixture(model_store(&fake));
    assert_eq!(f.embed(json!({"text":"ok"})).unwrap()["embedding"].as_array().unwrap().len(), 768);
    for mode in [Mode::WrongSize, Mode::Empty, Mode::NullValue, Mode::Oversize, Mode::ServerError] {
        fake.set_mode(mode);
        assert!(f.embed(json!({"text":"ok"})).is_err());
    }
    let long = "x".repeat(64 * 1024 + 1);
    let before = fake.received.lock().unwrap().len();
    assert!(f.embed(json!({"text":long})).is_err());
    assert!(f.embed(json!({"text":""})).is_err());
    assert_eq!(fake.received.lock().unwrap().len(), before);
    let rows = f.rows.0.lock().unwrap();
    assert_eq!(rows.iter().filter(|r| r.contains("|ok|")).count(), 1);
    assert_eq!(rows.iter().filter(|r| r.contains("|error|")).count(), 5);
}

#[test]
fn text_and_credential_never_reach_activity_or_answers() {
    let fake = start();
    let f = fixture(model_store(&fake));
    let mut seen = vec![f.embed(json!({"text":MARKER})).unwrap().to_string()];
    for mode in [Mode::WrongSize, Mode::NullValue, Mode::ServerError] {
        fake.set_mode(mode);
        seen.push(format!("{:?}", f.embed(json!({"text":MARKER}))));
    }
    seen.extend(f.rows.0.lock().unwrap().iter().cloned());
    assert_eq!(f.rows.0.lock().unwrap().len(), 4);
    // The fake did receive the marker and the credential, so the checks below can fail.
    assert!(fake.received.lock().unwrap().iter().all(|t| t.contains(MARKER)));
    assert!(fake.tokens.lock().unwrap().iter().all(|t| t.contains(CREDENTIAL)));
    for text in &seen {
        assert!(!text.contains(MARKER), "{text}");
        assert!(!text.contains(CREDENTIAL), "{text}");
    }
}

#[test]
fn model_name_and_version_follow_configuration() {
    let fake = start();
    let scope_free = |store: Store| {
        let f = fixture(store);
        let reply = f.embed(json!({"text":"a"})).unwrap();
        (reply["model"].as_str().unwrap().to_owned(), reply["version"].as_str().unwrap().to_owned(), f)
    };
    let (m, v, f) = scope_free(model_store(&fake));
    assert_eq!((m.as_str(), v.as_str()), (DEFAULT_EMBEDDING_MODEL, "1.5"));
    assert_eq!(f.rows.0.lock().unwrap()[0], format!("{DEFAULT_EMBEDDING_MODEL}|embed document|ok|"));
    let other = |version: Option<&str>| Store {
        url: Some(fake.url.parse().unwrap()),
        model: "bge-small".into(),
        version: version.map(str::to_owned),
    };
    let (m, v, _) = scope_free(other(None));
    assert_eq!((m.as_str(), v.as_str()), ("bge-small", "1"));
    let (_, v, _) = scope_free(other(Some("2.3")));
    assert_eq!(v, "2.3");
    let _ = f.intelligence;
}

#[test]
fn an_unset_endpoint_refuses_and_records_nothing() {
    let f = fixture(Store {
        url: None,
        model: String::new(),
        version: None,
    });
    let error = f.embed(json!({"text":"a"})).unwrap_err();
    // A guest only ever sees the generic refusal. The plain wording is checked where the
    // settings screen reads it.
    assert_eq!(error.to_string(), "The module could not finish this request");
    assert!(f.rows.0.lock().unwrap().is_empty());
}

#[test]
fn plain_http_is_accepted_only_on_this_machine() {
    use moss_module_host::ai::valid_endpoint_url as ok;
    assert!(ok("https://embeddings.example.test/v1/embeddings"));
    assert!(ok("http://127.0.0.1:5200/v1/embeddings"));
    assert!(ok("http://localhost:5200/v1/embeddings"));
    assert!(ok("http://[::1]:5200/v1/embeddings"));
    assert!(!ok("http://embeddings.example.test/v1/embeddings"));
    assert!(!ok("http://192.168.1.20:5200/v1/embeddings"));
    assert!(!ok("https://user:pass@embeddings.example.test/"));
    assert!(!ok("ftp://127.0.0.1/"));
}
