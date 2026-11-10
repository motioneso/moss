//! Synthetic Wasm integration fixture, not a real reminder producer or native UI proof.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    ai::Intelligence,
    application::{Application, Configuration},
    jobs::{manifest_hash, module_key, specs},
    manifest::{Capability, Route},
    registry::Source,
    runtime::{CallScope, Request},
};
use moss_platform_contracts::Actor;
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::{Secret, SecretCipher},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("unconfigured")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("unconfigured")
    }
}
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Port(String);
impl Drop for Port {
    fn drop(&mut self) {
        let _ = Command::new("devports").args(["release", &self.0]).output();
    }
}
fn private(path: &Path, value: &Value) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}
fn fixture(fail: bool) -> Vec<u8> {
    let request = r#"{"operation":"post","resource":"alerts","parameters":{"text":"Synthetic module worker alert"}}"#;
    let reply = r#"{"status":200,"body":{"posted":true}}"#;
    let data = |text: &str| {
        text.bytes()
            .map(|b| format!("\\{b:02x}"))
            .collect::<String>()
    };
    let mut wat =
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/notify@");
    wat = wat.replace("(data (i32.const 128) \"healthy\"))", &format!("(data (i32.const 128) \"healthy\") (data (i32.const 256) \"{}\") (data (i32.const 512) \"{}\"))", data(request), data(reply)));
    let start = wat.find("      local.get $kind i32.load8_u").unwrap();
    let end = wat[start..].find("      i32.const 32))").unwrap() + start;
    wat.replace_range(start..end, &format!(
        "      local.get $kind i32.load8_u i32.const 104 i32.ne if\n      i32.const 256 i32.const {} i32.const 32 call $kv\n      {}\n      i32.const 32 i32.load i32.eqz if\n        i32.const 36 i32.const 512 i32.store\n        i32.const 40 i32.const {} i32.store\n      end\n      else\n        i32.const 32 i32.const 0 i32.store\n        i32.const 36 i32.const 128 i32.store\n        i32.const 40 i32.const 7 i32.store\n      end\n", request.len(), if fail { "unreachable" } else { "" }, reply.len()));
    wat::parse_str(wat).unwrap()
}
#[test]
#[ignore = "Only through verify-gate and the assembly gate"]
fn module_worker_and_https_feed_assemble_without_a_desktop() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js170-assembly-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!port.0.is_empty());
    let origin = format!("https://localhost:{}", port.0);
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    fs::create_dir(root.join("web")).unwrap();
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Assembly HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-assembly-signing-secret-170","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let start = |modules: bool| {
        let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
        command
            .arg("--network")
            .arg(root.join("network.json"))
            .arg("--web")
            .arg(root.join("web"));
        if modules {
            command.arg("--modules").arg(root.join("modules.json"));
        }
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("server.log"))
            .unwrap();
        let mut server = Server(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                server.0.try_wait().unwrap().is_none(),
                "server startup failed"
            );
            if client
                .get(format!("{origin}/api/hello"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(Instant::now() < deadline, "server startup deadline");
            std::thread::sleep(Duration::from_millis(100));
        }
        server
    };
    let server = start(false);
    let signup = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":"Assembly owner","email":"assembly@example.test","password":"temporary-assembly-password-170-not-a-real-secret"})).send().unwrap();
    assert_eq!(signup.status(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    drop(server);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (db, app, owner) = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        for migration in [
            moss_module_host::postgres::MIGRATION,
            moss_module_host::migrations::MIGRATION,
            moss_platform_jobs::MIGRATION,
            moss_module_host::jobs::MIGRATION,
        ] {
            db.batch_execute(migration).await.unwrap();
        }
        let owner: uuid::Uuid = db
            .query_one(
                "SELECT id FROM app.users WHERE email='assembly@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        let app = Database::connect(&app_url, 4, RuntimeRole::App)
            .await
            .unwrap();
        (db, app, owner)
    });
    let access = AccessContext::new(owner, "assembly");
    let config = Configuration {
        migrations: Secret::new(bootstrap_url.clone()),
        producer: Secret::new(app_url.clone()),
        cipher: Arc::new(
            SecretCipher::connectors(
                &[("JARVIS_CONNECTOR_SECRET_KEY".into(), connector_key.clone())].into(),
            )
            .unwrap(),
        ),
        intelligence: Arc::new(NoAi),
        version: "0.1.0".parse().unwrap(),
        compiled_cache: None,
    };
    let application =
        Application::open_extended(&root.join("data"), app.clone(), access.clone(), config)
            .unwrap();
    let registry = root.join("registry");
    fs::create_dir(&registry).unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(&registry, "1.0.0", 1, vec![]);
    let source = application
        .installer
        .refresh(
            &access,
            Source::Folder(registry),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut manifest = common::manifest("1.0.0");
    manifest.capabilities = vec![
        Capability {
            port: "notify".into(),
            operations: ["post".into()].into(),
            resources: ["alerts".into()].into(),
            allow_private: false,
        },
        Capability {
            port: "jobs".into(),
            operations: ["schedule".into()].into(),
            resources: ["alert".into()].into(),
            allow_private: false,
        },
    ];
    manifest.jobs.insert("alert".into(), Default::default());
    manifest.routes.push(Route {
        method: "POST".into(),
        path: "/alert".into(),
        sign_in: true,
    });
    let mut files = common::files(&manifest);
    let install = |files: &std::collections::BTreeMap<String, Vec<u8>>| {
        let bytes = moss_module_host::archive::pack(files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        application
            .installer
            .import_file(
                &access,
                &source,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    };
    let _ = artifact;
    files.insert("code/module.wasm".into(), fixture(true));
    install(&files);
    assert!(application
        .installer
        .call(&manifest.id, access.clone(), "route", "null")
        .is_err());
    assert_eq!(
        runtime
            .block_on(db.query_one(
                "SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1",
                &[&owner]
            ))
            .unwrap()
            .get::<_, i64>(0),
        0,
        "A failed invocation must roll its notification back"
    );
    manifest.version = "1.1.0".parse().unwrap();
    files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    files.insert("code/module.wasm".into(), fixture(false));
    install(&files);
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    drop(application);
    // Only the executable below advances and executes this overdue schedule.
    runtime.block_on(async {
        let declarations = specs(&manifest);
        let queue = Queue::connect(&app_url, Role::Producer, declarations.clone()).await.unwrap();
        let id = uuid::Uuid::new_v4();
        queue.schedule(Actor::from_authenticated_session(owner, uuid::Uuid::new_v4()), id, &declarations[0].name, json!({"actorUserId":owner,"moduleId":module_key(&manifest.id),"manifestHash":manifest_hash(&manifest),"jobKind":declarations[0].name,"params":{}}), "* * * * *", "UTC", chrono::Utc::now()-chrono::Duration::minutes(2)).await.unwrap();
    });
    let server = start(true);
    let deadline = Instant::now() + Duration::from_secs(30);
    let client_id = uuid::Uuid::new_v4();
    let notice_id = loop {
        let response = client
            .get(format!("{origin}/api/desktop/notices?client={client_id}"))
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().unwrap();
        if let Some(id) = body["events"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
        {
            break id.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "server worker must run the due schedule and publish to the feed"
        );
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(
        client
            .post(format!("{origin}/api/m/sample.counter/alert"))
            .header("origin", &origin)
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        401
    );
    let reply = client
        .post(format!("{origin}/api/m/sample.counter/alert"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().unwrap(), json!({"posted":true}));
    let accepted = client
        .post(format!("{origin}/api/desktop/notices"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({"client":client_id,"events":[notice_id]}))
        .send()
        .unwrap();
    assert_eq!(accepted.status(), 200);
    runtime.block_on(async {
        assert!(db.query_one("SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1 AND module_id='sample.counter'", &[&owner]).await.unwrap().get::<_,i64>(0) >= 2);
        assert_eq!(db.query_one("SELECT count(*) FROM app.notification_reads WHERE user_id=$1", &[&owner]).await.unwrap().get::<_,i64>(0), 0);
    });
    drop(server);
    println!("PASS real HTTPS executable: owner signup, existing module catalog, server-owned due schedule execution, synthetic Wasm notification in desktop feed, authenticated module dispatch, durable acknowledgement without bell reads; failed guest rolls notification back");
    println!("NOT PROVEN: real reminder producers, installed desktop, background process, native target devices or second-device HTTPS");
}
