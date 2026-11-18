//! Gate-only HTTP host. Authentication is synthetic; production auth belongs to JS-38.
use async_trait::async_trait;
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use moss_platform_adapters::{Endpoint, EndpointStore, HttpAdapters, Protocol, Secret};
use moss_platform_contracts::{Actor, Error, QueueSpec};
use moss_platform_registry::{Manifest, Registry, Route};
use moss_platform_routing::{
    lookup, Capability, CapabilityTransport, Configuration, ConfigurationStore, Model, Tier, Turn,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tokio::sync::RwLock;
use uuid::Uuid;
#[derive(Clone, Default)]
struct Data {
    configs: Arc<RwLock<BTreeMap<Uuid, Configuration>>>,
}
#[async_trait]
impl ConfigurationStore for Data {
    async fn for_actor(&self, actor: Actor) -> Result<Configuration, Error> {
        self.configs
            .read()
            .await
            .get(&actor.user_id())
            .cloned()
            .ok_or(Error::Unavailable)
    }
}
fn actor(headers: &HeaderMap) -> Result<Actor, StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let last = match bearer {
        "40000000-0000-4000-8000-000000000001" => 1,
        "40000000-0000-4000-8000-000000000002" => 2,
        "40000000-0000-4000-8000-000000000003" => 3,
        _ => return Err(StatusCode::UNAUTHORIZED),
    };
    Ok(Actor::from_authenticated_session(
        Uuid::from_u128(0x00000000000040008000000000000000 + last),
        Uuid::new_v4(),
    ))
}
async fn configure(
    State(state): State<Data>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let id = serde_json::from_value(body["actor"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
    let config =
        serde_json::from_value(body["config"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
    state.configs.write().await.insert(id, config);
    Ok(Json(json!({"configured":true})))
}
async fn capability(
    State(state): State<Data>,
    headers: HeaderMap,
    Path(cap): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let actor = actor(&headers)?;
    let cap: Capability =
        serde_json::from_value(json!(cap)).map_err(|_| StatusCode::BAD_REQUEST)?;
    let config = state
        .for_actor(actor)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let route = lookup(&config, cap, Tier::Interactive);
    Ok(Json(
        json!({"route":{"capability":cap,"available":route.model.is_some(),"reason":route.reason,"model":route.model.map(|m|json!({"id":m.id}))}}),
    ))
}
async fn payload(Json(body): Json<Value>) -> Json<Value> {
    let accepted = serde_json::from_value::<QueueSpec>(body["queue"].clone())
        .ok()
        .is_some_and(|s| s.parse_payload(body["payload"].clone()).is_ok());
    Json(json!({"accepted":accepted}))
}
async fn coverage(Json(body): Json<Value>) -> Json<Value> {
    let accepted = (|| {
        let manifests: Vec<Manifest> = serde_json::from_value(body["manifests"].clone()).ok()?;
        let routes: Vec<Route> = serde_json::from_value(body["registered"].clone()).ok()?;
        let allowed: BTreeSet<String> = serde_json::from_value(body["platform"].clone()).ok()?;
        Registry::load(manifests)
            .ok()?
            .assert_coverage(&routes, &allowed)
            .ok()
    })();
    Json(json!({"accepted":accepted.is_some()}))
}
async fn app_map(Json(body): Json<Value>) -> Result<Json<Value>, StatusCode> {
    let manifests =
        serde_json::from_value(body["manifests"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
    let registry = Registry::load(manifests).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(registry.app_map(
        &body["core"],
        "test",
        "parity",
        "fixture",
    )))
}
struct FixtureEndpoint {
    protocol: Protocol,
    url: String,
}
#[async_trait]
impl EndpointStore for FixtureEndpoint {
    async fn for_model(&self, _actor: Actor, _provider: Uuid) -> Result<Endpoint, Error> {
        Ok(Endpoint {
            protocol: self.protocol,
            base_url: self.url.clone(),
            credential: Secret::from_cipher_plaintext("TEST-NOT-A-REAL-SECRET".into()),
        })
    }
}
async fn adapter(Json(body): Json<Value>) -> Result<Json<Value>, StatusCode> {
    let endpoint = FixtureEndpoint {
        protocol: serde_json::from_value(body["protocol"].clone())
            .map_err(|_| StatusCode::BAD_REQUEST)?,
        url: body["baseUrl"]
            .as_str()
            .ok_or(StatusCode::BAD_REQUEST)?
            .into(),
    };
    let model: Model =
        serde_json::from_value(body["model"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
    let messages: Vec<Turn> =
        serde_json::from_value(body["messages"].clone()).map_err(|_| StatusCode::BAD_REQUEST)?;
    let adapters = HttpAdapters::new(endpoint).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let result = adapters
        .generate(
            Actor::from_authenticated_session(Uuid::new_v4(), Uuid::new_v4()),
            &model,
            &messages,
            42,
        )
        .await;
    Ok(Json(match result {
        Ok(text) => json!({"text":text}),
        Err(error) => json!({"error":error.to_string()}),
    }))
}
#[tokio::main]
async fn main() {
    assert_eq!(
        std::env::var("JARVIS_GATE_RUN").as_deref(),
        Ok("1"),
        "test host requires verify-gate"
    );
    let port: u16 = std::env::args()
        .nth(1)
        .expect("claimed port")
        .parse()
        .unwrap();
    assert!((5180..=5299).contains(&port));
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/probe/configure", post(configure))
        .route("/api/ai/capability-route/{capability}", get(capability))
        .route("/probe/payload", post(payload))
        .route("/probe/coverage", post(coverage))
        .route("/probe/app-map", post(app_map))
        .route("/probe/adapter", post(adapter))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .with_state(Data::default());
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    println!("Rust parity host ready");
    axum::serve(listener, app).await.unwrap();
}
