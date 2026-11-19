use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("MEALS_COMPONENT_WASM")
            .expect("Run modules/meals/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_meals_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "meals-package"),
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
        &json!({"queue":"meals-x","payload":{"name":"SECRET-NAME"}}).to_string(),
    )
    .unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-NAME"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_meals_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 27);
    for needed in [
        "moss.module.json",
        "code/module.wasm",
        "LICENSE",
        "NOTICE",
        "CHANGELOG.md",
    ] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_meals_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_serves_the_meals_screen() {
    let manifest = moss_meals_host::package::manifest().unwrap();
    assert_eq!(manifest.screens["/meals"], "ui/index.html");
    assert_eq!(manifest.screens["/settings/meals"], "ui/settings.html");
    let files = moss_meals_host::package::files(&root(), &component()).unwrap();
    for name in [
        "index.html", "app.mjs", "api.mjs", "format.mjs", "kit.mjs", "plan.mjs", "plan-day.mjs",
        "recipe.mjs", "list.mjs", "list-dialogs.mjs", "pantry.mjs", "pantry-dialogs.mjs",
        "household.mjs", "log.mjs", "log-dialogs.mjs", "log-format.mjs", "plan-new.mjs",
        "swap.mjs", "arrange.mjs", "settings.html", "settings.mjs", "guest-bridge.mjs",
        "meals.css",
    ] {
        assert!(files.contains_key(&format!("ui/{name}")), "ui/{name} missing");
    }
    let nav = &manifest.navigation[0];
    assert_eq!(nav["path"], "/meals");
    assert!(manifest.screens.contains_key(nav["path"].as_str().unwrap()));
    assert!(manifest
        .routes
        .iter()
        .any(|r| r.path == "/meals/screen/tool" && r.sign_in));
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_meals_host::package::manifest().unwrap();
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
    assert!(ask("db", "query", "app.meals_kitchens").is_ok());
    assert!(ask("db", "query", "app.meals_household_members").is_ok());
    assert!(ask("db", "query", "app.users").is_err());
    assert!(ask("db", "query", "app.tasks").is_err());
    assert!(ask("kv", "get", "meals.store").is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("external-modules/meals/sql");
    let to = copy.join("external-modules/meals/sql");
    std::fs::create_dir_all(&to).unwrap();
    for entry in std::fs::read_dir(&from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let mut bytes = std::fs::read(entry.path()).unwrap();
        if name.to_string_lossy().starts_with("0001") {
            bytes.push(b'\n');
        }
        std::fs::write(to.join(name), bytes).unwrap();
    }
    assert!(moss_meals_host::package::files(copy, &component()).is_err());
}
