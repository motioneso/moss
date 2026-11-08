//! Exercises the real compiled Rust guest. No native People test driver is used.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    manifest::{Capability, Ledger},
    runtime::{CallScope, Host, Limits, Ports, Request},
};
use moss_people::repository::TABLES;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

struct Boundary {
    actor: Uuid,
    calls: Mutex<usize>,
    completions: Mutex<Vec<bool>>,
    refuse: AtomicBool,
}
impl Ports for Boundary {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        assert_eq!(scope.access().actor_user_id(), self.actor);
        assert_eq!(port, "db");
        assert_eq!(request.operation, "query");
        *self.calls.lock().unwrap() += 1;
        anyhow::ensure!(
            !self.refuse.load(Ordering::Relaxed),
            "Backend diagnostic that must be redacted"
        );
        // Boundary fixture, not data/privacy proof. Long Unicode values exercise
        // canonical allocation and UTF-8 across a result-string round trip.
        if request.resource.ends_with("identities") {
            return Ok(json!([]));
        }
        Ok(
            json!([{"id":"synthetic","owner_user_id":self.actor,"display_name":"友人🪴".repeat(2000),"confidence":0.75}]),
        )
    }
    fn finish_call(&self, _: &CallScope, success: bool) -> anyhow::Result<()> {
        self.completions.lock().unwrap().push(success);
        Ok(())
    }
}

#[test]
#[ignore = "Build People component and set JS50_PEOPLE_COMPONENT"]
fn compiled_people_guest_uses_the_real_canonical_abi() {
    let core = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let actor = Uuid::new_v4();
    let boundary = Arc::new(Boundary {
        actor,
        calls: Mutex::new(0),
        completions: Mutex::new(vec![]),
        refuse: AtomicBool::new(false),
    });
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "people".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = TABLES.map(str::to_owned).to_vec();
    manifest.capabilities = vec![
        Capability {
            port: "db".into(),
            operations: ["query".into()].into(),
            resources: TABLES.map(str::to_owned).into(),
            allow_private: false,
        },
        Capability {
            port: "context".into(),
            operations: ["read".into()].into(),
            resources: ["call".into()].into(),
            allow_private: false,
        },
        Capability {
            port: "vault".into(),
            operations: [
                "notes.read".into(),
                "notes.list".into(),
                "notes.compare-write".into(),
            ]
            .into(),
            resources: ["people-notes".into()].into(),
            allow_private: false,
        },
    ];
    let host = Host::new(Limits::default()).unwrap();
    let mut undeclared = manifest.clone();
    undeclared.capabilities.clear();
    assert!(host.validate(&core, &undeclared).is_err());
    common::people_job_imports(&mut manifest);
    let manifest = Arc::new(manifest);
    let run = |kind: &str, payload: Value| {
        host.call(
            &core,
            manifest.clone(),
            AccessContext::new(actor, "compiled-guest"),
            boundary.clone(),
            kind,
            &payload.to_string(),
        )
    };
    assert_eq!(run("health", json!({})).unwrap(), "healthy");
    for _ in 0..20 {
        let result: Value = serde_json::from_str(
            &run(
                "api",
                json!({"name":"resolve","parameters":{"query":"友人🪴"}}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["person"]["displayName"], "友人🪴".repeat(2000));
        assert_eq!(result["person"]["confidence"], "0.75");
    }
    assert!(run(
        "api",
        json!({"name":"resolve","parameters":{"query":"x","actorUserId":Uuid::new_v4()}})
    )
    .is_err());
    assert!(run("api", json!({"name":"not-a-handler","parameters":{}})).is_err());
    boundary.refuse.store(true, Ordering::Relaxed);
    let error = run("api", json!({"name":"resolve","parameters":{"query":"x"}})).unwrap_err();
    assert!(!error.to_string().contains("Backend diagnostic"));
    assert_eq!(*boundary.calls.lock().unwrap(), 41);
    let completed = boundary.completions.lock().unwrap();
    assert_eq!(completed.iter().filter(|success| **success).count(), 21);
    assert_eq!(completed.iter().filter(|success| !**success).count(), 3);
    println!("PASS compiled Rust People guest, canonical Unicode strings, capability rejection, API input rejection and host call finalization; boundary fixture only, not UI/privacy proof");
}
