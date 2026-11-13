//! Installed Backtrack package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Backtrack live gate"]
fn installed_backtrack_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js261-backtrack-{}", std::process::id())])
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
    // MOSS_BACKTRACK_HOST names the address another device uses. When set, the listener binds
    // every interface and trusts that origin, and MOSS_BACKTRACK_REMOTE_SSH names a device
    // that asks the server for the signed-in status from there.
    let remote = std::env::var("MOSS_BACKTRACK_HOST").ok().map(|host| format!("https://{host}:{}", port.0));
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .args(&remote)
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
        "<!doctype html><title>Backtrack HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-backtrack-signing-secret-235","connector_key":connector_key}),
    );
    let origins: Vec<String> = [Some(origin.clone()), remote.clone()].into_iter().flatten().collect();
    private(
        &root.join("network.json"),
        &json!({"listen":format!("{}:{}",if remote.is_some() {"0.0.0.0"} else {"127.0.0.1"},port.0),"origins":origins,"sharing":remote.is_some(),"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-backtrack-password-235-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("backtrack-owner@example.test", "Backtrack owner");
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
                "SELECT id FROM app.users WHERE email='backtrack-owner@example.test'",
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
    let access = AccessContext::new(owner, "backtrack-install");
    // Publish the Backtrack package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS231_MEMORY_PACKAGE", "memory"), ("JS261_BACKTRACK_PACKAGE", "backtrack")]
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
            publisher_key: "backtrack-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Backtrack live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "backtrack-test-registry".into(),
        name: "Backtrack test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "backtrack-test".into(),
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
            "backtrack-test-registry",
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Backtrack other', 'backtrack-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"backtrack-other@example.test","password":"temporary-backtrack-password-235-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/backtrack{path}")).header("origin", &origin);
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
    assert_eq!(call(Method::GET, "/status", None, None).0, 401);
    // The server loads the installed packages in the background, so wait until it answers.
    for _ in 0..120 {
        if call(Method::GET, "/status", Some(&cookie), None).0 != 503 {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    // Both people start empty and see the storage switch as off.
    // The server answers 503 until its module host has finished starting.
    let started = std::time::Instant::now();
    while call(Method::GET, "/status", Some(&cookie), None).0 == 503 && started.elapsed() < std::time::Duration::from_secs(60) {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/status", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let body = json_of(&text);
        assert_eq!((body["days"].clone(), body["storage"].clone()), (json!(0), json!("off")));
    }
    // A Mac upload is refused with nothing stored, because no Mac is linked to either person.
    let upload = json!({"sentAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "segments": [{"startedAt": "2026-11-12T10:00:00.000Z", "endedAt": "2026-11-12T10:05:00.000Z", "appName": "Safari", "bundleId": "com.apple.Safari", "windowTitle": "t", "address": "https://example.test", "body": MARK}]});
    let (status, text) = call(Method::POST, "/ingest", Some(&cookie), Some(upload));
    assert_eq!(status, 401, "{text}");
    assert!(!text.contains(MARK));
    // Pause is the person's own and does not leak across people.
    let (status, text) = call(Method::PUT, "/preferences", Some(&cookie), Some(json!({"paused": true})));
    assert_eq!((status, json_of(&text)["paused"].clone()), (200, json!(true)), "{text}");
    let seen = |who: &str| {
        let (_, text) = call(Method::GET, "/status", Some(who), None);
        json_of(&text)["paused"].clone()
    };
    assert_eq!((seen(&cookie), seen(&other)), (json!(true), json!(false)));
    // Bad input gets the legacy refusal, and delete works with storage off and no Mac.
    let (status, _) = call(Method::PUT, "/preferences", Some(&cookie), Some(json!({"paused": "yes"})));
    assert_eq!(status, 400);
    let (status, text) = call(Method::DELETE, "/segments", Some(&other), None);
    assert_eq!((status, json_of(&text)["deleted"].clone()), (200, json!(0)), "{text}");
    let (status, _) = call(Method::DELETE, "/segments", Some(&other), Some(json!({"from": "2026-11-02T00:00:00.000Z", "to": "2026-11-01T00:00:00.000Z"})));
    assert_eq!(status, 400);
    // A second device on the network reaches the same server and sees only its own account.
    if let (Some(remote), Ok(device)) = (&remote, std::env::var("MOSS_BACKTRACK_REMOTE_SSH")) {
        let ask = |cookie: &str| {
            let line = format!(
                "curl -sk -o /dev/null -w '%{{http_code}}' -H 'origin: {remote}' -H 'cookie: {cookie}' '{remote}/api/m/backtrack/status'"
            );
            let output = Command::new("ssh")
                .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", &device])
                .arg(line)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        let (signed_out, signed_in) = (ask("none=1"), ask(&cookie));
        println!("backtrack live: another device got {signed_out} signed out and {signed_in} signed in");
        assert_eq!((signed_out.as_str(), signed_in.as_str()), ("401", "200"), "the other device must reach the server");
    }
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("backtrack live: status, pause, delete and the Mac refusal worked over HTTPS for two people");
}
