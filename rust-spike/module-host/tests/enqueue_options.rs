mod common;
use moss_module_host::{
    manifest::{Capability, ParameterKind},
    runtime::{authorize, Request},
};
use serde_json::{json, Value};

fn manifest() -> moss_module_host::manifest::Manifest {
    let mut manifest = common::manifest("0.1.0");
    manifest.capabilities.push(Capability {
        port: "jobs".into(),
        operations: ["enqueue".into(), "enqueue-options".into()].into(),
        resources: ["person-index".into()].into(),
        allow_private: false,
    });
    manifest.jobs.insert(
        "person-index".into(),
        [("command-id".into(), ParameterKind::Id)].into(),
    );
    manifest
}

fn request(parameters: Value) -> Request {
    Request {
        operation: "enqueue-options".into(),
        resource: "person-index".into(),
        parameters,
    }
}

fn envelope() -> Value {
    json!({"params":{"command-id":"00000000-0000-4000-8000-000000000001"},"idempotencyKey":"00000000-0000-4000-8000-000000000002","availableAt":"2026-11-08T12:15:00.123Z"})
}

#[test]
fn option_enqueue_is_opt_in_and_legacy_enqueue_keeps_plain_parameters() {
    let mut manifest = manifest();
    authorize(&manifest, "jobs", &request(envelope())).unwrap();
    let legacy = Request {
        operation: "enqueue".into(),
        resource: "person-index".into(),
        parameters: envelope()["params"].clone(),
    };
    authorize(&manifest, "jobs", &legacy).unwrap();
    // The new envelope is never silently accepted by the old operation.
    assert!(authorize(
        &manifest,
        "jobs",
        &Request {
            parameters: envelope(),
            ..legacy
        }
    )
    .is_err());
    manifest
        .capabilities
        .iter_mut()
        .find(|cap| cap.port == "jobs")
        .unwrap()
        .operations
        .remove("enqueue-options");
    assert!(authorize(&manifest, "jobs", &request(envelope())).is_err());
}

#[test]
fn option_enqueue_retains_schema_and_context_guards() {
    let manifest = manifest();
    for parameters in [
        json!({"command-id":"not-a-uuid"}),
        json!({"command-id":"00000000-0000-4000-8000-000000000001","private-content":"note"}),
        json!({"actorUserId":"00000000-0000-4000-8000-000000000002"}),
        json!({}),
    ] {
        let mut value = envelope();
        value["params"] = parameters;
        assert!(authorize(&manifest, "jobs", &request(value)).is_err());
    }
    for key in ["actorUserId", "moduleId", "connection", "role"] {
        let mut value = envelope();
        value[key] = json!("untrusted");
        assert!(authorize(&manifest, "jobs", &request(value)).is_err());
    }
    let mut wrong_queue = request(envelope());
    wrong_queue.resource = "other-module-job".into();
    assert!(authorize(&manifest, "jobs", &wrong_queue).is_err());
}
