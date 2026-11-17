//! Live proof for the public-web fetch mode: a real installed package on the real application,
//! reaching the real public internet. Run only through verify-gate and the public-web gate.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    ai::Intelligence,
    application::{Application, Configuration},
    manifest::Capability,
    registry::Source,
    runtime::{CallScope, Request},
};
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
#[test]
#[ignore = "Only through verify-gate and the public-web gate"]
fn installed_package_reads_the_real_public_web_and_refuses_private_addresses() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js272-public-web-{}", std::process::id())])
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
        "<!doctype html><title>Public web HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-public-web-signing-secret-272","connector_key":connector_key}),
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
    let signup = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":"Public web owner","email":"publicweb@example.test","password":"temporary-assembly-password-170-not-a-real-secret"})).send().unwrap();
    assert_eq!(signup.status(), 200);
    let _cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    drop(server);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (_db, app, owner) = runtime.block_on(async {
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
                "SELECT id FROM app.users WHERE email='publicweb@example.test'",
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
            fuel_ceiling: None,
            browser_dir: None,
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
    manifest.capabilities = vec![Capability {
        port: "fetch".into(),
        operations: ["get".into()].into(),
        resources: ["public-web".into()].into(),
        allow_private: false,
    }];
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

    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/fetch@"),
    )
    .unwrap();
    files.insert("code/module.wasm".into(), wasm);
    install(&files);
    let read = |url: &str, extra: Value| -> Value {
        let mut parameters = json!({"url": url});
        parameters.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let request = json!({"operation":"get","resource":"public-web","parameters":parameters}).to_string();
        let out = application
            .installer
            .call(&manifest.id, access.clone(), "route", &request)
            .unwrap();
        serde_json::from_str(&out).unwrap()
    };
    let page = read("https://example.com/", json!({}));
    println!("LIVE example.com -> ok={} status={} bytes={}", page["ok"], page["status"], page["body"].as_str().map_or(0, str::len));
    assert_eq!(page["ok"], true, "{page}");
    assert!(page["body"].as_str().unwrap().contains("Example Domain"));
    for (url, want) in [
        ("https://10.0.0.5/", "blocked"),
        ("https://127.0.0.1/", "blocked"),
        ("https://localhost/", "blocked"),
        ("https://100.64.0.9/", "blocked"),
        ("https://[::1]/", "blocked"),
        ("http://example.com/", "not_https"),
        ("https://example.com:8443/", "blocked"),
    ] {
        let v = read(url, json!({}));
        println!("LIVE {url} -> {v}");
        assert_eq!((v["ok"].as_bool(), v["reason"].as_str()), (Some(false), Some(want)), "{url}: {v}");
    }
    let v = read("https://example.com/", json!({"maxBytes": 100}));
    assert_eq!((v["ok"].as_bool(), v["truncated"].as_bool()), (Some(true), Some(true)), "{v}");
    // The real server process starts with the installed package and stays reachable over HTTPS.
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    drop(application);
    let server = start(true);
    let hello = client.get(format!("{origin}/api/hello")).send().unwrap();
    println!("LIVE server /api/hello -> {}", hello.status());
    assert!(hello.status().is_success());
    drop(server);
}
