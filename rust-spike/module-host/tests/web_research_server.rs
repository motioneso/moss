//! Installed Web Research package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Web Research live gate"]
fn installed_web_research_package_serves_status_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js289-web-{}", std::process::id())])
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
        "<!doctype html><title>Web Research HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-web-research-signing-secret-289","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-web-research-password-289-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("web-owner@example.test", "Web Research owner");
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
    let access = AccessContext::new(owner, "web-research-install");
    // Publish the Web Research package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_WEB_RESEARCH_PACKAGE", "web")]
        .iter()
        .map(|(variable, id)| {
            let bytes = fs::read(std::env::var(variable).unwrap()).unwrap();
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
                presentation: None,
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
                changelog: "Web Research live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "web-test-registry".into(),
        name: "Web Research test registry".into(),
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
        publish_reviews: Default::default(),
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
            .json(&json!({"email":"web-other@example.test","password":"temporary-web-research-password-289-not-a-real-secret"})).send().unwrap();
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
    let call = |path: &str, cookie: Option<&str>| {
        let mut request = client
            .get(format!("{origin}/api/m/web{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request
            .send()
            .unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{path} -> {status}");
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    assert_eq!(call("/status", None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = Instant::now();
    while call("/status", Some(&cookie)).0 == 503 && started.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(500));
    }
    // This server has no search key and no chat model, so both people get the same reason.
    let expected = json!({"webSearchConfigured":false,"engine":"none","webSearchReason":"no-key-no-native-model"});
    for who in [&cookie, &other] {
        let (status, text) = call("/status", Some(who));
        assert_eq!(
            (status, json_of(&text)),
            (200, expected.clone()),
            "{text}\n{}",
            log()
        );
    }
    // The server refuses a path the manifest does not declare before the package sees it.
    assert_eq!(call("/nope", Some(&cookie)).0, 400);
    // Page reading goes through the same real route path, with the same sign-in rule.
    const MARK: &str = "PLANTED-LIVE-MARKER-web-7d2e";
    let read = |urls: Value, cookie: Option<&str>| {
        let mut request = client
            .post(format!("{origin}/api/m/web/read"))
            .header("origin", &origin)
            .json(&json!({ "urls": urls }));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = request
            .send()
            .unwrap_or_else(|e| panic!("read: {e}\n{}", log()));
        let status = response.status().as_u16();
        let body = json_of(&response.text().unwrap_or_default());
        println!("POST /read -> {status}");
        (status, body)
    };
    assert_eq!(read(json!(["https://example.com/"]), None).0, 401);
    assert_eq!(read(json!([]), Some(&cookie)).0, 400);
    let private_marker = format!("https://10.0.0.5/{MARK}");
    for who in [&cookie, &other] {
        let (status, body) = read(
            json!([
                private_marker,
                "https://127.0.0.1/",
                "https://localhost/",
                "http://example.com/"
            ]),
            Some(who),
        );
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["documents"].as_array().unwrap().len(), 0, "{body}");
        let reasons: Vec<&str> = body["trace"]["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["reason"].as_str().unwrap())
            .collect();
        assert_eq!(
            reasons,
            ["blocked", "blocked", "blocked", "not_https"],
            "{body}"
        );
    }
    println!("private and loopback addresses refused for two people");
    for who in [&cookie, &other] {
        let (status, body) = read(json!(["https://example.com/"]), Some(who));
        assert_eq!(status, 200, "{body}");
        let doc = &body["documents"][0];
        println!(
            "LIVE example.com read -> title={} text_len={}",
            doc["title"],
            doc["text"].as_str().map_or(0, str::len)
        );
        assert!(
            doc["text"]
                .as_str()
                .unwrap_or("")
                .contains("Example Domain"),
            "{body}"
        );
        assert_eq!(doc["domain"], "example.com");
        std::thread::sleep(Duration::from_millis(1500));
    }
    // Another device reaches the server through the machine's network address, not loopback. The
    // address is found from the routing table and is never printed.
    let lan = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket
                .connect("192.0.2.1:9")
                .and_then(|_| socket.local_addr())
        })
        .map(|addr| addr.ip());
    match lan {
        Ok(ip) if !ip.is_loopback() => {
            let remote = reqwest::blocking::Client::builder()
                .add_root_certificate(
                    reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap(),
                )
                .no_proxy()
                .resolve(
                    "localhost",
                    std::net::SocketAddr::new(ip, port.0.parse().unwrap()),
                )
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap();
            let send = || {
                remote
                    .post(format!("{origin}/api/m/web/read"))
                    .header("origin", &origin)
                    .header("cookie", &other)
                    .json(&json!({"urls": ["https://10.0.0.5/"]}))
                    .send()
                    .unwrap_or_else(|e| panic!("network address read: {e}"))
            };
            // Sharing is off by default and the server binds this computer only, so
            // another device cannot open a connection until the administrator turns
            // sharing on through the real settings route.
            let off = remote
                .post(format!("{origin}/api/m/web/read"))
                .header("origin", &origin)
                .header("cookie", &other)
                .json(&json!({"urls": ["https://10.0.0.5/"]}))
                .send();
            assert!(
                off.is_err() || off.is_ok_and(|r| r.status().as_u16() == 403),
                "sharing is off"
            );
            let turned_on = client
                .put(format!("{origin}/api/network"))
                .header("origin", &origin)
                .header("cookie", &cookie)
                .json(&json!({"sharing": true}))
                .send()
                .unwrap();
            assert_eq!(turned_on.status().as_u16(), 200);
            let response = send();
            assert_eq!(response.status().as_u16(), 200);
            let body = json_of(&response.text().unwrap_or_default());
            assert_eq!(body["trace"]["documents"][0]["reason"], "blocked", "{body}");
            println!("reached through the machine's network address (not loopback): yes");
        }
        _ => println!("no network address found, so the other-device check did not run"),
    }
    // The marker was sent inside a refused address above, so the log and every table must not hold
    // it. Planting it in a person's name shows the scan would catch a leak.
    let text = log();
    assert!(!text.contains(MARK), "marker reached the server log");
    let scan = || {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db.query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('app','moss_queue','moss_modules')", &[]).await.unwrap();
            for table in tables {
                let name: String = table.get(0);
                let count: i64 = db.query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE '%'||$1||'%'"), &[&MARK]).await.unwrap().get(0);
                assert_eq!(count, 0, "the planted text reached {name}");
            }
        })
    };
    let set_name = |name: &str| {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            db.execute(
                "UPDATE app.users SET name=$1 WHERE email='web-other@example.test'",
                &[&name],
            )
            .await
            .unwrap();
        })
    };
    set_name(MARK);
    let leak = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&scan));
    set_name("Web other");
    assert!(leak.is_err(), "the scan must catch a planted leak");
    println!("privacy scan FAILED with a leak planted");
    scan();
    println!("privacy scan PASSED with no leak");
    println!(
        "web research live: status for two people over HTTPS, 401 signed out, 400 undeclared route"
    );
}
