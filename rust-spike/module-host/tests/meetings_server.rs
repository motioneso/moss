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

/// Link the ring through the same HTTPS approval flow as the Android app.
fn pair_android_device(client: &reqwest::blocking::Client, origin: &str, cookie: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    let verifier = uuid::Uuid::new_v4().to_string();
    let response = client.post(format!("{origin}/api/companion/pair"))
        .header("origin", origin)
        .json(&json!({"deviceName":"Meetings live ring","platform":"android","appVersion":"1","osVersion":"14",
            "verifierHash":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))}))
        .send().unwrap();
    assert_eq!(response.status(), 200, "create Android pairing attempt");
    let attempt: Value = response.json().unwrap();
    let code = attempt["approvalPath"].as_str().unwrap().strip_prefix("/link/trail-marker#code=").unwrap();
    let response = client.post(format!("{origin}/api/companion/pair/decide"))
        .header("origin", origin).header("cookie", cookie)
        .json(&json!({"code":code,"decision":"approve"})).send().unwrap();
    assert_eq!(response.status(), 200, "approve Android pairing as the owner");
    let response = client.post(format!("{origin}/api/companion/pair/redeem"))
        .header("origin", origin)
        .json(&json!({"attemptId":attempt["attemptId"],"verifier":verifier})).send().unwrap();
    assert_eq!(response.status(), 200, "redeem Android pairing");
    let issued: Value = response.json().unwrap();
    assert_eq!(issued["status"], "issued");
    let device = issued["device"]["id"].as_str().unwrap();
    uuid::Uuid::parse_str(device).expect("paired device UUID");
    println!("Android paired through create/approve/redeem -> 200");
    device.to_owned()
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
    let artifacts: Vec<Artifact> = [
        ("JS235_CALENDAR_STAND_IN", "calendar"),
        ("JS235_PEOPLE_STAND_IN", "people"),
        ("JS235_TASKS_STAND_IN", "tasks"),
        ("JS235_NOTES_STAND_IN", "notes"),
        ("JS231_MEMORY_PACKAGE", "memory"),
        ("JS235_MEETINGS_PACKAGE", "meetings"),
    ]
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
        publish_reviews: Default::default(),
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
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":"cd".repeat(32)}),
    );
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        assert!(!db.query_one("SELECT to_regclass('app.companion_devices_owner') IS NOT NULL", &[]).await.unwrap().get::<_,bool>(0), "registry installation must not accidentally supply the lookup");
    });
    let _server = start(true);
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        assert!(db.query_one("SELECT to_regclass('app.companion_devices_owner') IS NOT NULL", &[]).await.unwrap().get::<_,bool>(0), "server startup supplies the lookup after a registry install");
    });
    if std::env::var_os("MOSS_COMPANION_STARTUP_ONLY").is_some() {
        println!("registry install: startup supplies companion lookup without install-module");
        drop(_server);
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.batch_execute("DROP VIEW app.companion_devices_owner").await.unwrap();
        });
        // A valid runtime login cannot apply DDL. Failure must leave the server usable,
        // with linking closed until an elevated install or restart can prepare the lookup.
        let mut settings: Value = serde_json::from_slice(&fs::read(root.join("modules.json")).unwrap()).unwrap();
        settings["migrations_url"] = json!(app_url);
        fs::write(root.join("modules.json"), settings.to_string()).unwrap();
        let _denied = start(true);
        assert_eq!(client.get(format!("{origin}/api/hello")).send().unwrap().status(), 200);
        let response = client.post(format!("{origin}/api/companion/pair"))
            .header("origin", &origin)
            .json(&json!({"deviceName":"Unprepared Mac","platform":"macos","appVersion":"1","osVersion":"14","verifierHash":"a".repeat(43)}))
            .send().unwrap();
        assert_eq!(response.status(), 503, "linking must fail closed without lookup preparation");
        println!("unavailable startup DDL: HTTPS stays healthy and linking returns 503");
        return;
    }
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
    // Recording types, recording identity and pasted transcripts through the real server.
    let kind = format!("private-{}", MARK.to_lowercase());
    let types: Vec<Value> = ["work-meeting", "appointment", "brain-dump", "conversation", "idea", "other"]
        .iter()
        .map(|t| json!({"id": t, "name": t, "description": "d", "templateId": "general", "retired": false}))
        .chain([json!({"id": kind, "name": kind, "description": MARK, "templateId": "general", "retired": false})])
        .collect();
    let (status, text) = call(Method::PUT, "/recording-types", Some(&cookie), Some(json!({"expectedRevision":0,"types":types})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::GET, "/recording-types", Some(&other), None);
    assert!(!text.contains(MARK), "another person sees no recording types: {status} {text}");
    let (status, text) = call(Method::POST, "/manual-transcripts", Some(&cookie), Some(json!({"requestKey":K2,"transcript":format!("budget {MARK} review"),"typeId":kind})));
    assert_eq!(status, 201, "{text}\n{}", log());
    let pasted = json_of(&text)["meetingId"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::POST, "/manual-transcripts", Some(&cookie), Some(json!({"requestKey":K2,"transcript":format!("budget {MARK} review"),"typeId":kind})));
    assert_eq!(status, 200, "a repeated key returns the first answer: {text}");
    let (status, text) = call(Method::GET, &format!("/records/{pasted}/recording"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let (status, text) = call(Method::GET, &format!("/records/{pasted}/transcript?maxSegments=10&maxCharacters=1000"), Some(&cookie), None);
    assert!(status == 200 && text.contains(MARK), "the pasted text reads back: {status} {text}");
    for (m, path, body) in [
        (Method::GET, format!("/records/{pasted}/recording"), None),
        (Method::PUT, format!("/records/{pasted}/recording/type"), Some(json!({"expectedRevision":0,"typeId":"idea"}))),
        (Method::GET, format!("/records/{pasted}/transcript?maxSegments=10&maxCharacters=1000"), None),
    ] {
        let (status, text) = call(m, &path, Some(&other), body);
        assert!(status == 404 && !text.contains(MARK), "another person gets 404: {path} {status} {text}");
    }
    // MOSS_MEETINGS_HOLD names a folder. The test then keeps the server up for a browser check,
    // writes the address to url.txt, and waits for a file named finished in that folder.
    if let Ok(hold) = std::env::var("MOSS_MEETINGS_HOLD") {
        fs::write(Path::new(&hold).join("url.txt"), &origin).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3600);
        while !Path::new(&hold).join("finished").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    // Summaries through the real server. No model is configured here, so a request ends as a stored
    // failure and never as a server error.
    let (status, text) = call(Method::GET, &format!("/records/{pasted}/outputs"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let listing = json_of(&text);
    assert_eq!(listing["artifacts"], json!([]), "{text}");
    // The real worker may already have tried. With no model set up the attempt is a stored failure.
    let planned = &listing["automaticSummary"];
    assert!(
        planned["status"] == "waiting" || (planned["status"] == "failed" && planned["code"] == "meeting_output_provider_failed"),
        "a pasted transcript plans a summary: {text}"
    );
    let (status, text) = call(Method::GET, &format!("/records/{pasted}/transcript?maxSegments=10&maxCharacters=1000"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let transcript_revision = json_of(&text)["transcriptRevision"].as_i64().unwrap_or(1);
    let generate = json!({"requestKey":K3,"expectedOutputVersion":0,"expectedTranscriptRevision":transcript_revision,
        "expectedNotesRevision":0,"templateId":"general","templateVersion":1});
    let (status, text) = call(Method::POST, &format!("/records/{pasted}/outputs"), Some(&cookie), Some(generate.clone()));
    assert!(status < 500 && !text.contains(MARK), "a generate request ends cleanly: {status} {text}\n{}", log());
    for (m, path, body) in [
        (Method::GET, format!("/records/{pasted}/outputs"), None),
        (Method::GET, format!("/records/{pasted}/outputs/1"), None),
        (Method::POST, format!("/records/{pasted}/outputs"), Some(generate)),
        (Method::PUT, format!("/records/{pasted}/outputs"), Some(json!({"requestKey":K1,"expectedOutputVersion":1,"content":{}}))),
    ] {
        let (status, text) = call(m, &path, Some(&other), body);
        assert!(status == 404 && !text.contains(MARK), "another person gets 404 on summaries: {path} {status} {text}");
    }
    // Private exports through the real server. No summary exists and Notes is not installed here,
    // so the owner sees an empty list and a clean refusal, and another person sees nothing.
    let (status, text) = call(Method::GET, &format!("/records/{pasted}/exports"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)["receipts"].clone()), (200, json!([])), "{text}\n{}", log());
    let export = json!({"requestKey":K3,"artifactVersion":1});
    let (status, text) = call(Method::POST, &format!("/records/{pasted}/exports"), Some(&cookie), Some(export.clone()));
    assert_eq!((status, json_of(&text)["code"].clone()), (404, json!("meeting_output_unavailable")), "{text}\n{}", log());
    for (m, body) in [(Method::GET, None), (Method::POST, Some(export))] {
        let (status, text) = call(m, &format!("/records/{pasted}/exports"), Some(&other), body);
        assert!(status == 404 && !text.contains(MARK), "another person gets 404 on exports: {status} {text}");
    }
    let (status, text) = call(Method::GET, "/output-availability", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    // Ring upload through the real server: reserve, send in 1 MiB pieces over HTTPS with an
    // interruption, finalize, then a second person sees nothing. No speech model is set up here,
    // so the transcription job is not expected to finish.
    {
        use sha2::{Digest, Sha256};
        let digest = |b: &[u8]| Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>();
        let ms = 40_000usize;
        let body = ms * 32;
        let mut wav = Vec::with_capacity(44 + body);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + body) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        for v in [16u32.to_le_bytes().as_slice(), &1u16.to_le_bytes(), &1u16.to_le_bytes(), &16000u32.to_le_bytes(), &32000u32.to_le_bytes(), &2u16.to_le_bytes(), &16u16.to_le_bytes()] {
            wav.extend_from_slice(v);
        }
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(body as u32).to_le_bytes());
        wav.resize(44 + body, 0);
        let packets = vec![0u8, 3, 1, 2, 3, 1, 2, 4, 5];
        let sidecar = format!("{{\"record\":[\"1700000000\",\"start\"]}},{{\"btn\":[\"1700000001\",\"1\"]}},{{\"record\":[\"1700000040\",\"end\"]}},{{\"duration\":[\"1700000040\",\"{ms}\"]}}").into_bytes();
        let file = |b: &[u8]| json!({"byteLength": b.len(), "sha256": digest(b)});
        let device = pair_android_device(&client, &origin, &cookie);
        let recording = format!("1700000000_ring-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let manifest = json!({"version":3,"sourceDeviceId":device,"recordingId":recording,"destination":{"intent":"meeting"},
            "packets":file(&packets),"sidecar":file(&sidecar),"wav":file(&wav)});
        let mut unpaired = manifest.clone();
        unpaired["sourceDeviceId"] = json!(uuid::Uuid::new_v4().to_string());
        let (status, text) = call(Method::POST, "/recording-uploads", Some(&cookie), Some(unpaired));
        assert_eq!(status, 403, "an unpaired device may not upload: {text}");
        assert_eq!(json_of(&text)["error"], "This device may not upload recordings");
        println!("unpaired Android source device -> 403");
        let (status, text) = call(Method::POST, "/recording-uploads", Some(&cookie), Some(manifest.clone()));
        assert_eq!(status, 201, "{text}\n{}", log());
        let reserved = json_of(&text);
        let upload = reserved["body"]["id"].as_str().or(reserved["id"].as_str()).unwrap_or_else(|| panic!("{text}")).to_owned();
        let piece = |who: &str, kind: &str, index: usize, bytes: Vec<u8>| {
            let r = client.put(format!("{origin}/api/m/meetings/recording-uploads/{upload}/{kind}/{index}"))
                .header("origin", &origin).header("cookie", who).header("content-type", "application/octet-stream")
                .body(bytes).send().unwrap_or_else(|e| panic!("chunk {kind} {index}: {e}\n{}", log()));
            let status = r.status().as_u16();
            println!("chunk {kind} {index} -> {status}");
            (status, r.text().unwrap_or_default())
        };
        let chunk = 1024 * 1024;
        assert_eq!(piece(&cookie, "wav", 0, wav[..chunk].to_vec()).0, 200, "{}", log());
        let (status, text) = call(Method::POST, &format!("/recording-uploads/{upload}/finalize"), Some(&cookie), Some(json!(null)));
        assert!((400..500).contains(&status), "finalize on an incomplete upload: {status} {text}");
        assert_eq!(piece(&cookie, "wav", 0, wav[..chunk].to_vec()).0, 200, "an identical resend is accepted");
        let mut changed = wav[..chunk].to_vec();
        changed[100] ^= 1;
        assert_eq!(piece(&cookie, "wav", 0, changed).0, 409, "different bytes for a sent piece conflict");
        assert_eq!(piece(&cookie, "wav", 1, wav[chunk..].to_vec()).0, 200);
        assert_eq!(piece(&cookie, "packets", 0, packets.clone()).0, 200);
        assert_eq!(piece(&cookie, "sidecar", 0, sidecar.clone()).0, 200);
        assert_eq!(piece(&other, "wav", 0, wav[..chunk].to_vec()).0, 404, "another person's piece");
        assert_eq!(call(Method::GET, &format!("/recording-uploads/{upload}"), Some(&other), None).0, 404);
        assert_eq!(call(Method::POST, &format!("/recording-uploads/{upload}/finalize"), Some(&other), Some(json!(null))).0, 404);
        let (status, text) = call(Method::POST, &format!("/recording-uploads/{upload}/finalize"), Some(&cookie), Some(json!(null)));
        assert_eq!(status, 200, "{text}\n{}", log());
        let (status, text) = call(Method::GET, &format!("/recording-imports/{upload}"), Some(&cookie), None);
        assert_eq!(status, 200, "{text}");
        assert_eq!(call(Method::GET, &format!("/recording-imports/{upload}"), Some(&other), None).0, 404);
        let (status, text) = call(Method::POST, "/recording-uploads", Some(&cookie), Some(manifest));
        assert!(status == 200 || status == 201, "{status} {text}");
    }
    // Mac link through the real server. The real host does not yet vouch for browser sessions or
    // Mac credentials (device pairing is parked), so every capture route refuses with a code only,
    // for the owner and for another person alike, and a caller with no session never reaches it.
    let start = json!({"requestKey": K1});
    for (who, name) in [(&cookie, "owner"), (&other, "other")] {
        let (status, text) = call(Method::GET, "/capture/devices", Some(who), None);
        assert_eq!((status, json_of(&text)["code"].clone()), (401, json!("meeting_capture_unavailable")), "{name} {text}");
        let (status, text) = call(Method::POST, &format!("/records/{pasted}/capture/start"), Some(who), Some(start.clone()));
        assert_eq!((status, json_of(&text)["code"].clone()), (401, json!("meeting_capture_unavailable")), "{name} {text}");
        assert!(!text.contains(MARK), "meeting text in a capture refusal");
    }
    let (status, _) = call(Method::POST, "/capture/commands", None, Some(json!({"connectionId": K1, "verifier": "x"})));
    assert_eq!(status, 401);
    assert_eq!(call(Method::DELETE, &format!("/records/{id}"), Some(&cookie), None).0, 204);
    assert_eq!(call(Method::GET, &format!("/records/{id}"), Some(&cookie), None).0, 404);
    // Titles and notes stay out of the server log.
    assert!(!log().contains(MARK), "meeting text in the server log");
    // A real summary. The router is pointed at the box's local model proxy on the cheapest model it
    // lists. The key is read from its file and never printed. Without the file the proof is
    // reported as not run, never as passed.
    let key_file = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/cliproxyapi/client-key");
    let proxy_port = fs::read_to_string(key_file.with_file_name("port")).unwrap_or_default();
    let model_key = fs::read_to_string(&key_file).map(|k| k.trim().to_owned()).ok().filter(|k| !k.is_empty());
    let (Some(model_key), false) = (model_key, proxy_port.trim().is_empty()) else {
        println!("NOT RUN live model: no local model proxy key on this box");
        return;
    };
    let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), "cd".repeat(32))].into())
        .unwrap()
        .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new(&model_key)));
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let (provider, model) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        db.execute(
            "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Local proxy',$3,$4,true)",
            &[&provider, &owner, &format!("http://127.0.0.1:{}", proxy_port.trim()), &sealed],
        ).await.unwrap();
        db.execute(
            "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'gpt-5.6-luna','Small model',ARRAY['chat','json','summarization'])",
            &[&model, &provider, &owner],
        ).await.unwrap();
    });
    let (_, text) = call(Method::GET, &format!("/records/{pasted}/transcript?maxSegments=10&maxCharacters=1000"), Some(&cookie), None);
    let revision = json_of(&text)["transcriptRevision"].as_i64().unwrap_or(1);
    let request = json!({"requestKey":"44444444-4444-4444-8444-444444444444","expectedOutputVersion":0,"expectedTranscriptRevision":revision,
        "expectedNotesRevision":0,"templateId":"general","templateVersion":1});
    let (status, text) = call(Method::POST, &format!("/records/{pasted}/outputs"), Some(&cookie), Some(request));
    assert!(status < 500, "a real generate request ends cleanly: {status} {text}\n{}", log());
    let waited = Instant::now();
    let artifact = loop {
        let (_, text) = call(Method::GET, &format!("/records/{pasted}/outputs"), Some(&cookie), None);
        let listing = json_of(&text);
        if let Some(first) = listing["artifacts"].as_array().and_then(|a| a.first()) {
            break first.clone();
        }
        assert!(waited.elapsed() < Duration::from_secs(180), "no summary arrived: {listing}\n{}", log());
        std::thread::sleep(Duration::from_secs(2));
    };
    assert!(!log().contains(&model_key), "the model key never reaches the server log");
    println!("PASS live model: gpt-5.6-luna wrote a real summary in {:?}: {}", waited.elapsed(), artifact.to_string().chars().take(300).collect::<String>());
    // MOSS_MEETINGS_MODEL_HOLD names a folder, as MOSS_MEETINGS_HOLD does, for a browser look at it.
    if let Ok(hold) = std::env::var("MOSS_MEETINGS_MODEL_HOLD") {
        fs::write(Path::new(&hold).join("url.txt"), &origin).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3600);
        while !Path::new(&hold).join("finished").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
