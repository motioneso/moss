use async_trait::async_trait;
use moss_platform_contracts::{Actor, Error};
use moss_platform_routing::{
    Capability, CapabilityTransport, Configuration, ConfigurationStore, Model, Router, Turn,
};
use serde_json::Value;
use std::sync::Mutex;
use uuid::Uuid;

struct Store {
    first: Uuid,
    config: Configuration,
    other: Configuration,
}
#[async_trait]
impl ConfigurationStore for Store {
    async fn for_actor(&self, actor: Actor) -> Result<Configuration, Error> {
        Ok(if actor.user_id() == self.first {
            self.config.clone()
        } else {
            self.other.clone()
        })
    }
}
#[derive(Default)]
struct Transport(Mutex<Vec<(Uuid, Uuid, String)>>);
#[async_trait]
impl CapabilityTransport for Transport {
    async fn generate(
        &self,
        actor: Actor,
        model: &Model,
        _: &[Turn],
        _: u32,
    ) -> Result<String, Error> {
        self.0
            .lock()
            .unwrap()
            .push((actor.user_id(), model.id, model.provider_model_id.clone()));
        Ok("fixture reply".into())
    }
}
#[tokio::test]
async fn feature_call_uses_each_actors_configured_model() {
    let fixture: Value = serde_json::from_str(include_str!("../../fixtures/routing.json")).unwrap();
    let config: Configuration = serde_json::from_value(fixture[0]["config"].clone()).unwrap();
    let mut other = config.clone();
    let second_model = Uuid::new_v4();
    other.models[0].id = second_model;
    other.models[0].provider_model_id = "second-configured-model".into();
    let first_model = config.models[0].id;
    let first_actor = Uuid::new_v4();
    let second_actor = Uuid::new_v4();
    let router = Router {
        store: Store {
            first: first_actor,
            config,
            other,
        },
        transport: Transport::default(),
    };
    for actor in [first_actor, second_actor] {
        assert_eq!(
            router
                .generate(
                    Actor::from_authenticated_session(actor, Uuid::new_v4()),
                    Capability::Chat,
                    &[],
                    42
                )
                .await
                .unwrap(),
            "fixture reply"
        );
    }
    let calls = router.transport.0.lock().unwrap();
    assert_eq!(calls[0].0, first_actor);
    assert_eq!(calls[0].1, first_model);
    assert_eq!(
        calls[1],
        (second_actor, second_model, "second-configured-model".into())
    );
}
