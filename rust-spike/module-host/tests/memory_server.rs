//! Installed Memory package served by the real HTTPS executable. Not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
use common::Keys;
use moss_module_host::{
    archive::Package,
    registry::{Artifact, Channel, Index, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use std::collections::{BTreeMap, BTreeSet};
use access_context::AccessContext;
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
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

static SEEN_AUTHORIZATION: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
static EMBEDDING_FAILS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Local stand-in embedding endpoint. Hashes words into a 768-slot unit vector and records
/// the Authorization header it receives. Fails with 500 while `EMBEDDING_FAILS` is set.
fn embedding_stub(port: &str) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                let body = loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    if let Some(at) = text.find("\r\n\r\n") {
                        let length = text[..at]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if data.len() >= at + 4 + length {
                            break data[at + 4..at + 4 + length].to_vec();
                        }
                    }
                };
                let head = String::from_utf8_lossy(&data).to_string();
                for line in head.lines() {
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        SEEN_AUTHORIZATION.lock().unwrap().push(line["authorization:".len()..].trim().to_owned());
                    }
                }
                if EMBEDDING_FAILS.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = write!(stream, "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                    return;
                }
                let input: Value = serde_json::from_slice(&body).unwrap();
                let mut vector = vec![0f64; 768];
                for word in input["input"].as_str().unwrap_or_default().to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
                    let slot = word.bytes().fold(7usize, |h, b| h * 31 + b as usize) % 768;
                    vector[slot] += 1.0;
                }
                let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt().max(1.0);
                let vector: Vec<f64> = vector.iter().map(|v| v / norm).collect();
                let reply = json!({"data":[{"embedding":vector}]}).to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", reply.len(), reply);
            });
        }
    });
}
#[test]
#[ignore = "Only through verify-gate and the Memory live gate"]
fn installed_memory_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js231-memory-{}", std::process::id())])
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
        "<!doctype html><title>Memory HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-memory-signing-secret-231","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-memory-password-231-not-a-real-secret"})).send().unwrap();
        let status = response.status();
        if status != 200 {
            panic!("sign-up answered {status}: {}", response.text().unwrap_or_default());
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
    let cookie = signup("memory-owner@example.test", "Memory owner");
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
                "SELECT id FROM app.users WHERE email='memory-owner@example.test'",
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
    let access = AccessContext::new(owner, "memory-install");
    // Publish the Memory package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS231_MEMORY_PACKAGE", "memory")]
    .iter()
    .map(|(variable, id)| {
        let bytes = fs::read(std::env::var(variable).unwrap()).unwrap();
        let digest = trust::digest(&bytes);
        let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
        let manifest = &package.manifest;
        assert_eq!(manifest.id, *id);
        fs::write(root.join(format!("registry/packages/{digest}.mosspkg")), &bytes).unwrap();
        Artifact {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            digest: digest.clone(),
            size: bytes.len() as u64,
            publisher_key: "memory-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Memory live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "memory-test-registry".into(),
        name: "Memory test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "memory-test".into(),
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
        ("registry.json", serde_json::to_vec(&identity).unwrap(), &keys.root),
        ("index.json", serde_json::to_vec(&index).unwrap(), &keys.index),
    ] {
        fs::write(root.join("registry").join(name), &data).unwrap();
        fs::write(root.join("registry").join(format!("{name}.sig")), Keys::sign(key, &data)).unwrap();
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
            "memory-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    let embedding_port = Port(
        String::from_utf8(Command::new("devports").args(["claim", &format!("js231-embed-{}", std::process::id())]).output().unwrap().stdout).unwrap().trim().into(),
    );
    assert!(!embedding_port.0.is_empty());
    embedding_stub(&embedding_port.0);
    let embedding_url = format!("http://127.0.0.1:{}/v1/embeddings", embedding_port.0);
    let key = "temporary-disposable-embedding-key-231";
    // JS238_ON_DEVICE=1 leaves the endpoint out, so the model must run inside the server.
    let on_device = std::env::var("JS238_ON_DEVICE").as_deref() == Ok("1");
    let mut modules = json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"embeddings":{"url":embedding_url,"model":"bag-of-words-768","api_key":key}});
    if on_device {
        modules.as_object_mut().unwrap().remove("embeddings");
    }
    private(&root.join("modules.json"), &modules);
    let _server = start(true);
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/memory{path}")).header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{path} -> {status}");
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    if on_device {
        on_device_proof(&call, &json_of, &cookie, &log, &root);
        return;
    }
    assert_eq!(call(Method::GET, "/graph/core", None, None).0, 401);
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/graph/core", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!((status, json_of(&text)), (200, json!({"query":"","items":[]})), "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/graph/entities", Some(&cookie), Some(json!({"kind":"self","name":"Me"})));
    assert_eq!(status, 200, "{text}");
    let me = json_of(&text)["entity"]["id"].as_str().unwrap().to_owned();
    let fact = json!({"subjectEntityId":me,"predicate":"prefers","objectText":"oolong tea in the afternoon","source":{"sourceKind":"manual","sourceRef":"live-1","excerpt":"I like oolong tea"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(&cookie), Some(fact));
    assert_eq!(status, 200, "{text}\n{}", log());
    let saved = json_of(&text);
    assert!(saved["fact"]["id"].is_string() && saved.get("searchPending").is_none(), "{text}");
    let (status, text) = call(Method::GET, "/graph/recall?q=oolong%20tea", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let recalled = json_of(&text);
    let items = recalled["items"].as_array().unwrap();
    assert!(items.iter().any(|i| i["text"].as_str().is_some_and(|t| t.contains("oolong")) && i["score"].as_f64().unwrap() > 0.0), "{text}");
    assert!(items.iter().all(|i| i.get("subjectName").is_none()), "{text}");
    // The stand-in saw the configured key, and the key never came back out.
    let seen = SEEN_AUTHORIZATION.lock().unwrap().clone();
    assert!(!seen.is_empty() && seen.iter().all(|v| *v == format!("Bearer {key}")), "{seen:?}");
    assert!(!text.contains(key) && !log().contains(key), "key leaked");
    // Bad input keeps the old error text.
    let (status, text) = call(Method::GET, "/graph/recall?q=%20", Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (400, json!({"error":"q is required"})), "{text}");
    let none = json!({"predicate":"prefers","source":{"sourceKind":"manual","sourceRef":"x","excerpt":"x"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(&cookie), Some(none));
    assert_eq!((status, json_of(&text)), (400, json!({"error":"memory fact requires exactly one object target"})), "{text}");
    // A failed embedding keeps the fact and flags it.
    EMBEDDING_FAILS.store(true, std::sync::atomic::Ordering::SeqCst);
    let fact = json!({"subjectEntityId":me,"predicate":"prefers","objectText":"quiet mornings with jasmine","source":{"sourceKind":"manual","sourceRef":"live-2","excerpt":"jasmine"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(&cookie), Some(fact));
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["searchPending"], true, "{text}");
    EMBEDDING_FAILS.store(false, std::sync::atomic::Ordering::SeqCst);
    let (_, text) = call(Method::GET, "/graph/recall?q=jasmine", Some(&cookie), None);
    assert!(json_of(&text)["items"].as_array().unwrap().iter().any(|i| i["text"].as_str().is_some_and(|t| t.contains("jasmine"))), "{text}");
    // Fact lifecycle through the real server: each route, then the old error answers.
    let id = saved["fact"]["id"].as_str().unwrap().to_owned();
    let fact_path = |tail: &str| format!("/graph/facts/{id}{tail}");
    let (status, _) = call(Method::POST, &fact_path("/pin"), Some(&cookie), Some(json!({"pinned":true})));
    assert_eq!(status, 204);
    let (status, text) = call(Method::POST, &fact_path("/confirm"), Some(&cookie), Some(json!({})));
    assert_eq!((status, json_of(&text)["fact"]["confidenceTier"].clone()), (200, json!("confirmed")), "{text}");
    let (status, text) = call(Method::POST, &fact_path("/mark-stale"), Some(&cookie), Some(json!({})));
    assert_eq!((status, json_of(&text)["fact"]["status"].clone()), (200, json!("stale")), "{text}");
    let (status, text) = call(Method::POST, &fact_path("/status"), Some(&cookie), Some(json!({"status":"active"})));
    assert_eq!((status, json_of(&text)["fact"]["status"].clone()), (200, json!("active")), "{text}");
    let (status, text) = call(Method::POST, &fact_path("/correct"), Some(&cookie), Some(json!({"replacementText":"matcha in the afternoon"})));
    assert_eq!((status, json_of(&text)["fact"]["objectText"].clone()), (200, json!("matcha in the afternoon")), "{text}");
    let corrected = json_of(&text)["fact"]["id"].as_str().unwrap().to_owned();
    assert_ne!(corrected, id, "a correction is a new fact");
    let (status, text) = call(Method::POST, &fact_path("/pin"), Some(&cookie), Some(json!({})));
    assert_eq!(status, 400, "{text}");
    let unknown = "/graph/facts/00000000-0000-4000-8000-0000000000ff";
    let (status, text) = call(Method::DELETE, unknown, Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (404, json!({"error":"Memory fact not found"})), "{text}");
    let (status, text) = call(Method::POST, &fact_path("/status"), Some(&cookie), Some(json!({"status":"active"})));
    assert_eq!((status, json_of(&text)), (400, json!({"error":"Cannot reactivate a superseded memory record; create a new fact instead"})), "{text}");
    let (status, _) = call(Method::POST, &format!("/graph/facts/{corrected}/supersede"), Some(&cookie), Some(json!({})));
    assert_eq!(status, 204);
    let (status, _) = call(Method::DELETE, &format!("/graph/facts/{corrected}"), Some(&cookie), None);
    assert_eq!(status, 204);
    let (status, _) = call(Method::DELETE, &format!("/graph/facts/{corrected}"), Some(&cookie), None);
    assert_eq!(status, 404);
    let (status, _) = call(Method::DELETE, &format!("/graph/facts/{corrected}"), None, None);
    assert_eq!(status, 401);
    // Memory text stays out of the server log.
    let log = log();
    assert!(!log.contains("oolong") && !log.contains("jasmine") && !log.contains("matcha"), "memory text in log");
}

/// Memory search on a server with no endpoint configured. The model downloads on first use,
/// progress is read from the settings route, and a search then finds a paraphrase.
fn on_device_proof(
    call: &dyn Fn(reqwest::Method, &str, Option<&str>, Option<Value>) -> (u16, String),
    json_of: &dyn Fn(&str) -> Value,
    cookie: &str,
    log: &dyn Fn() -> String,
    root: &Path,
) {
    use reqwest::Method;
    let started = Instant::now();
    let state = || {
        let (status, text) = call(Method::GET, "/embedding", Some(cookie), None);
        assert_eq!(status, 200, "{text}");
        json_of(&text)
    };
    let first = state();
    println!("settings before use: {first}");
    assert_eq!(first["provider"], "device", "{first}");
    assert!(first["message"].is_null(), "{first}");
    while call(Method::GET, "/graph/core", Some(cookie), None).0 == 503 {
        assert!(started.elapsed() < Duration::from_secs(60), "server did not start");
        std::thread::sleep(Duration::from_millis(500));
    }
    let (status, text) = call(Method::POST, "/graph/entities", Some(cookie), Some(json!({"kind":"self","name":"Me"})));
    assert_eq!(status, 200, "{text}");
    let me = json_of(&text)["entity"]["id"].as_str().unwrap().to_owned();
    // The first save happens while the model downloads. The fact is kept and flagged.
    let fact = json!({"subjectEntityId":me,"predicate":"prefers","objectText":"oolong tea in the afternoon","source":{"sourceKind":"manual","sourceRef":"live-1","excerpt":"I like oolong tea"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(cookie), Some(fact));
    assert_eq!(status, 200, "{text}\n{}", log());
    println!("first save while downloading: {text}");
    assert_eq!(json_of(&text)["searchPending"], true, "{text}");
    let mut last = String::new();
    loop {
        let now = state();
        let device = now["device"].clone();
        let line = device.to_string();
        if line != last {
            println!("model state after {}s: {line}", started.elapsed().as_secs());
            last = line;
        }
        match device["state"].as_str() {
            Some("ready") => break,
            Some("failed") => panic!("model download failed: {device}"),
            _ => {}
        }
        assert!(started.elapsed() < Duration::from_secs(1500), "download took too long");
        std::thread::sleep(Duration::from_secs(2));
    }
    let fact = json!({"subjectEntityId":me,"predicate":"prefers","objectText":"jasmine green tea before bed","source":{"sourceKind":"manual","sourceRef":"live-2","excerpt":"jasmine"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(cookie), Some(fact));
    assert_eq!(status, 200, "{text}");
    assert!(json_of(&text).get("searchPending").is_none(), "{text}");
    let other = json!({"subjectEntityId":me,"predicate":"owns","objectText":"a red bicycle with a broken chain","source":{"sourceKind":"manual","sourceRef":"live-3","excerpt":"bike"}});
    let (status, text) = call(Method::POST, "/graph/facts", Some(cookie), Some(other));
    assert_eq!(status, 200, "{text}");
    // No words are shared with the stored text, so only meaning can find it.
    let (status, text) = call(Method::GET, "/graph/recall?q=what%20hot%20drink%20do%20I%20like%20at%20night", Some(cookie), None);
    assert_eq!(status, 200, "{text}");
    let items = json_of(&text)["items"].as_array().unwrap().clone();
    println!("recall by meaning: {}", items.iter().map(|i| i["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join(" | "));
    assert!(items.first().is_some_and(|i| i["text"].as_str().is_some_and(|t| t.contains("jasmine"))), "{text}");
    let log = log();
    assert!(!log.contains("oolong") && !log.contains("jasmine") && !log.contains("bicycle"), "memory text in log");
    let _ = root;
}
