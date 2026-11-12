//! Installed Meetings package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Meetings live gate"]
fn installed_meetings_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js235-meetings-{}", std::process::id())])
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
        "<!doctype html><title>Meetings HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-meetings-signing-secret-235","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-meetings-password-235-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("meetings-owner@example.test", "Meetings owner");
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
                "SELECT id FROM app.users WHERE email='meetings-owner@example.test'",
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
    let access = AccessContext::new(owner, "meetings-install");
    // Publish the Meetings package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_MEETINGS_PACKAGE", "meetings")]
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
            publisher_key: "meetings-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Meetings live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "meetings-test-registry".into(),
        name: "Meetings test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "meetings-test".into(),
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
            "meetings-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Meetings other', 'meetings-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"meetings-other@example.test","password":"temporary-meetings-password-235-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/meetings{path}")).header("origin", &origin);
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
    const K1: &str = "11111111-1111-4111-8111-111111111111";
    const K2: &str = "22222222-2222-4222-8222-222222222222";
    const K3: &str = "33333333-3333-4333-8333-333333333333";
    assert_eq!(call(Method::GET, "/records", None, None).0, 401);
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/records", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!((status, json_of(&text)), (200, json!({"meetings":[]})), "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/records", Some(&cookie), Some(json!({"requestKey":K1,"title":format!("Weekly {MARK}")})));
    assert_eq!(status, 201, "{text}\n{}", log());
    let id = json_of(&text)["meeting"]["id"].as_str().unwrap().to_owned();
    let (status, _) = call(Method::POST, "/records", Some(&cookie), Some(json!({"requestKey":K1,"title":format!("Weekly {MARK}")})));
    assert_eq!(status, 200, "a repeated key returns the original");
    let notes = |key: &str, rev: i64, text: &str, who: &str| call(Method::PUT, &format!("/records/{id}/notes"), Some(who), Some(json!({"requestKey":key,"expectedRevision":rev,"personalNotes":text})));
    let (status, text) = notes(K1, 0, &format!("agenda {MARK}"), &cookie);
    assert_eq!(status, 200, "{text}");
    let (status, text) = notes(K2, 0, "stale edit", &cookie);
    assert_eq!((status, json_of(&text)["code"].clone()), (409, json!("meeting_notes_conflict")), "{text}");
    assert!(json_of(&text)["meeting"]["personalNotes"].as_str().is_some_and(|n| n.contains("agenda")), "the stale answer carries the current notes: {text}");
    let (status, text) = call(Method::PUT, &format!("/records/{id}/title"), Some(&cookie), Some(json!({"title":"Renamed","expectedTitle":format!("Weekly {MARK}")})));
    assert_eq!((status, json_of(&text)["status"].clone()), (200, json!("saved")), "{text}");
    let (status, text) = call(Method::GET, &format!("/records/{id}"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert!(json_of(&text)["meeting"]["personalNotes"].as_str().unwrap().contains("agenda"));
    // Preferences through the real server.
    let (status, text) = call(Method::PUT, "/preferences", Some(&cookie), Some(json!({"summarizeOnStop":false})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, text) = call(Method::GET, "/preferences", Some(&cookie), None);
    assert_eq!(json_of(&text)["summarizeOnStop"], false, "{text}");
    // Transcript and History through the real server.
    let save = json!({"requestKey":K1,"expectedVersion":0,
        "sources":[{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],
        "events":[{"cursor":1,"segment":{"meetingId":id,"segmentId":"s1","sourceId":"mic","epoch":1,"startMs":10,"endMs":19,
            "revision":1,"text":format!("spoken {MARK}"),"finality":"final","provenance":"transcription","speakerId":null}}],
        "stopCutoffMs":null});
    let (status, text) = call(Method::POST, &format!("/records/{id}/transcript"), Some(&cookie), Some(save));
    assert_eq!((status, json_of(&text)["status"].clone()), (201, json!("saved")), "{text}");
    let (status, text) = call(Method::GET, &format!("/records/{id}/transcript?maxSegments=500&maxCharacters=100000"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("spoken"), "the saved line reads back: {text}");
    let (status, text) = call(Method::POST, "/history/search", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["meetings"][0]["transcript"]["status"], "retained", "{text}");
    let (status, text) = call(Method::GET, &format!("/records/{id}/transcript?maxSegments=500&maxCharacters=100000"), Some(&other), None);
    assert!(status == 404 && !text.contains("spoken"), "another person gets no transcript: {status} {text}");
    let (_, text) = call(Method::POST, "/history/search", Some(&other), Some(json!({})));
    assert_eq!(json_of(&text)["meetings"], json!([]), "{text}");
    // A second person sees nothing of the first.
    let (status, text) = call(Method::GET, "/records", Some(&other), None);
    assert_eq!((status, json_of(&text)), (200, json!({"meetings":[]})), "{text}");
    assert_eq!(call(Method::GET, &format!("/records/{id}"), Some(&other), None).0, 404);
    assert_eq!(notes(K3, 1, "intruder", &other).0, 404);
    let missing = call(Method::DELETE, "/records/99999999-9999-4999-8999-999999999999", Some(&other), None).0;
    assert_eq!(call(Method::DELETE, &format!("/records/{id}"), Some(&other), None).0, missing);
    let (_, text) = call(Method::GET, "/preferences", Some(&other), None);
    assert_eq!(json_of(&text)["summarizeOnStop"], true, "{text}");
    let (status, text) = call(Method::GET, &format!("/records/{id}"), Some(&cookie), None);
    assert_eq!(status, 200, "the other person's delete changed nothing: {text}");
    // Owner delete, then gone.
    assert_eq!(call(Method::DELETE, &format!("/records/{id}"), Some(&cookie), None).0, 204);
    assert_eq!(call(Method::GET, &format!("/records/{id}"), Some(&cookie), None).0, 404);
    // Titles and notes stay out of the server log.
    assert!(!log().contains(MARK), "meeting text in the server log");
}
