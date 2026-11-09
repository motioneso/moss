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

pub fn compare(
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
        // Context time is captured just before publication, not PostgreSQL's
        // transaction time. Bound it here; the native test checks exact delay.
        let left = (available - chrono::Utc::now()).num_seconds();
        assert!(
            (780..=901).contains(&left),
            "Indexing must retain its fifteen-minute delay: {left}"
        );
        let mut command = record["command"].clone();
        assert_eq!(command["commandId"], id);
        command.as_object_mut().unwrap().remove("commandId");
        command["actorUserId"] = json!(actor);
        actual.push(command);
        // The same opaque reference cannot be read by an unrelated account.
        let denied = host.call(
            &common::wasm(), manifest.clone(), AccessContext::new(uuid::Uuid::new_v4(), "people-refresh-private"),
            ports.clone(), "route", &json!({"operation":"records.get","resource":"people-commands","parameters":{"id":id}}).to_string(),
        ).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&denied).unwrap(), Value::Null);
    }
    let sorted = |items: &[Value]| {
        let mut items: Vec<_> = items.iter().map(|item| {
            let mut item = item.clone();
            item.sort_all_objects();
            item.to_string()
        }).collect();
        items.sort();
        items
    };
    assert_eq!(
        sorted(&actual),
        sorted(expected.as_array().unwrap()),
        "Manual refresh queue parity"
    );
}
