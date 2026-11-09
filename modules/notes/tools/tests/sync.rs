//! The real checkpoint Wasm runs the legacy coordinator corpus. All core memory,
//! filesystem and transaction responses are explicit stand-ins, not indexing proof.
#[path = "../../test-support/sync.rs"]
mod support;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::runtime::{authorize, CallScope, DenyPorts, Host, Limits, Ports, Request};
use moss_module_sdk::Host as SdkHost;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const OPERATIONS: &[&str] = &[
    "index.sync-open",
    "index.sync-file",
    "index.sync-canonical",
    "index.sync-indexed",
    "index.sync-remove",
];
struct CoreStandIn {
    case: Value,
    calls: Mutex<Vec<Value>>,
    actor: Uuid,
}
impl Ports for CoreStandIn {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        authorize(scope.module(), port, request)?;
        ensure!(
            scope.access().actor_user_id() == self.actor,
            "Unexpected fixture actor"
        );
        let fixture = support::SyncHost {
            case: &self.case,
            calls: RefCell::new(vec![]),
        };
        let result = fixture.call(
            port,
            &request.operation,
            &request.resource,
            request.parameters.clone(),
        );
        self.calls
            .lock()
            .unwrap()
            .extend(fixture.calls.into_inner());
        result.map_err(Into::into)
    }
}
#[test]
fn actual_wasm_sync_coordinator_matches_legacy_without_wasi() {
    let wasm = std::fs::read(std::env::var_os("NOTES_TOOL_COMPONENT").unwrap()).unwrap();
    let mut manifest = moss_notes_checks::manifest().unwrap();
    // Test-only grants. None are added to the ordinary signed package.
    manifest
        .capabilities
        .iter_mut()
        .find(|c| c.port == "vault")
        .unwrap()
        .operations
        .extend(OPERATIONS.iter().map(|s| s.to_string()));
    manifest.capabilities.extend(serde_json::from_value::<Vec<_>>(json!([
        {"port":"context","operations":["read","uuid"],"resources":["call","new"]},
        {"port":"jobs","operations":["enqueue-after-commit","enqueue-options"],"resources":["notes.sync"]}
    ])).unwrap());
    manifest
        .jobs
        .insert("notes.sync".into(), Default::default());
    let manifest = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let actor = Uuid::new_v4();
    let mut comparisons = 0;
    for line in include_str!("../../src/tests/sync-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let ports = Arc::new(CoreStandIn {
            case: case.clone(),
            calls: Mutex::new(vec![]),
            actor,
        });
        let result = host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(actor, "notes-sync-parity"),
            ports.clone(),
            "job",
            &json!({"name":"notes.sync","parameters":case["payload"]}).to_string(),
        );
        match &case["expected"]["ok"] {
            expected if !expected.is_null() => {
                assert_eq!(
                    serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
                    *expected,
                    "{case}"
                );
            }
            _ => {
                // The host deliberately scrubs guest errors. Exact safe sink text
                // is compared natively; Wasm must fail instead of reporting success.
                assert!(result.is_err(), "Expected failed compiled sync: {case}");
            }
        }
        assert_eq!(json!(*ports.calls.lock().unwrap()), case["calls"], "{case}");
        comparisons += 1;
    }
    println!("PASS {comparisons} actual-Wasm legacy sync comparisons; core I/O is a named stand-in, no ingestion/queue/installed-chat claim");
    let ordinary = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    let ordinary_manifest = Arc::new(moss_notes_checks::manifest().unwrap());
    assert!(ordinary_manifest.jobs.is_empty());
    assert!(OPERATIONS.iter().all(|op| !ordinary_manifest
        .capability("vault")
        .unwrap()
        .operations
        .contains(*op)));
    assert!(host
        .call(
            &ordinary,
            ordinary_manifest,
            AccessContext::new(actor, "notes-sync-disabled"),
            Arc::new(DenyPorts),
            "job",
            r#"{"name":"notes.sync","parameters":{}}"#
        )
        .is_err());
}
