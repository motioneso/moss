use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Ports, Request},
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::{Secret, SecretCipher},
};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio_postgres::NoTls;

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No AI in this test")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No AI in this test")
    }
}
struct Adapter {
    next: Arc<dyn Ports>,
    finishes: Arc<Mutex<Vec<bool>>>,
}
impl Ports for Adapter {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        self.next.invoke(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.finishes.lock().unwrap().push(success);
        self.next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Only through verify-gate and tools/transaction-gate.sh"]
fn extended_assembly_installs_and_dispatches_through_the_adapter() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = uuid::Uuid::new_v4();
    let database = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        db.batch_execute(moss_module_host::postgres::MIGRATION).await.unwrap();
        db.batch_execute(moss_module_host::migrations::MIGRATION).await.unwrap();
        db.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        db.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'assembly@example.test','Assembly',true)", &[&actor]).await.unwrap();
        Database::connect(&std::env::var("JS43_APP_URL").unwrap(), 4, RuntimeRole::App).await.unwrap()
    });
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = crate::common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let access = AccessContext::new(actor, "assembly");
    let finishes = Arc::new(Mutex::new(Vec::new()));
    let observed = finishes.clone();
    let app = Application::open_extended_with(
        data.path(),
        database,
        access.clone(),
        Configuration {
            migrations: Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        move |next| {
            Ok(Arc::new(Adapter {
                next,
                finishes: observed,
            }))
        },
    )
    .unwrap();
    let source = app
        .installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &crate::common::Keys::public(&keys.root),
            &crate::common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut manifest = crate::common::manifest("1.0.0");
    manifest.routes.push(moss_module_host::manifest::Route {
        method: "POST".into(),
        path: "/entries/:id".into(),
        sign_in: true,
    });
    let mut files = crate::common::files(&manifest);
    let request = r#"{"operation":"set","resource":"counter","parameters":{"count":9}}"#;
    let escaped: String = request.bytes().map(|b| format!("\\{b:02x}")).collect();
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../../sample/module.wat")
                .replace(
                    "(data (i32.const 128) \"healthy\")",
                    &format!(
                        "(data (i32.const 128) \"healthy\") (data (i32.const 256) \"{escaped}\")"
                    ),
                )
                .replace(
                    "local.get $payload local.get $length i32.const 32 call $kv",
                    &format!(
                        "i32.const 256 i32.const {} i32.const 32 call $kv",
                        request.len()
                    ),
                ),
        )
        .unwrap(),
    );
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    let digest = moss_module_host::trust::digest(&bytes);
    app.installer
        .import_file(
            &access,
            &source,
            &bytes,
            &crate::common::Keys::sign(&keys.publisher, digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    finishes.lock().unwrap().clear();
    assert!(app
        .dispatch(
            access.clone(),
            "POST",
            "/api/m/sample.counter/entries/one",
            "{}"
        )
        .is_err());
    app.dispatch_extended(
        access.clone(),
        "POST",
        "/api/m/sample.counter/entries/one?tag=a&tag=b",
        "{}",
    )
    .unwrap();
    assert_eq!(*finishes.lock().unwrap(), vec![true]);
    let saved = app
        .installer
        .call("sample.counter", access, "route", "{}")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap(),
        serde_json::json!({"saved":true})
    );
    // Native sample exercises the real LocalPorts file adapter through the entire stack.
    assert!(data.path().join("modules/files").exists());
    println!("PASS opt-in Application: signed install, template dispatch, forwarded local service and completion adapter; legacy dispatch unchanged");
}
