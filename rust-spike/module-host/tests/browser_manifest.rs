//! What a package must declare to use the browser port, and what the host refuses before any
//! browser starts. Needs no browser.
mod common;
use moss_module_host::{
    manifest::{Capability, Manifest},
    runtime::{authorize, Request},
};
use semver::Version;
use serde_json::json;

fn with(port: &str, ops: &[&str], resources: &[&str], allow_private: bool) -> Manifest {
    let mut manifest = common::manifest("1.0.0");
    manifest.capabilities.push(Capability {
        port: port.into(),
        operations: ops.iter().map(|o| o.to_string()).collect(),
        resources: resources.iter().map(|r| r.to_string()).collect(),
        allow_private,
    });
    manifest
}
fn request(operation: &str, resource: &str, parameters: serde_json::Value) -> Request {
    Request {
        operation: operation.into(),
        resource: resource.into(),
        parameters,
    }
}

#[test]
fn only_public_pages_can_be_declared_and_never_with_private_access() {
    let moss = Version::new(0, 1, 0);
    assert!(with("browser", &["render"], &["public-web"], false).validate(&moss).is_ok());
    for bad in [
        with("browser", &["render"], &["public-web"], true),
        with("browser", &["render"], &["espn.com"], false),
        with("browser", &[], &["public-web"], false),
    ] {
        assert!(bad.validate(&moss).is_err());
    }
}

#[test]
fn the_install_review_names_the_browser_in_plain_words() {
    let lines = with("browser", &["render"], &["public-web"], false).permissions();
    let line = lines.iter().find(|p| p.port == "browser").unwrap();
    assert_eq!(line.group, "network");
    assert_eq!(line.headline, "Open pages you confirm in a sandboxed browser");
}

#[test]
fn a_request_must_name_the_public_web_and_a_url() {
    let manifest = with("browser", &["render"], &["public-web"], false);
    let url = json!({"url":"https://ok.test/","allowedHosts":["ok.test"]});
    assert!(authorize(&manifest, "browser", &request("render", "public-web", url.clone())).is_ok());
    assert!(authorize(&manifest, "browser", &request("render", "ok.test", url)).is_err());
    assert!(authorize(&manifest, "browser", &request("render", "public-web", json!({}))).is_err());
    assert!(authorize(
        &manifest,
        "browser",
        &request("click", "public-web", json!({"url":"https://ok.test/"}))
    )
    .is_err());
    // A package with no browser grant cannot use the port at all.
    let plain = common::manifest("1.0.0");
    assert!(authorize(&plain, "browser", &request("render", "public-web", json!({"url":"https://ok.test/"}))).is_err());
}
