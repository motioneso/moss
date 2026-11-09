//! Compare real queues while keeping private source metadata in account command records.
use super::common;
use access_context::AccessContext;
use moss_module_host::{
    jobs::{module_key, JobPorts},
    manifest::Manifest,
    runtime::{Host, Ports},
};
use safety_core::{db::Database, secret::Secret};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn manifest(mut manifest: Manifest) -> Arc<Manifest> {
    // Deliberately remove account scoping for the failing-first control. This
    // test-only switch never reaches a package or production host assembly.
    if std::env::var("JS88_PEOPLE_UNSCOPED_COMMANDS").as_deref() == Ok("1") {
        assert!(std::env::var_os("JS73_PEOPLE_PACKAGE").is_none());
        manifest.install_wide_kv.insert("people-commands".into());
    }
    Arc::new(manifest)
}

pub fn ports(database: Database, next: Arc<dyn Ports>) -> Arc<dyn Ports> {
    Arc::new(
        JobPorts::new(
            Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            database,
            next,
        )
        .unwrap(),
    )
}

pub struct Replay {
    actors: [uuid::Uuid; 3],
    started: chrono::DateTime<chrono::Utc>,
}
impl Replay {
    pub fn new(actors: [uuid::Uuid; 3]) -> Self {
        Self {
            actors,
            started: chrono::Utc::now(),
        }
    }
    pub fn compare(
        &self,
        rt: &tokio::runtime::Runtime,
        bootstrap: &tokio_postgres::Client,
        host: &Host,
        manifest: &Arc<Manifest>,
        ports: &Arc<dyn Ports>,
        expected: &Value,
    ) {
        let queue = format!("{}.person-index", module_key("people"));
        let rows = rt
        .block_on(bootstrap.query(
            "SELECT actor_user_id,payload,run_at FROM moss_queue.jobs WHERE queue=$1 ORDER BY id",
            &[&queue],
        ))
        .unwrap();
        let mut actual = vec![];
        for row in rows {
            let actor: uuid::Uuid = row.get(0);
            let payload: Value = row.get(1);
            assert_eq!(payload["actorUserId"], json!(actor));
            assert_eq!(payload["params"].as_object().unwrap().len(), 1);
            let id = payload["params"]["command-id"].as_str().unwrap();
            let record: Value = serde_json::from_str(&host.call(
            &common::wasm(), manifest.clone(), AccessContext::new(actor, "people-refresh-record"),
            ports.clone(), "route", &json!({"operation":"records.get","resource":"people-commands","parameters":{"id":id}}).to_string(),
        ).unwrap()).unwrap();
            assert_eq!(record["queue"], "person-index");
            let available: chrono::DateTime<chrono::Utc> =
                record["availableAt"].as_str().unwrap().parse().unwrap();
            assert_eq!(row.get::<_, chrono::DateTime<chrono::Utc>>(2), available);
            // Bound host time across the replay; older jobs must also pass on slow machines.
            assert!(available >= self.started + chrono::Duration::minutes(15));
            assert!(available <= chrono::Utc::now() + chrono::Duration::minutes(15));
            let mut command = record["command"].clone();
            assert_eq!(command["commandId"], id);
            command.as_object_mut().unwrap().remove("commandId");
            command["actorUserId"] = json!(actor);
            actual.push(command);
            // The same opaque reference cannot be read by the other account or admin.
            for other in self.actors.iter().filter(|other| **other != actor) {
                let denied = host.call(
            &common::wasm(), manifest.clone(), AccessContext::new(*other, "people-refresh-private"),
            ports.clone(), "route", &json!({"operation":"records.get","resource":"people-commands","parameters":{"id":id}}).to_string(),
        ).unwrap();
                assert_eq!(serde_json::from_str::<Value>(&denied).unwrap(), Value::Null);
            }
        }
        let sorted = |items: &[Value]| {
            let mut items: Vec<_> = items
                .iter()
                .map(|item| {
                    let mut item = item.clone();
                    item.sort_all_objects();
                    item.to_string()
                })
                .collect();
            items.sort();
            items
        };
        assert_eq!(
            sorted(&actual),
            sorted(expected.as_array().unwrap()),
            "Manual refresh queue parity"
        );
    }
}
