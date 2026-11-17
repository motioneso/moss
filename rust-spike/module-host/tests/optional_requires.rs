//! A module may call another module's public API when it lists the module under
//! `requires` or `optionalRequires`, and not otherwise.
mod common;
use moss_module_host::{
    manifest::Capability,
    runtime::{authorize, Request},
};
use serde_json::json;

fn call(resource: &str) -> Request {
    Request { operation: "call".into(), resource: resource.into(), parameters: json!({}) }
}

fn module() -> moss_module_host::manifest::Manifest {
    let mut m = common::manifest("1.0.0");
    m.capabilities.push(Capability {
        port: "api".into(),
        operations: ["call".into()].into(),
        resources: ["tasks".into(), "connectors".into(), "other".into()].into(),
        allow_private: false,
    });
    m.requires.insert("tasks".into(), ">=1.0.0".parse().unwrap());
    m.optional_requires.insert("connectors".into(), ">=0.5.0, <1.0.0".parse().unwrap());
    m
}

#[test]
fn required_and_optional_modules_may_be_called_and_others_may_not() {
    let m = module();
    authorize(&m, "api", &call("tasks")).unwrap();
    authorize(&m, "api", &call("connectors")).unwrap();
    assert!(authorize(&m, "api", &call("other")).is_err());
}

#[test]
fn an_optional_module_is_not_a_hard_requirement() {
    let m = module();
    assert!(!m.requires.contains_key("connectors"));
    assert!(m.optional_requires.contains_key("connectors"));
}

#[test]
fn optional_requires_reads_from_the_manifest_json() {
    let mut json = serde_json::to_value(common::manifest("1.0.0")).unwrap();
    json["optionalRequires"] = json!({"connectors":">=0.5.0, <1.0.0"});
    let m: moss_module_host::manifest::Manifest = serde_json::from_value(json).unwrap();
    assert!(m.optional_requires["connectors"].matches(&"0.5.0".parse().unwrap()));
}
