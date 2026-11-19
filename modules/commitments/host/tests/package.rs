use access_context::AccessContext;
use moss_module_host::runtime::{DenyPorts, Host, Limits, Request, authorize};
use serde_json::{Value, json};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("COMMITMENTS_COMPONENT_WASM")
            .expect("Run modules/commitments/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_commitments_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "commitments-package"),
        Arc::new(DenyPorts),
        kind,
        payload,
    )
}

#[test]
fn the_component_loads_with_the_real_host() {
    assert_eq!(call("health", "{}").unwrap(), "{}");
}

#[test]
fn an_unknown_route_is_a_plain_404() {
    let out = call(
        "route",
        r#"{"method":"GET","path":"/nope","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], 404);
}

#[test]
fn an_unsupported_invocation_leaks_no_request_text() {
    let err = call(
        "job",
        &json!({"queue":"commitments-x","payload":{"title":"SECRET-TITLE"}}).to_string(),
    )
    .unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_commitments_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 2);
    for needed in [
        "moss.module.json",
        "code/module.wasm",
        "LICENSE",
        "NOTICE",
        "CHANGELOG.md",
        "ui/index.html",
        "ui/today.mjs",
        "ui/menu.mjs",
    ] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_commitments_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_commitments_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(
            &manifest,
            port,
            &Request {
                operation: operation.into(),
                resource: resource.into(),
                parameters: json!({"kind":"select"}),
            },
        )
    };
    assert!(ask("db", "query", "app.commitment_candidates").is_ok());
    assert!(ask("db", "query", "app.commitment_candidate_sources").is_ok());
    assert!(ask("db", "query", "app.commitment_extraction_state").is_ok());
    assert!(ask("db", "query", "app.commitment_email_thread_judgements").is_ok());
    assert!(ask("ai", "generate", "summarization").is_ok());
    assert!(ask("ai", "generate", "structured").is_ok());
    assert!(ask("ai", "generate", "chat").is_err());
    assert!(ask("ai", "embed", "summarization").is_err());
    let queue = |queue: &str, params: serde_json::Value| {
        authorize(&manifest, "jobs", &Request {
            operation: "enqueue-options".into(),
            resource: queue.into(),
            parameters: json!({"params": params, "idempotencyKey": "6f1d7a52-4a4f-4d0e-9d57-0c3f0a1b2c3d",
                               "availableAt": "2026-11-16T00:00:00.000Z"}),
            },
        )
    };
    assert!(queue("commitments-extraction", json!({"source-kind":"notes"})).is_ok());
    assert!(queue("commitments-extraction", json!({"source-kind":"mail"})).is_err());
    assert!(queue("commitments-extraction", json!({"source-kind":"notes","text":"hello"})).is_err());
    assert!(queue("commitments-email-judgement", json!({"message-id":"6f1d7a52-4a4f-4d0e-9d57-0c3f0a1b2c3d"})).is_ok());
    assert!(queue("commitments-email-judgement", json!({"message-id":"not an id"})).is_err());
    assert!(queue("other-queue", json!({})).is_err());
    assert!(ask("api", "call", "email").is_ok());
    assert!(ask("api", "call", "connectors").is_err());
    assert!(ask("db", "query", "app.users").is_err());
    assert!(ask("db", "query", "app.tasks").is_err());
    assert!(ask("jobs", "enqueue-after-commit", "commitments-memory-sync").is_err());
    assert!(ask("kv", "get", "commitments.store").is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("packages/commitments");
    let to = copy.join("packages/commitments");
    std::fs::create_dir_all(to.join("sql")).unwrap();
    for name in [
        "0125_commitment_candidates.sql",
        "0220_commitment_email_items.sql",
    ] {
        let mut bytes = std::fs::read(from.join("sql").join(name)).unwrap();
        if name.starts_with("0125") {
            bytes.push(b'\n');
        }
        std::fs::write(to.join("sql").join(name), bytes).unwrap();
    }
    assert!(moss_commitments_host::package::files(copy, &component()).is_err());
}

#[test]
fn chat_schemas_have_descriptions_examples_and_saved_record_cards() {
    let manifest = moss_commitments_host::package::manifest().unwrap();
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    for (name, tool) in &manifest.tools {
        let schema = tool.input_schema.as_ref().unwrap();
        for property in schema["properties"].as_object().unwrap().values() {
            assert!(!property["description"].as_str().unwrap().is_empty());
        }
        if tool.risk == "write" {
            assert_eq!(tool.card.as_deref(), Some("prepareChatAction"), "{name}");
            let example = &schema["examples"][0];
            for field in schema["required"].as_array().unwrap() {
                assert!(example.get(field.as_str().unwrap()).is_some());
            }
        }
    }
}
