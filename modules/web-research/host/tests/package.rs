use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("WEB_RESEARCH_COMPONENT_WASM")
            .expect("Run modules/web-research/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_web_research_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "web-research-package"),
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
    let out = call("route", r#"{"method":"GET","path":"/nope","params":{},"query":{},"body":null}"#).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], 404);
}

#[test]
fn a_job_is_refused_with_fixed_text() {
    let err = call("job", &json!({"queue":"web-x","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_web_research_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 0);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_web_research_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_owns_no_tables_and_shares_only_the_search_switch() {
    let manifest = moss_web_research_host::package::manifest().unwrap();
    assert!(manifest.database.migrations.is_empty());
    assert_eq!(manifest.install_wide_kv.iter().collect::<Vec<_>>(), ["native-search"]);
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_web_research_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str, parameters: Value| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters,
        })
    };
    let brave = "api.search.brave.com";
    assert!(ask("credentials", "status", brave, json!({"credential":"braveSearch"})).is_ok());
    assert!(ask("credentials", "request", brave, json!({"credential":"braveSearch","url":"https://api.search.brave.com/res/v1/web/search?q=a","method":"GET"})).is_ok());
    assert!(ask("credentials", "request", "example.test", json!({"credential":"braveSearch","url":"https://example.test/"})).is_err());
    assert!(ask("credentials", "status", "example.test", json!({"credential":"braveSearch"})).is_err());
    assert!(ask("credentials", "status", brave, json!({"credential":"other"})).is_err());
    assert!(ask("ai", "capabilities", "chat", json!({})).is_ok());
    assert!(ask("ai", "generate", "chat", json!({})).is_err());
    assert!(ask("kv", "get", "native-search", json!({})).is_ok());
    assert!(ask("kv", "set", "native-search", json!({})).is_err());
    assert!(ask("kv", "get", "memory.core", json!({})).is_err());
    assert!(ask("fetch", "get", brave, json!({"url":"https://api.search.brave.com/"})).is_err());
    assert!(ask("db", "query", "app.users", json!({"kind":"select"})).is_err());
    assert!(ask("jobs", "schedule", "web-x", json!({})).is_err());
}

/// A stand-in for the host's services. It records every call the real component makes and
/// answers like the host would for a saved key and a canned search reply.
struct Recorder {
    key_saved: bool,
    reply: Value,
    seen: std::sync::Mutex<Vec<(String, String, String, Value)>>,
}
impl moss_module_host::runtime::Ports for Recorder {
    fn invoke(
        &self,
        _: &moss_module_host::runtime::CallScope,
        port: &str,
        request: &Request,
    ) -> anyhow::Result<Value> {
        self.seen.lock().unwrap().push((
            port.into(),
            request.operation.clone(),
            request.resource.clone(),
            request.parameters.clone(),
        ));
        match (port, request.operation.as_str()) {
            ("credentials", "status") => Ok(json!({"configured": self.key_saved})),
            ("credentials", "request") => Ok(json!({"status": 200, "body": self.reply})),
            ("kv", "get") => Ok(Value::Null),
            ("ai", "capabilities") => Ok(json!({"model": null})),
            _ => anyhow::bail!("unexpected call"),
        }
    }
}
fn call_with(ports: Arc<Recorder>, kind: &str, payload: &str) -> anyhow::Result<Value> {
    let out = Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_web_research_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "web-research-package"),
        ports,
        kind,
        payload,
    )?;
    Ok(serde_json::from_str(&out)?)
}
fn recorder(key_saved: bool) -> Arc<Recorder> {
    Arc::new(Recorder {
        key_saved,
        reply: json!({"web":{"results":[
            {"title":"One","url":"https://News.Example.com/a?x=1","description":"First","age":"1 day ago"},
            {"title":"Two","url":"https://example.org/b","description":"Second"}
        ]}}),
        seen: Default::default(),
    })
}

#[test]
fn the_real_component_searches_through_the_credential_broker_and_leaks_nothing() {
    const MARK: &str = "zq7-live-marker-5521";
    let ports = recorder(true);
    let out = call_with(
        ports.clone(),
        "tool",
        &json!({"tool":"web.search","parameters":{"query":MARK,"limit":2}}).to_string(),
    )
    .unwrap();
    let data = &out["data"];
    assert_eq!(data["results"][0]["resultId"], "web-1");
    assert_eq!(data["results"][0]["domain"], "news.example.com");
    assert_eq!(data["results"][1]["title"], "Two");
    assert_eq!(data["trace"]["provider"], "brave");
    for (port, op, resource, params) in ports.seen.lock().unwrap().iter() {
        let text = format!("{resource}{params}");
        if (port.as_str(), op.as_str()) == ("credentials", "request") {
            assert!(params["url"].as_str().unwrap().contains(MARK));
            assert!(params.get("headers").is_none(), "the key is attached by the host");
        } else {
            assert!(!text.contains(MARK), "{port}.{op} carried the query");
        }
    }
}

#[test]
fn another_package_gets_results_and_the_gate_through_the_api() {
    let ports = recorder(true);
    let found = call_with(
        ports.clone(),
        "api",
        &json!({"name":"webSearch","parameters":{"query":"topic"}}).to_string(),
    )
    .unwrap();
    let row = &found["data"]["results"][0];
    assert_eq!((row["title"].as_str(), row["snippet"].as_str(), row["publishedAt"].as_str()), (Some("One"), Some("First"), Some("1 day ago")));
    assert!(row["url"].as_str().unwrap().starts_with("https://News.Example.com"));
    let gate = call_with(ports, "api", &json!({"name":"webSearchStatus","parameters":{}}).to_string()).unwrap();
    assert_eq!(gate["data"]["engine"], "brave");
}

#[test]
fn with_no_key_the_status_route_gives_the_reason_and_search_makes_no_request() {
    let ports = recorder(false);
    let out = call_with(ports.clone(), "route", r#"{"method":"GET","path":"/status","params":{},"query":{},"body":null}"#).unwrap();
    assert_eq!(out["status"], 200);
    assert_eq!(out["body"]["webSearchReason"], "no-key-no-native-model");
    let search = call_with(ports.clone(), "tool", &json!({"tool":"web.search","parameters":{"query":"q"}}).to_string()).unwrap();
    assert_eq!(search["data"]["trace"]["reason"], "no-key-no-native-model");
    assert!(ports.seen.lock().unwrap().iter().all(|c| !(c.0 == "credentials" && c.1 == "request")));
}
