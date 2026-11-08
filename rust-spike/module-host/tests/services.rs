mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    local::LocalPorts,
    manifest::{Capability, Manifest, Tool},
    runtime::{CallScope, Host, Limits, Ports, Request},
    services::ServicePorts,
};
use safety_core::secret::{Secret, SecretCipher, SecretFields};
use serde_json::{json, Value};
use std::sync::Arc;
struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}
fn call(
    host: &Host,
    ports: Arc<dyn Ports>,
    manifest: &Manifest,
    actor: uuid::Uuid,
    port: &str,
    request: Value,
) -> Result<Value> {
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@", &format!("moss:module/{port}@")),
    )?;
    let out = host.call(
        &wasm,
        Arc::new(manifest.clone()),
        AccessContext::new(actor, "services"),
        ports,
        "route",
        &request.to_string(),
    )?;
    Ok(serde_json::from_str(&out)?)
}
#[test]
fn handed_attachments_are_account_and_module_scoped_through_wasm() {
    let data = tempfile::tempdir().unwrap();
    let cipher = Arc::new(SecretCipher::connectors(&Default::default()).unwrap());
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            cipher,
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let id = services
        .hand_attachment(
            &AccessContext::new(a, "upload"),
            "sample.counter",
            b"actual upload bytes",
            "text/plain",
        )
        .unwrap();
    services
        .set_credential(
            &AccessContext::new(a, "configure"),
            "sample.counter",
            "api",
            &SecretFields::new().with("value", Secret::new("test-only-sentinel")),
        )
        .unwrap();
    let mut m = common::manifest("1.0.0");
    m.capabilities.push(Capability {
        port: "attachments".into(),
        operations: ["read".into()].into(),
        resources: [id.clone()].into(),
        allow_private: false,
    });
    let host = Host::new(Limits::default()).unwrap();
    let r = json!({"operation":"read","resource":id,"parameters":{}});
    let out = call(&host, services.clone(), &m, a, "attachments", r.clone()).unwrap();
    assert_eq!(out["mediaType"], "text/plain");
    assert!(call(&host, services.clone(), &m, b, "attachments", r.clone()).is_err());
    m.id = "other.counter".into();
    assert!(call(&host, services, &m, a, "attachments", r).is_err());
}
#[test]
fn install_wide_storage_is_explicit_and_tools_cannot_lower_declared_risk() {
    let data = tempfile::tempdir().unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let host = Host::new(Limits::default()).unwrap();
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut m = common::manifest("1.0.0");
    call(
        &host,
        services.clone(),
        &m,
        a,
        "kv",
        json!({"operation":"set","resource":"counter","parameters":{"value":7}}),
    )
    .unwrap();
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            b,
            "kv",
            json!({"operation":"get","resource":"counter"})
        )
        .unwrap(),
        Value::Null
    );
    m.install_wide_kv.insert("counter".into());
    call(
        &host,
        services.clone(),
        &m,
        a,
        "kv",
        json!({"operation":"set","resource":"counter","parameters":{"shared":9}}),
    )
    .unwrap();
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            b,
            "kv",
            json!({"operation":"get","resource":"counter"})
        )
        .unwrap(),
        json!({"shared":9})
    );
    m.tools.insert(
        "erase".into(),
        Tool {
            description: "Erase data".into(),
            risk: "destructive".into(),
        },
    );
    m.capabilities.push(Capability {
        port: "tools".into(),
        operations: ["offer".into(), "run".into()].into(),
        resources: ["erase".into()].into(),
        allow_private: false,
    });
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            a,
            "tools",
            json!({"operation":"offer","resource":"erase"})
        )
        .unwrap()["risk"],
        "destructive"
    );
    for parameters in [json!({"risk":"read"}), json!({})] {
        assert!(call(
            &host,
            services.clone(),
            &m,
            a,
            "tools",
            json!({"operation":"run","resource":"erase","parameters":parameters})
        )
        .is_err());
    }
}
