//! The module declaration, copied from the old manifest, and the queues it names.
use std::collections::BTreeMap;

use moss_platform_contracts::{ParamSchema, QueueSpec};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MODULE_ID: &str = "integrations";
pub const SORT_QUEUE: &str = "integrations.classifier-sort";
pub const PREPARE_QUEUE: &str = "integrations.classifier-prepare";

/// The old module manifest as JSON, written by `tools/host-oracle.ts` from the real source.
pub const MANIFEST_JSON: &str = include_str!("../manifest.json");

pub fn manifest() -> Value {
    serde_json::from_str(MANIFEST_JSON).expect("manifest.json is valid")
}

/// `sha256:` plus the hex digest of the manifest with object keys in sorted order.
pub fn manifest_hash() -> String {
    let mut value = manifest();
    value.sort_all_objects();
    let bytes = serde_json::to_vec(&value).expect("manifest serializes");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// The tables account deletion removes, as the manifest declares them.
pub fn deletion_tables() -> Vec<String> {
    manifest()["dataLifecycle"]["deletion"]["tables"]
        .as_array()
        .map(|tables| {
            tables.iter().filter_map(|t| t["table"].as_str().map(str::to_owned)).collect()
        })
        .unwrap_or_default()
}

/// `(method, path)` for each declared route.
pub fn declared_routes() -> Vec<(String, String)> {
    manifest()["routes"]
        .as_array()
        .map(|routes| {
            routes
                .iter()
                .filter_map(|r| Some((r["method"].as_str()?.to_owned(), r["path"].as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn spec(name: &str, fields: BTreeMap<String, ParamSchema>) -> QueueSpec {
    QueueSpec {
        name: name.to_owned(),
        module_id: MODULE_ID.to_owned(),
        job_kinds: vec![name.to_owned()],
        params_schema: Some(ParamSchema::Object { fields }),
        retry_limit: 0,
        retry_delay_seconds: 0,
        retry_backoff: false,
        lease_seconds: 1800,
    }
}

/// Both queues carry only a connection id and a short operation name.
pub fn queue_specs() -> Vec<QueueSpec> {
    let sort_fields = BTreeMap::from([
        ("connectionId".to_owned(), ParamSchema::Uuid),
        (
            "op".to_owned(),
            ParamSchema::Enum { values: vec!["sort".into(), "retry".into(), "model_ready".into()] },
        ),
    ]);
    let prepare_fields = BTreeMap::from([("connectionId".to_owned(), ParamSchema::Uuid)]);
    vec![spec(SORT_QUEUE, sort_fields), spec(PREPARE_QUEUE, prepare_fields)]
}
