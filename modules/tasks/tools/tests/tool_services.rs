//! Host tool-service boundary checks. The sample is only a port trampoline;
//! compiled Tasks execution and result shapes are checked in privacy.rs.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    services::ServicePorts,
};
use safety_core::secret::SecretCipher;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("AI is unused in this fixture")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("Embeddings are unused in this fixture")
    }
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
// Return service failures to the test rather than losing their cause at the
// guest ABI. This wrapper is test-only and does not execute Tasks handlers.
struct Observe(Arc<ServicePorts>);
impl Ports for Observe {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        Ok(match self.0.invoke(scope, port, request) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        })
    }
}

#[test]
fn declared_tools_reach_host_offers_and_the_account_approval_guard() {
    let data = Scratch(std::env::temp_dir().join(format!("tasks-tools-{}", uuid::Uuid::new_v4())));
    let services = Arc::new(
        ServicePorts::new(
            &data.0,
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(DenyPorts),
        )
        .unwrap(),
    );
    let manifest = Arc::new(moss_tasks_checks::manifest().unwrap());
    let host = Host::new(Limits::default()).unwrap();
    let trampoline = wat::parse_str(
        include_str!("../../../../rust-spike/module-host/sample/module.wat")
            .replace("moss:module/kv@", "moss:module/tools@"),
    )
    .unwrap();
    let actor = AccessContext::new(uuid::Uuid::new_v4(), "tasks-tool-service");
    let call = |operation: &str, tool: &str| {
        let output = host
            .call(
                &trampoline,
                manifest.clone(),
                actor.clone(),
                Arc::new(Observe(services.clone())),
                "route",
                &json!({"operation":operation,"resource":tool,"parameters":{"parameters":{}}})
                    .to_string(),
            )
            .expect("Tasks must declare the host tool-service permission");
        serde_json::from_str::<Value>(&output).unwrap()
    };
    for tool in manifest.tools.keys() {
        assert_eq!(call("offer", tool)["ok"]["risk"], manifest.tools[tool].risk);
        assert_eq!(
            call("run", tool)["error"],
            "This tool needs the account's approval"
        );
        services
            .approve_tool(&actor, "tasks", tool, &json!({}))
            .unwrap();
        // The permission and approval checks now pass. Installation and actual
        // tool dispatch remain separate acceptance work, so no installer is bound.
        assert_eq!(call("run", tool)["error"], "The host has not started");
        assert_eq!(
            call("run", tool)["error"],
            "This tool needs the account's approval",
            "the host consumes each approval once"
        );
    }
    let permissions = manifest.permissions();
    let tools = permissions.iter().find(|p| p.port == "tools").unwrap();
    assert_eq!(
        manifest.capability("tools").unwrap().resources,
        manifest
            .tools
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
    );
    for tool in manifest.tools.keys() {
        assert!(tools.details.iter().any(|detail| detail.contains(tool)));
    }
}
