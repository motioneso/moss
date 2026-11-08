mod common;
use access_context::AccessContext;
use moss_module_host::{
    local::LocalPorts,
    runtime::{Host, Limits},
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

#[test]
fn immutable_records_preserve_parallel_commands_and_account_boundaries() {
    let data = tempfile::tempdir().unwrap();
    let mut manifest = common::manifest("0.1.0");
    manifest.capabilities = serde_json::from_value(json!([
        {"port":"kv","operations":["records.get","records.put"],"resources":["commands","other-commands"]}
    ])).unwrap();
    let manifest = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let wasm = common::wasm();
    let actor = Uuid::new_v4();
    let other = Uuid::new_v4();
    let call = |owner, op: &str, resource: &str, parameters: Value| {
        host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(owner, "command-records"),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
            "route",
            &json!({"operation":op,"resource":resource,"parameters":parameters}).to_string(),
        )
        .map(|s| serde_json::from_str::<Value>(&s).unwrap())
    };
    let ids: Vec<_> = (0..12).map(|_| Uuid::new_v4()).collect();
    std::thread::scope(|threads| {
        let handles: Vec<_> = ids
            .iter()
            .map(|id| {
                let call = &call;
                threads.spawn(move || {
                    call(
                        actor,
                        "records.put",
                        "commands",
                        json!({"id":id,"value":{"hash":format!("source-{id}"),"version":"v:2/🪴"}}),
                    )
                    .unwrap()
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap()["created"], true);
        }
    });
    for id in &ids {
        let value = call(actor, "records.get", "commands", json!({"id":id})).unwrap();
        assert_eq!(value["version"], "v:2/🪴");
        let retry = call(
            actor,
            "records.put",
            "commands",
            json!({"id":id,"value":{"replacement":true}}),
        )
        .unwrap();
        assert_eq!(retry, json!({"created":false,"value":value}));
        assert_eq!(
            call(other, "records.get", "commands", json!({"id":id})).unwrap(),
            Value::Null
        );
        assert_eq!(
            call(actor, "records.get", "other-commands", json!({"id":id})).unwrap(),
            Value::Null
        );
    }
    for invalid in [json!({"id":"../escape"}), json!({"id":ids[0],"extra":true})] {
        assert!(call(actor, "records.get", "commands", invalid).is_err());
    }
    // Actor selection is never accepted from a guest, including inside record content.
    assert!(call(
        actor,
        "records.put",
        "commands",
        json!({"id":Uuid::new_v4(),"value":{"actorUserId":other}})
    )
    .is_err());
    println!("PASS immutable command storage: parallel independent hosts retain all records; retries cannot overwrite; account/resource boundaries and malformed keys checked");
}
