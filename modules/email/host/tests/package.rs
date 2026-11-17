use access_context::AccessContext;
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const SENTINEL_BODY: &str = "SENTINEL-BODY-91c2";
const SENTINEL_ADDRESS: &str = "sentinel-address-91c2@example.test";

fn core() -> Vec<u8> {
    std::fs::read(
        std::env::var("EMAIL_CORE_WASM")
            .expect("Run modules/email/tools/check.sh to build the real Rust guest"),
    )
    .unwrap()
}

/// Answers the package's kv calls from fixed data and records every request.
struct Fixed(Mutex<Vec<String>>);
impl Ports for Fixed {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        assert_eq!(port, "kv");
        self.0.lock().unwrap().push(request.resource.clone());
        Ok(match request.resource.as_str() {
            "email.messages" => json!([{"id":"m1","ownerUserId":"u","sender":"s","recipients":[],"subject":"Hi","snippet":null,"bodyExcerpt":null,"summary":null,"signals":{},"receivedAt":"2026-01-01T00:00:00.000Z","externalId":"e","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]),
            "email.preferences" => json!({}),
            "email.cache-write" => json!({"rejected":true}),
            _ => anyhow::bail!("Unexpected resource"),
        })
    }
}

fn call(ports: Arc<dyn Ports>, kind: &str, payload: &str) -> Result<String, anyhow::Error> {
    let manifest = moss_email_host::package::manifest().unwrap();
    let wasm = moss_email_host::package::component(&core()).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    host.call(
        &wasm,
        Arc::new(manifest),
        AccessContext::new(uuid::Uuid::new_v4(), "email-package"),
        ports,
        kind,
        payload,
    )
}

#[test]
fn rust_component_loads_with_the_real_host() {
    assert_eq!(call(Arc::new(DenyPorts), "health", "{}").unwrap(), "{}");
}

#[test]
fn a_route_runs_in_wasm_through_declared_kv_resources_only() {
    let ports = Arc::new(Fixed(Mutex::new(vec![])));
    let out = call(
        ports.clone(),
        "route",
        r#"{"method":"GET","path":"/messages","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["body"]["messages"][0]["id"], "m1");
    let out = call(
        ports.clone(),
        "route",
        r#"{"method":"GET","path":"/briefing-settings","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(response["body"]["settings"]["autoSend"], false);
    assert_eq!(*ports.0.lock().unwrap(), ["email.messages", "email.preferences"]);
}

#[test]
fn a_host_failure_reaches_the_caller_as_a_scrubbed_500() {
    let out = call(
        Arc::new(DenyPorts),
        "route",
        r#"{"method":"GET","path":"/messages","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(response["status"], 500);
    assert_eq!(response["body"], json!({"error":"Internal server error"}));
}

#[test]
fn message_content_is_sent_only_to_the_cache_write_and_never_echoed_in_errors() {
    let payload = json!({"name":"insertCachedMessage","parameters":{
        "connectorAccountId":"acct","externalId":"e1","sender":SENTINEL_ADDRESS,
        "subject":SENTINEL_BODY,"receivedAt":"2026-01-01T00:00:00.000Z",
        "recipients":[SENTINEL_ADDRESS],"bodyExcerpt":SENTINEL_BODY}})
    .to_string();
    let ports = Arc::new(Fixed(Mutex::new(vec![])));
    let refused = call(ports.clone(), "api", &payload).unwrap_err().to_string();
    assert_eq!(*ports.0.lock().unwrap(), ["email.cache-write"]);
    assert!(!refused.contains(SENTINEL_BODY) && !refused.contains(SENTINEL_ADDRESS), "{refused}");
    let denied = call(Arc::new(DenyPorts), "api", &payload).unwrap_err().to_string();
    assert!(!denied.contains(SENTINEL_BODY) && !denied.contains(SENTINEL_ADDRESS), "{denied}");
}

#[test]
fn undeclared_resources_are_refused() {
    use moss_module_host::runtime::authorize;
    let manifest = moss_email_host::package::manifest().unwrap();
    let ask = |resource: &str| {
        authorize(
            &manifest,
            "kv",
            &Request { operation: "get".into(), resource: resource.into(), parameters: json!({}) },
        )
    };
    assert!(ask("email.messages").is_ok());
    assert!(ask("email.send").is_err());
    assert!(authorize(
        &manifest,
        "db",
        &Request { operation: "query".into(), resource: "app.email_messages".into(), parameters: json!({}) }
    )
    .is_err());
    for port in ["http", "net", "model"] {
        assert!(authorize(
            &manifest,
            port,
            &Request { operation: "get".into(), resource: "x".into(), parameters: json!({}) }
        )
        .is_err(), "{port}");
    }
}

#[test]
fn package_preserves_all_eight_applied_sql_files_byte_for_byte() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_email_host::package::pack(&root, &core()).unwrap();
    let package = moss_module_host::archive::Package::read(
        &bytes,
        &moss_module_host::trust::digest(&bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(package.manifest.database.migrations.len(), 8);
    assert!(package.files["ui/email_bg.wasm"].starts_with(b"\0asm"));
    assert_eq!(package.manifest.screens["/settings/email"], "ui/settings.html");
    moss_module_host::sql::check(&package, &Default::default()).unwrap();
    for path in &package.manifest.database.migrations {
        assert_eq!(
            moss_module_host::legacy::checksum(&package, path).unwrap(),
            moss_module_host::legacy::entry("email", path).unwrap().checksum
        );
    }
}
