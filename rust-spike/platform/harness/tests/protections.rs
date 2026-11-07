use moss_platform_contracts::{Error, ParamSchema, QueueSpec};
use moss_platform_jobs::next_occurrence;
use moss_platform_registry::{Manifest, Registry, Route};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn spec() -> QueueSpec {
    serde_json::from_value(json!({"name":"tasks.defer","moduleId":"tasks","jobKinds":["defer"],"paramsSchema":{"type":"object","fields":{"taskId":{"type":"uuid"},"requestedStatus":{"type":"enum","values":["todo","done"]},"count":{"type":"integer","min":0,"max":10}}},"retryLimit":3,"retryDelaySeconds":1,"retryBackoff":true,"leaseSeconds":60})).unwrap()
}
fn payload() -> Value {
    json!({"actorUserId":"00000000-0000-4000-8000-000000000001","moduleId":"tasks","jobKind":"defer","manifestHash":format!("sha256:{}","a".repeat(64)),"params":{"taskId":"10000000-0000-4000-8000-000000000001","requestedStatus":"done"}})
}
#[test]
fn payload_refuses_content_and_secrets() {
    let spec = spec();
    assert!(spec.parse_payload(payload()).is_ok());
    let mut without_params = payload();
    without_params.as_object_mut().unwrap().remove("params");
    let parsed = spec.parse_payload(without_params).unwrap();
    let stored = serde_json::to_value(parsed).unwrap();
    assert!(stored.get("params").is_none());
    assert!(spec.parse_payload(stored).is_ok());
    for key in ["content", "prompt", "secret", "apiKey", "token", "password"] {
        let mut p = payload();
        p[key] = json!("SENTINEL-private-value");
        assert!(
            spec.parse_payload(p).is_err(),
            "accepted forbidden top-level field {key}"
        );
        let mut p = payload();
        p["params"][key] = json!("SENTINEL-private-value");
        assert!(
            spec.parse_payload(p).is_err(),
            "accepted forbidden param {key}"
        );
    }
    for field in ["actorUserId", "moduleId", "jobKind", "manifestHash"] {
        let mut p = payload();
        p[field] = json!("SENTINEL-private-value");
        assert!(spec.parse_payload(p).is_err());
    }
    for field in ["taskId", "requestedStatus", "count"] {
        let mut p = payload();
        p["params"][field] = json!("SENTINEL-private-value");
        assert!(spec.parse_payload(p).is_err());
    }
    assert_eq!(
        spec.parse_payload(json!({"content":"SENTINEL-private-value"}))
            .err(),
        Some(Error::InvalidPayload)
    );
}
#[test]
fn payload_shapes_have_no_free_text_kind() {
    for kind in ["string", "identifier", "timestamp"] {
        assert!(serde_json::from_value::<ParamSchema>(json!({"type":kind})).is_err());
    }
    let mut s = spec();
    s.params_schema = Some(ParamSchema::Integer {
        min: 0,
        max: i64::MAX,
    });
    assert_eq!(s.validate(), Err(Error::InvalidDeclaration));
}
#[test]
fn undeclared_route_is_refused() {
    let m:Manifest=serde_json::from_value(json!({"id":"tasks","name":"Tasks","version":"1","routes":[{"method":"GET","path":"/api/tasks"}]})).unwrap();
    let registry = Registry::load(vec![m.clone()]).unwrap();
    assert!(registry
        .assert_coverage(&m.routes, &BTreeSet::new())
        .is_ok());
    let extra = Route {
        method: "GET".into(),
        path: "/api/unlisted".into(),
        metadata: Default::default(),
    };
    let mut actual = m.routes.clone();
    actual.push(extra);
    assert!(
        registry.assert_coverage(&actual, &BTreeSet::new()).is_err(),
        "undeclared route reached startup"
    );
    assert!(
        registry.assert_coverage(&[], &BTreeSet::new()).is_err(),
        "missing handler passed startup"
    );
    let head = Route {
        method: "HEAD".into(),
        path: "/api/tasks".into(),
        metadata: Default::default(),
    };
    assert!(registry.assert_coverage(&[head], &BTreeSet::new()).is_ok());
    let mut duplicate = m.clone();
    duplicate.id = "other".into();
    assert!(Registry::load(vec![m, duplicate]).is_err());
}
#[test]
fn manifest_ownership_and_app_map_stay_queryable() {
    let manifest:Manifest=serde_json::from_value(json!({"id":"tasks","name":"Tasks","version":"1","database":{"ownedTables":["app.tasks"],"migrations":["sql/0001.sql"]},"navigation":[{"id":"tasks","path":"/tasks"}],"settings":[{"id":"config","path":"/settings"}],"features":[{"id":"tasks.defer","errors":[{"id":"failed","message":"Try again"}],"remediations":[{"id":"retry"}]}]})).unwrap();
    let registry = Registry::load(vec![manifest]).unwrap();
    assert_eq!(registry.sql_owner("app.tasks"), Some("tasks"));
    let map = registry.app_map(
        &json!({"settings":[{"id":"core-settings","path":"/settings"}]}),
        "1",
        "test",
        "",
    );
    assert_eq!(map["screens"][0]["moduleId"], "tasks");
    assert_eq!(map["settings"].as_array().unwrap().len(), 1);
    assert_eq!(map["errors"][0]["featureId"], "tasks.defer");
}
#[test]
fn cron_repeats_in_the_configured_timezone() {
    let after = "2026-03-07T14:00:00Z".parse().unwrap();
    assert_eq!(
        next_occurrence("0 9 * * *", "America/New_York", after)
            .unwrap()
            .to_rfc3339(),
        "2026-03-08T13:00:00+00:00"
    );
    assert!(next_occurrence("not cron", "UTC", after).is_err());
    assert!(next_occurrence("0 9 * * *", "not a zone", after).is_err());
}
