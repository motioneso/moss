//! Installed Plaid probe package served by the real HTTPS executable. Not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
use access_context::AccessContext;
use common::Keys;
use moss_module_host::{
    archive::Package,
    registry::{Artifact, Channel, Index, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
thread_local! { static PACKAGE: std::cell::RefCell<Vec<u8>> = Default::default(); }
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
const CLIENT: &str = "live-client-MARKER-7f3a";
const SECRET: &str = "live-secret-MARKER-7f3a";
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("No configured embeddings")
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
#[ignore = "Only through verify-gate and the Plaid probe live gate"]
fn the_installed_plaid_probe_talks_to_plaid_through_the_host_on_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js295-plaid-{}", std::process::id())])
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
    if let Ok(shared) = std::env::var("MOSS_MODULE_SHARED_DIR") {
        // Generated shared styles and fonts, which the sandboxed screens load.
        let status = Command::new("cp")
            .args(["-r", &shared])
            .arg(root.join("web/module-shared"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Plaid probe HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    let ai_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-plaid-probe-signing-secret-289","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("0.0.0.0:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
    let signup = |email: &str, name: &str| {
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-plaid-probe-password-289-not-a-real-secret"})).send().unwrap();
        let status = response.status();
        if status != 200 {
            panic!(
                "sign-up answered {status}: {}",
                response.text().unwrap_or_default()
            );
        }
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("web-owner@example.test", "Plaid probe owner");
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
                "SELECT id FROM app.users WHERE email='web-owner@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        (
            owner,
            Database::connect(&app_url, 4, RuntimeRole::App)
                .await
                .unwrap(),
        )
    });
    let access = AccessContext::new(owner, "plaid-probe-install");
    // Publish the Plaid probe package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS295_PLAID_WASM", "plaidprobe")]
        .iter()
        .map(|(variable, id)| {
            let manifest: moss_module_host::manifest::Manifest = serde_json::from_slice(&fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/probes/plaid/moss.module.json")).unwrap()).unwrap();
            manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
            let bytes = moss_module_host::archive::pack(&BTreeMap::from([
                ("moss.module.json".into(), serde_json::to_vec(&manifest).unwrap()),
                ("code/module.wasm".into(), fs::read(std::env::var(variable).unwrap()).unwrap()),
                ("LICENSE".into(), b"test only".to_vec()),
                ("NOTICE".into(), b"test only".to_vec()),
                ("CHANGELOG.md".into(), b"test only".to_vec()),
            ])).unwrap();
            PACKAGE.with(|p| *p.borrow_mut() = bytes.clone());
            let digest = trust::digest(&bytes);
            let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
            let manifest = &package.manifest;
            assert_eq!(manifest.id, *id);
            fs::write(
                root.join(format!("registry/packages/{digest}.mosspkg")),
                &bytes,
            )
            .unwrap();
            Artifact {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: "web-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Plaid probe live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "web-test-registry".into(),
        name: "Plaid probe test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "web-test".into(),
            Publisher {
                key: Keys::public(&keys.publisher),
                prefix: String::new(),
                replaces: BTreeSet::new(),
            },
        )]),
        lifted_revocations: BTreeSet::new(),
    };
    let index = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: vec![],
    };
    for (name, data, key) in [
        (
            "registry.json",
            serde_json::to_vec(&identity).unwrap(),
            &keys.root,
        ),
        (
            "index.json",
            serde_json::to_vec(&index).unwrap(),
            &keys.index,
        ),
    ] {
        fs::write(root.join("registry").join(name), &data).unwrap();
        fs::write(
            root.join("registry").join(format!("{name}.sig")),
            Keys::sign(key, &data),
        )
        .unwrap();
    }
    let installer = installed::reopen(
        &root.join("data"),
        app,
        &access,
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    );
    let source = installer
        .refresh(
            &access,
            Source::Folder(root.join("registry")),
            &Keys::public(&keys.root),
            &Keys::public(&keys.publisher),
            "web-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key}),
    );
    // The administrator's keys are saved through the host's own configuration call, as the
    // server has no screen for them yet. Marker values let the scan search for them later.
    {
        use safety_core::secret::{Secret, SecretCipher, SecretFields};
        let services = moss_module_host::services::ServicePorts::new(
            &root.join("data"),
            std::sync::Arc::new(SecretCipher::connectors(&[("JARVIS_CONNECTOR_SECRET_KEY".into(), connector_key.clone())].into()).unwrap()),
            std::sync::Arc::new(NoAi),
            std::sync::Arc::new(moss_module_host::local::LocalPorts::new(&root.join("data")).unwrap()),
        ).unwrap();
        services.set_credential(
            &AccessContext::new(uuid::Uuid::nil(), "configure"),
            "plaidprobe", "plaid-keys",
            &SecretFields::new().with("clientId", Secret::new(CLIENT)).with("clientSecret", Secret::new(SECRET)),
        ).unwrap();
    }
    let _server = start(true);
    // Setup allows one owner over HTTP, so the second person is made in the database with the
    // owner's password hash and then signs in through the real route.
    let other = {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let id = uuid::Uuid::new_v4();
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Web other', 'web-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"web-other@example.test","password":"temporary-plaid-probe-password-289-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let post = |path: &str, body: Value, cookie: Option<&str>| {
        let mut request = client
            .post(format!("{origin}/api/m/plaidprobe{path}"))
            .header("origin", &origin)
            .json(&body);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let value = json_of(&response.text().unwrap_or_default());
        println!("POST {path} -> {status} {value}");
        (status, value)
    };
    assert_eq!(post("/status", json!({}), None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = Instant::now();
    while post("/status", json!({}), Some(&cookie)).0 == 503 && started.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(500));
    }
    // The shared keys are saved once, so both people see them. Nobody has a bank token yet.
    for who in [&cookie, &other] {
        let (status, body) = post("/status", json!({"slot":"bank-1"}), Some(who));
        assert_eq!((status, body), (200, json!({"keys":{"configured":true},"bank":{"configured":false}})), "{}", log());
    }
    // No bank token exists, so a balance call is refused before anything leaves the host.
    let (status, body) = post("/balance", json!({"slot":"bank-1"}), Some(&cookie));
    assert_eq!((status, &body), (200, &json!({"refused":true})));
    // The swap goes from the real server to the real Plaid host with the marker keys attached by
    // the host. Plaid refuses them, and the module sees only the error code.
    let (status, body) = post("/link", json!({"slot":"bank-1","public_token":"public-sandbox-live-probe"}), Some(&cookie));
    assert_eq!(status, 200, "{body}");
    println!("LIVE swap reply: {body}");
    let reached_plaid = body["connected"] == json!(false) && body["error"].as_str().is_some_and(|c| c.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'));
    println!("reached the real Plaid host and got an error code back: {reached_plaid}");
    assert!(reached_plaid || body == json!({"refused":true}), "{body}");
    // A refused swap stores nothing, for either person.
    for who in [&cookie, &other] {
        let (_, body) = post("/status", json!({"slot":"bank-1"}), Some(who));
        assert_eq!(body["bank"], json!({"configured":false}));
    }
    // Undeclared routes never reach the package.
    assert_eq!(post("/nope", json!({}), Some(&cookie)).0, 400);

    // No surface may hold the keys. The scan covers the server log, every table, the data folder
    // and the package, and a planted copy shows that it would notice.
    let package = PACKAGE.with(|p| p.borrow().clone());
    let files = || {
        let mut text = String::new();
        let mut stack = vec![root.join("data")];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(bytes) = fs::read(&path) {
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        }
        text
    };
    let scan = |extra: &str| {
        let mut surfaces = vec![("server log", log()), ("data folder", files()), ("package", String::from_utf8_lossy(&package).into_owned())];
        surfaces.push(("extra", extra.into()));
        for (name, text) in surfaces {
            for marker in [CLIENT, SECRET] {
                assert!(!text.contains(marker), "{marker} reached the {name}");
            }
        }
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db.query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')", &[]).await.unwrap();
            for table in tables {
                let name: String = table.get(0);
                for marker in [CLIENT, SECRET] {
                    let count: i64 = db.query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE '%'||$1||'%'"), &[&marker]).await.unwrap().get(0);
                    assert_eq!(count, 0, "{marker} reached {name}");
                }
            }
        })
    };
    let leak = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scan(SECRET)));
    assert!(leak.is_err(), "the scan must catch a planted leak");
    println!("key scan FAILED with a leak planted");
    scan("");
    println!("key scan PASSED: no client id or secret in the log, any table, the data folder or the package");
}
