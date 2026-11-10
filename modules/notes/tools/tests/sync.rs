//! The real checkpoint Wasm runs the legacy coordinator corpus. All core memory,
//! filesystem and transaction responses are explicit stand-ins, not indexing proof.
#[path = "../../test-support/sync.rs"]
mod support;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::runtime::{authorize, CallScope, Host, Limits, Ports, Request};
use moss_module_sdk::Host as SdkHost;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    sync::atomic::{AtomicUsize, Ordering},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const OPERATIONS: &[&str] = &["index.sync-open", "index.sync-file", "index.sync-cleanup"];
struct CoreStandIn {
    case: Value,
    calls: Mutex<Vec<Value>>,
    actor: Uuid,
    invocations: AtomicUsize,
}
impl Ports for CoreStandIn {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
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
    let manifest = moss_notes_checks::manifest().unwrap();
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
            invocations: AtomicUsize::new(0),
        });
        let result = host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(actor, "notes-sync-parity"),
            ports.clone(),
            "job",
            &json!({"queue":"notes.sync","parameters":case["payload"]}).to_string(),
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
    let ordinary_manifest = Arc::new(moss_notes_checks::read_only_manifest().unwrap());
    assert!(ordinary_manifest.jobs.is_empty());
    assert!(OPERATIONS.iter().all(|op| !ordinary_manifest
        .capability("vault")
        .unwrap()
        .operations
        .contains(*op)));
    // Supply the permissive checkpoint manifest and a working core too: a leaked
    // handler would succeed and touch a port, so refusal cannot be vacuous.
    let ordinary_ports = Arc::new(CoreStandIn {
        case: json!({"source":null,"files":[],"payload":{}}),
        calls: Mutex::new(vec![]),
        actor,
        invocations: AtomicUsize::new(0),
    });
    assert!(host
        .call(
            &ordinary,
            manifest,
            AccessContext::new(actor, "notes-sync-disabled"),
            ordinary_ports.clone(),
            "job",
            r#"{"queue":"notes.sync","parameters":{}}"#
        )
        .is_err());
    assert_eq!(ordinary_ports.invocations.load(Ordering::SeqCst), 0);
}
