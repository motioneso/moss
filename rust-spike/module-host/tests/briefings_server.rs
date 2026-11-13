//! Installed Briefings package served by the real HTTPS executable. Not a native UI proof.
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

#[test]
#[ignore = "Only through verify-gate and the Briefings live gate"]
fn installed_briefings_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js263-briefings-{}", std::process::id())])
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
        "<!doctype html><title>Briefings HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-briefings-signing-secret-263","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-briefings-password-263-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("briefings-owner@example.test", "Briefings owner");
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
                "SELECT id FROM app.users WHERE email='briefings-owner@example.test'",
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
    let access = AccessContext::new(owner, "briefings-install");
    // Publish the Briefings package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_BRIEFINGS_PACKAGE", "briefings")]
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
            publisher_key: "briefings-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Briefings live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "briefings-test-registry".into(),
        name: "Briefings test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "briefings-test".into(),
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
            "briefings-test-registry",
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
    // The model the owner configures is a small server in this process behind the real router.
    let requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    {
        let requests = requests.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Read, Write};
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0usize;
                let mut line = String::new();
                reader.read_line(&mut line).unwrap_or(0);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = header.to_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                requests.lock().unwrap().push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                let answer = json!({"choices":[{"message":{"content":"Steady morning.\n\n## Prepare\nBring notes at 9 AM. WRITTEN-BY-STANDIN-MODEL"}}]}).to_string();
                let mut stream = stream;
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
            }
        });
    }
    let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
        .unwrap()
        .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new("TEST-NOT-A-REAL-KEY-267")));
    let (provider, model) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        db.execute("INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Test provider',$3,$4,true)", &[&provider, &owner, &format!("http://127.0.0.1:{provider_port}"), &sealed]).await.unwrap();
        db.execute("INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'test-model-267','Test model',ARRAY['chat','json'])", &[&model, &provider, &owner]).await.unwrap();
    });
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Briefings other', 'briefings-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"briefings-other@example.test","password":"temporary-briefings-password-263-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/briefings{path}")).header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{method_path} -> {status}", method_path = path);
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    const MARK: &str = "PLANTED-LIVE-MARKER-7d2e";
    assert_eq!(call(Method::GET, "/definitions", None, None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = std::time::Instant::now();
    while call(Method::GET, "/definitions", Some(&cookie), None).0 == 503 && started.elapsed() < std::time::Duration::from_secs(60) {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/definitions", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text)["definitions"], json!([]));
    }
    // The owner saves a daily briefing, and it is registered to run at 7:00.
    let (status, text) = call(Method::POST, "/definitions", Some(&cookie), Some(json!({"title": format!("Plan {MARK}"), "briefingType": "morning", "cadence": "daily"})));
    assert_eq!(status, 201, "{text}\n{}", log());
    let id = json_of(&text)["definition"]["id"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::POST, "/definitions", Some(&cookie), Some(json!({"title": "  "})));
    assert_eq!((status, json_of(&text)["error"].clone()), (400, json!("title must not be empty")), "{text}");
    // A run of the owner's exists.
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let definition: uuid::Uuid = id.parse().unwrap();
        db.execute(
            "INSERT INTO app.briefing_runs(id,definition_id,owner_user_id,status,run_kind,briefing_type,summary_text,source_metadata) VALUES(gen_random_uuid(),$1,$2,'succeeded','manual','morning',$3,'{\"aiModel\":{\"provider\":\"p\",\"model\":\"m\"}}'::jsonb)",
            &[&definition, &owner, &format!("Briefing {MARK}")],
        ).await.unwrap();
    });
    let (status, text) = call(Method::GET, &format!("/definitions/{id}/runs"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let run_id = json_of(&text)["runs"][0]["id"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::GET, &format!("/definitions/{id}/runs/{run_id}"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)["state"].clone()), (200, json!("ready")), "{text}");
    // The other person sees none of it and cannot change it.
    let (_, text) = call(Method::GET, "/definitions", Some(&other), None);
    assert_eq!(json_of(&text)["definitions"], json!([]));
    assert_eq!(call(Method::PATCH, &format!("/definitions/{id}"), Some(&other), Some(json!({"title": "intruder"}))).0, 404);
    assert_eq!(call(Method::GET, &format!("/definitions/{id}/runs"), Some(&other), None).0, 404);
    assert_eq!(call(Method::GET, &format!("/definitions/{id}/runs/{run_id}"), Some(&other), None).0, 404);
    // The owner switching it to manual removes the schedule and leaves the data.
    let (status, text) = call(Method::PATCH, &format!("/definitions/{id}"), Some(&cookie), Some(json!({"cadence": "manual"})));
    assert_eq!((status, json_of(&text)["definition"]["cadence"].clone()), (200, json!("manual")), "{text}");
    // A manual run queues, finishes through the real worker and reads back as ready. The other
    // person can neither queue it nor read its status.
    let (status, text) = call(Method::POST, &format!("/definitions/{id}/run"), Some(&other), Some(json!({})));
    assert_eq!(status, 404, "{text}");
    let (status, text) = call(Method::POST, &format!("/definitions/{id}/run"), Some(&cookie), Some(json!({})));
    assert_eq!(status, 202, "{text}\n{}", log());
    let queued = json_of(&text);
    let (job, fresh) = (queued["jobId"].as_str().unwrap().to_owned(), queued["runId"].as_str().unwrap().to_owned());
    let status_path = format!("/definitions/{id}/runs/{fresh}?jobId={job}");
    assert_eq!(call(Method::GET, &status_path, Some(&other), None).0, 404);
    let waited = std::time::Instant::now();
    let finished = loop {
        let (status, text) = call(Method::GET, &status_path, Some(&cookie), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let state = json_of(&text)["state"].as_str().unwrap_or_default().to_owned();
        if state != "pending" || waited.elapsed() > std::time::Duration::from_secs(90) {
            break (state, text);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    };
    println!("live manual run finished as {} after {:?}", finished.0, waited.elapsed());
    assert_eq!(finished.0, "ready", "{}\n{}", finished.1, log());
    // Gathering ran for the owner: the run records which sources it could not read, and no text.
    let (status, text) = call(Method::GET, &format!("/definitions/{id}/runs/{fresh}"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let detail = json_of(&text);
    println!("live run source metadata: {}", detail["run"]["sourceMetadata"]);
    assert!(detail["run"]["sourceMetadata"]["sourcesFromCache"].is_boolean() || detail["run"]["sourceMetadata"]["gaps"].is_array(), "{text}");
    assert!(!text.contains(MARK));
    // The text came from the configured model through the real router, and the model got the
    // trusted block first. The owner's definition title was never sent to it.
    let written = detail["run"]["summaryText"].as_str().unwrap_or_default();
    assert!(written.contains("WRITTEN-BY-STANDIN-MODEL"), "{text}\n{}", log());
    assert_eq!(detail["run"]["sourceMetadata"]["aiModel"]["id"], "router", "{text}");
    let sent = requests.lock().unwrap().clone();
    assert!(!sent.is_empty(), "the router never reached the model");
    let prompt = sent[0]["messages"][0]["content"].as_str().unwrap_or_default();
    assert!(prompt.starts_with("<trusted_instructions>"), "{prompt}");
    assert!(!prompt.contains(MARK));
    println!("live model run: the router sent {} request(s); the stored text came from the model", sent.len());
    let other_view = call(Method::GET, &format!("/definitions/{id}/runs/{fresh}"), Some(&other), None);
    assert_eq!(other_view.0, 404);
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("briefings live: definitions, runs and privacy for two people worked over HTTPS");
}
