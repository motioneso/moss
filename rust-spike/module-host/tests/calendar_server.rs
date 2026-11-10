//! Installed Calendar package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Calendar server gate"]
fn installed_calendar_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js181-calendar-{}", std::process::id())])
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
        "<!doctype html><title>Calendar HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-calendar-signing-secret-181","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-calendar-password-181-not-a-real-secret"})).send().unwrap();
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("calendar-owner@example.test", "Calendar owner");
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
                "SELECT id FROM app.users WHERE email='calendar-owner@example.test'",
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
    let access = AccessContext::new(owner, "calendar-install");
    // Publish the Calendar package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let bytes = fs::read(std::env::var("JS181_CALENDAR_PACKAGE").unwrap()).unwrap();
    let digest = trust::digest(&bytes);
    let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
    let manifest = &package.manifest;
    assert_eq!(manifest.id, "calendar");
    let artifact = Artifact {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        digest: digest.clone(),
        size: bytes.len() as u64,
        publisher_key: "calendar-test".into(),
        signature: Keys::sign(&keys.publisher, digest.as_bytes()),
        requires_moss: manifest.requires_moss.clone(),
        abi: manifest.abi.clone(),
        capabilities: manifest.capabilities.clone(),
        migrations: manifest.database.migrations.clone(),
        requires: manifest.requires.clone(),
        changelog: "Calendar server gate".into(),
        channel: Channel::Stable,
        urgent: false,
    };
    fs::write(root.join(format!("registry/packages/{digest}.mosspkg")), &bytes).unwrap();
    let identity = RegistryIdentity {
        id: "calendar-test-registry".into(),
        name: "Calendar test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "calendar-test".into(),
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
        modules: vec![artifact.clone()],
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
            "calendar-test-registry",
        )
        .unwrap();
    installer.install(&access, &source, &artifact, true).unwrap();
    drop(installer);
    // A cached event for the signed-in owner, written the way a sync would leave it.
    let event_title = "Server gate planning review";
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let account = uuid::Uuid::new_v4();
        db.execute("INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,encrypted_secret,scopes) VALUES($1,'google',$2,'{}',ARRAY['https://www.googleapis.com/auth/calendar'])", &[&account, &owner]).await.unwrap();
        db.execute("INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id) VALUES($1,$2,$3,$4,'2026-11-12T15:00:00Z','2026-11-12T16:00:00Z','server-gate')", &[&uuid::Uuid::new_v4(), &account, &owner, &event_title]).await.unwrap();
    });
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    let _server = start(true);
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/calendar{path}"))
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
        let body = response.json::<Value>().unwrap_or(Value::Null);
        println!("{path} -> {status}");
        (status, body)
    };
    use reqwest::Method;
    assert_eq!(call(Method::GET, "/events", None, None).0, 401);
    let (status, events) = call(Method::GET, "/events", Some(&cookie), None);
    assert_eq!(status, 200, "{events}");
    let found = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["title"] == event_title)
        .unwrap_or_else(|| panic!("owner event missing: {events}"))
        .clone();
    let (status, one) = call(
        Method::GET,
        &format!("/events/{}", found["id"].as_str().unwrap()),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{one}");
    assert_eq!(one["event"]["title"], event_title);
    let (status, _) = call(
        Method::GET,
        &format!("/events/{}", uuid::Uuid::new_v4()),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 404);
    let (status, none) = call(
        Method::GET,
        "/day-plan?date=2026-11-12&timeZone=UTC",
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{none}");
    assert_eq!(none["plan"], Value::Null);
    let (status, created) = call(
        Method::POST,
        "/day-plans",
        Some(&cookie),
        Some(json!({"date":"2026-11-12","timeZone":"UTC"})),
    );
    assert_eq!(status, 200, "{created}\n{}", fs::read_to_string(root.join("server.log")).unwrap_or_default());
    let (status, read) = call(
        Method::GET,
        "/day-plan?date=2026-11-12&timeZone=UTC",
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["plan"]["localDay"], "2026-11-12", "{read}");
    let (status, settings) = call(Method::GET, "/briefing-settings", Some(&cookie), None);
    println!("briefing settings read -> {status}: {settings}");
    println!("PASS installed Calendar package served over HTTPS by the real server: sign-in required, owner event list and detail, unknown event 404, day plan create and read");
    println!("NOT PROVEN: Calendar screens on the real server (it serves module routes only), provider tools, second account over HTTP, second physical device");
}
