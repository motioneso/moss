//! Measures what one mail sync step costs inside WebAssembly. The host side (network, message
//! parsing) is native and not measured here. A scripted host answers instantly, so the numbers
//! are the guest's own cost: listing, comparing, JSON and the prune key list.
use access_context::AccessContext;
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use serde_json::{json, Value};
use std::{sync::Arc, time::Instant};

fn core() -> Vec<u8> {
    std::fs::read(
        std::env::var("CONNECTORS_CORE_WASM")
            .expect("Run modules/connectors/tools/check.sh to build the real Rust guest"),
    )
    .unwrap()
}

/// A mailbox of `count` messages, none cached, so every window is fetched.
struct Mailbox(u64);
impl Ports for Mailbox {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let p = &request.parameters;
        Ok(match (port, request.resource.as_str()) {
            ("kv", "connectors.imap-sync-start") => json!({"state":"started"}),
            ("kv", "connectors.imap-list") => {
                let keys: Vec<Value> = (1..=self.0).map(|u| json!({"uid":u,"size":2000})).collect();
                json!({"uidValidity":1,"truncated":false,"since":"2026-01-01T00:00:00.000Z","keys":keys})
            }
            ("kv", "connectors.imap-fetch") => {
                let messages: Vec<Value> = p["uids"].as_array().unwrap().iter().map(|u| json!({
                    "uid":u,"sender":"Alice <alice@example.com>","recipients":["bob@example.com"],
                    "subject":"Quarterly planning update","snippet":"x".repeat(500),
                    "receivedAt":"2026-01-02T00:00:00.000Z","messageId":"<m@example.com>","references":[],"sizeBytes":2000
                })).collect();
                json!({"messages":messages,"failed":[]})
            }
            ("kv", _) => json!({}),
            ("api", "call") if p["name"] == "listCachedMessageKeys" => json!({"keys":[]}),
            ("api", _) => json!({}),
            ("context", "read") => json!({"now":"2026-01-01T00:00:00.000Z"}),
            ("context", _) => json!({"id":"k"}),
            ("jobs", _) => json!({"id":"row"}),
            _ => anyhow::bail!("unexpected {port} {}", request.resource),
        })
    }
}

/// One job run at `cursor`, or the error text.
fn run(count: u64, cursor: u64, fuel: u64) -> Result<std::time::Duration, String> {
    let mut manifest = moss_connectors_host::package::manifest().unwrap();
    manifest.fuel_limit = None;
    let wasm = moss_connectors_host::package::component(&core()).unwrap();
    let limits = Limits { fuel, fuel_ceiling: fuel, ..Limits::default() };
    let host = Host::new(limits).unwrap();
    let payload = json!({"queue":"imap-sync","parameters":{"account-id":"a","cursor":cursor,"upserted":0,"failures":0}});
    let started = Instant::now();
    host.call(
        &wasm,
        Arc::new(manifest),
        AccessContext::new(uuid::Uuid::new_v4(), "sync-speed"),
        Arc::new(Mailbox(count)),
        "job",
        &payload.to_string(),
    )
    .map(|_| started.elapsed())
    .map_err(|e| e.to_string())
}

/// The least fuel at which the step still finishes.
fn least_fuel(count: u64, cursor: u64) -> u64 {
    let (mut low, mut high) = (1_000_000u64, 4_000_000_000u64);
    assert!(run(count, cursor, high).is_ok(), "step does not finish at {high}");
    while high - low > high / 20 {
        let mid = (low + high) / 2;
        if run(count, cursor, mid).is_ok() {
            high = mid;
        } else {
            low = mid;
        }
    }
    high
}

#[test]
fn one_sync_step_fits_the_manifest_budget_at_every_mailbox_size() {
    let declared = moss_connectors_host::package::manifest().unwrap().fuel_limit;
    let budget = declared.unwrap_or(10_000_000);
    println!("declared fuel budget {budget}");
    for count in [50u64, 500, 5000] {
        // The first step lists and fetches. The last step lists and prunes with every key.
        let last = (count - 1) / 50 * 50;
        for (name, cursor) in [("first", 0), ("last", last)] {
            let fuel = least_fuel(count, cursor);
            let time = run(count, cursor, budget.max(fuel)).unwrap();
            println!("SPEED messages={count} step={name} fuel={fuel} time_ms={}", time.as_millis());
            assert!(fuel <= budget, "{count}-message {name} step needs {fuel}, the manifest allows {budget}");
        }
    }
}
