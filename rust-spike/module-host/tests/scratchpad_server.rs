//! Installed Scratchpad package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Scratchpad live gate"]
fn installed_scratchpad_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js286-scratchpad-{}", std::process::id())])
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
    // MOSS_SCRATCHPAD_HOST names the address another device uses. When set, the listener binds
    // every interface and trusts that origin, and MOSS_SCRATCHPAD_REMOTE_SSH names a device
    // that asks the server for the signed-in status from there.
    let remote = std::env::var("MOSS_SCRATCHPAD_HOST").ok().map(|host| format!("https://{host}:{}", port.0));
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
        "<!doctype html><title>Scratchpad HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-scratchpad-signing-secret-235","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-scratchpad-password-235-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("scratchpad-owner@example.test", "Scratchpad owner");
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
                "SELECT id FROM app.users WHERE email='scratchpad-owner@example.test'",
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
    let access = AccessContext::new(owner, "scratchpad-install");
    // Publish the Scratchpad package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS286_SCRATCHPAD_PACKAGE", "scratchpad")]
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
            publisher_key: "scratchpad-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Scratchpad live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "scratchpad-test-registry".into(),
        name: "Scratchpad test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "scratchpad-test".into(),
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
            "scratchpad-test-registry",
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Scratchpad other', 'scratchpad-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"scratchpad-other@example.test","password":"temporary-scratchpad-password-235-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/scratchpad{path}")).header("origin", &origin);
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
    const MARK: &str = "PLANTED-LIVE-NOTE-7d2e";
    assert_eq!(call(Method::GET, "/note", None, None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = std::time::Instant::now();
    while call(Method::GET, "/note", Some(&cookie), None).0 == 503 && started.elapsed() < std::time::Duration::from_secs(60) {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/note", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let body = json_of(&text);
        assert_eq!((body["revision"].clone(), body["body"].clone(), body["maxChars"].clone()), (json!(0), json!(""), json!(64000)));
    }
    // Save, conflict and append work for the owner.
    let (status, text) = call(Method::PUT, "/note", Some(&cookie), Some(json!({"body": format!("owner {MARK}"), "revision": 0})));
    assert_eq!((status, json_of(&text)["revision"].clone()), (200, json!(1)), "{text}");
    let (status, text) = call(Method::PUT, "/note", Some(&cookie), Some(json!({"body": "late", "revision": 0})));
    assert_eq!((status, json_of(&text)["error"].clone()), (409, json!("scratchpad_conflict")), "{text}");
    let (status, text) = call(Method::POST, "/append", Some(&cookie), Some(json!({"text": "second"})));
    assert_eq!((status, json_of(&text)["appended"].clone()), (200, json!("\nsecond")), "{text}");
    // The other person sees none of it, and cannot save over it.
    let (_, text) = call(Method::GET, "/note", Some(&other), None);
    let seen = json_of(&text);
    assert_eq!((seen["body"].clone(), seen["revision"].clone()), (json!(""), json!(0)));
    assert!(!text.contains(MARK));
    let (status, text) = call(Method::PUT, "/note", Some(&other), Some(json!({"body": "taken", "revision": 1})));
    assert_eq!(status, 409, "{text}");
    assert!(!text.contains(MARK), "a conflict must not show another person's note");
    let (_, text) = call(Method::GET, "/note", Some(&cookie), None);
    assert_eq!(json_of(&text)["body"], json!(format!("owner {MARK}\nsecond")));
    // Settings, validation and unknown routes.
    let (status, text) = call(Method::PATCH, "/settings", Some(&cookie), Some(json!({"shortcut": "alt+j"})));
    assert_eq!((status, json_of(&text)["shortcut"].clone()), (200, json!("alt+j")), "{text}");
    let (status, text) = call(Method::PATCH, "/settings", Some(&cookie), Some(json!({"syncToNotes": true})));
    assert_eq!((status, json_of(&text)["code"].clone()), (409, json!("scratchpad_notes_folder_missing")), "{text}");
    assert_eq!(call(Method::PATCH, "/settings", Some(&cookie), Some(json!({"shortcut": "ctrl+k"}))).0, 400);
    assert_eq!(call(Method::PUT, "/note", Some(&cookie), Some(json!({"body": 3, "revision": 0}))).0, 400);
    assert_eq!(call(Method::DELETE, "/note", Some(&cookie), None).0, 404);
    // A second device on the network reaches the same server and sees only its own account.
    if let (Some(remote), Ok(device)) = (&remote, std::env::var("MOSS_SCRATCHPAD_REMOTE_SSH")) {
        let ask = |cookie: &str| {
            let line = format!(
                "curl -sk -o /dev/null -w '%{{http_code}}' -H 'origin: {remote}' -H 'cookie: {cookie}' '{remote}/api/m/scratchpad/note'"
            );
            let output = Command::new("ssh")
                .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", &device])
                .arg(line)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        let (signed_out, signed_in) = (ask("none=1"), ask(&cookie));
        println!("scratchpad live: another device got {signed_out} signed out and {signed_in} signed in");
        assert_eq!((signed_out.as_str(), signed_in.as_str()), ("401", "200"), "the other device must reach the server");
    }
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("scratchpad live: read, save, conflict, append and settings worked over HTTPS for two people");
}
