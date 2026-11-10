//! The installed Notes package served by the real HTTPS server executable, with the
//! server's own folder wiring. Real sign-up, real cookies, real Postgres, real files.
//! This is an HTTP check on this machine, not a native screen or second-device proof.
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

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
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("AI is not connected in this check")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Embeddings are not connected in this check")
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
#[ignore = "Only through verify-gate and the Notes server gate"]
fn installed_notes_package_serves_folder_settings_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js183-notes-{}", std::process::id())])
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
    fs::write(root.join("web/index.html"), "<!doctype html><title>Notes</title>").unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-notes-signing-secret-183","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
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
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(server.0.try_wait().unwrap().is_none(), "server startup failed");
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
    let response = client
        .post(format!("{origin}/api/auth/sign-up/email"))
        .header("origin", &origin)
        .json(&json!({"name":"Notes owner","email":"notes-owner@example.test","password":"temporary-notes-password-183-not-a-real-secret"}))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    drop(server);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (owner, app) = runtime.block_on(async {
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
                "SELECT id FROM app.users WHERE email='notes-owner@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        (
            owner,
            safety_core::db::Database::connect(
                &app_url,
                4,
                safety_core::db::RuntimeRole::App,
            )
            .await
            .unwrap(),
        )
    });
    drop(runtime);
    let access = AccessContext::new(owner, "notes-install");
    {
        let key = connector_key.clone();
        let cipher = safety_core::secret::SecretCipher::connectors(
            &std::collections::HashMap::from([("JARVIS_CONNECTOR_SECRET_KEY".into(), key)]),
        )
        .unwrap();
        let application = Application::open_extended_with(
            &root.join("data"),
            app,
            access.clone(),
            Configuration {
                migrations: Secret::new(bootstrap_url.clone()),
                producer: Secret::new(app_url.clone()),
                cipher: Arc::new(cipher),
                intelligence: Arc::new(NoAi),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: None,
            },
            Ok,
        )
        .unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let files = moss_notes_checks::package_files(
            &repo,
            fs::read(std::env::var("NOTES_TOOL_COMPONENT").unwrap()).unwrap(),
        )
        .unwrap();
        let registry = root.join("registry");
        let fixture = support::Registry::create(&registry, &files);
        let catalog = application
            .installer
            .refresh(
                &access,
                Source::Folder(registry),
                &fixture.public,
                &fixture.public,
                "notes-test-registry",
            )
            .unwrap();
        let artifact = catalog
            .select(
                "notes",
                None,
                &"0.1.0".parse().unwrap(),
                &Default::default(),
                &Default::default(),
            )
            .unwrap();
        application
            .installer
            .install(&access, &catalog, artifact, true)
            .unwrap();
    }
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
    );
    let _server = start(true);
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/notes{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| {
            panic!(
                "{path}: {e}\n{}",
                fs::read_to_string(root.join("server.log")).unwrap_or_default()
            )
        });
        let status = response.status().as_u16();
        (status, response.json::<Value>().unwrap_or(Value::Null))
    };
    use reqwest::Method;
    // The account's notes folder is prepared by the host; the test only adds content.
    let account_root = root.join("notes").join(owner.to_string());
    assert_eq!(call(Method::GET, "/notes-source", None, None).0, 401);
    let (status, none) = call(Method::GET, "/notes-source", Some(&cookie), None);
    assert_eq!((status, none["path"].clone()), (200, Value::Null), "{none}");
    fs::create_dir_all(account_root.join("Journal")).unwrap();
    fs::write(account_root.join("Journal/day.md"), b"# A day\n").unwrap();
    let (status, roots) = call(Method::GET, "/notes-source/directories", Some(&cookie), None);
    assert_eq!(status, 200, "{roots}");
    assert!(
        roots.to_string().contains(&owner.to_string()),
        "the account folder must be the offered root: {roots}"
    );
    let journal = account_root.join("Journal");
    let (status, children) = call(
        Method::GET,
        &format!("/notes-source/directories?path={}", account_root.display()),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{children}");
    assert!(children.to_string().contains("Journal"), "{children}");
    let outside = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":"/etc"})),
    );
    assert_eq!(outside.0, 400, "{}", outside.1);
    let saved = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":journal})),
    );
    assert_eq!(saved.0, 200, "{}\n{}", saved.1, fs::read_to_string(root.join("server.log")).unwrap_or_default());
    let (status, got) = call(Method::GET, "/notes-source", Some(&cookie), None);
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["path"], json!(journal), "{got}");
    let (status, state) = call(Method::GET, "/notes-last-sync", Some(&cookie), None);
    assert_eq!(status, 200, "{state}");
    let sync = call(Method::POST, "/notes/sync", Some(&cookie), Some(json!({})));
    println!("sync request answered {} {}", sync.0, sync.1);
    assert_eq!(sync.0, 202, "{}", sync.1);
    assert!(sync.1["jobId"].is_string(), "{}", sync.1);
    let unlinked = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":null})),
    );
    assert_eq!(unlinked.0, 200, "{}", unlinked.1);
    assert!(
        journal.join("day.md").is_file(),
        "unlinking must keep the files"
    );
    println!("PASS installed Notes package served over HTTPS: sign-in required, folder offered and browsed inside the account root, outside path refused, link saved, status readable, sync requested, unlink keeps files");
    println!("NOT PROVEN: indexing and search (no embeddings configured), second account, native UI, second physical device");
}
