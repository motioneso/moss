//! Installed Scratchpad served by the real HTTPS executable; optional held shell for live screen proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
#[path = "chat_part4d/live.rs"]
mod part4d;
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
    let remote = std::env::var("MOSS_SCRATCHPAD_HOST")
        .ok()
        .map(|host| format!("https://{host}:{}", port.0));
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
    if let Ok(web) = std::env::var("MOSS_SCRATCHPAD_SCREEN_WEB") {
        assert!(Command::new("cp")
            .args(["-r", &format!("{web}/.")])
            .arg(root.join("web"))
            .status()
            .unwrap()
            .success());
    }
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-scratchpad-signing-secret-235","connector_key":connector_key}),
    );
    let origins: Vec<String> = [Some(origin.clone()), remote.clone()]
        .into_iter()
        .flatten()
        .collect();
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
        if let Some(runner) = std::env::var_os("MOSS_CHAT_BRIDGE_RUNNER") {
            command.arg("--runner").arg(runner);
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
    let mut packages = vec![("JS286_SCRATCHPAD_PACKAGE", "scratchpad")];
    if std::env::var_os("JS383_COMMITMENTS_PACKAGE").is_some() {
        packages.push(("JS383_COMMITMENTS_PACKAGE", "commitments"));
    }
    for (variable, id) in [
        ("JS389_TASKS_PACKAGE", "tasks"),
        ("JS389_CALENDAR_PACKAGE", "calendar"),
        ("JS389_EMAIL_PACKAGE", "email"),
        ("JS389_CONNECTORS_PACKAGE", "connectors"),
        ("JS389_MEALS_PACKAGE", "meals"),
        ("JS389_WEB_RESEARCH_PACKAGE", "web"),
    ] {
        if std::env::var_os(variable).is_some() {
            packages.push((variable, id));
        }
    }
    if std::env::var_os("JS388_NOTES_PACKAGE").is_some() {
        packages.push(("JS388_NOTES_PACKAGE", "notes"));
    }
    if std::env::var_os("JS386_NEWS_PACKAGE").is_some() {
        packages.push(("JS386_NEWS_PACKAGE", "news"));
    }
    for (variable, id) in [
        ("JS387_SPORTS_PACKAGE", "sports"),
        ("JS387_WELLNESS_PACKAGE", "wellness"),
        ("JS387_WEATHER_PACKAGE", "weather"),
        ("JS387_BRIEFINGS_PACKAGE", "briefings"),
    ] {
        if std::env::var_os(variable).is_some() {
            packages.push((variable, id));
        }
    }
    if std::env::var_os("JS390_FINANCE_PACKAGE").is_some() {
        packages.push(("JS390_FINANCE_PACKAGE", "finance"));
    }
    let artifacts: Vec<Artifact> = packages
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
            "scratchpad-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        // Finance joins only after Scratchpad's exact export/delete checks below.
        if artifact.id == "finance" { continue; }
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    let mut modules = json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key});
    if std::env::var_os("JS388_NOTES_PACKAGE").is_some() {
        modules["notes_base"] = json!(root.join("notes"));
    }
    private(&root.join("modules.json"), &modules);
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
        signed.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/scratchpad{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
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
    while call(Method::GET, "/note", Some(&cookie), None).0 == 503
        && started.elapsed() < std::time::Duration::from_secs(60)
    {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/note", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let body = json_of(&text);
        assert_eq!(
            (
                body["revision"].clone(),
                body["body"].clone(),
                body["maxChars"].clone()
            ),
            (json!(0), json!(""), json!(64000))
        );
    }
    // Save, conflict and append work for the owner.
    let (status, text) = call(
        Method::PUT,
        "/note",
        Some(&cookie),
        Some(json!({"body": format!("owner {MARK}"), "revision": 0})),
    );
    assert_eq!(
        (status, json_of(&text)["revision"].clone()),
        (200, json!(1)),
        "{text}"
    );
    let (status, text) = call(
        Method::PUT,
        "/note",
        Some(&cookie),
        Some(json!({"body": "late", "revision": 0})),
    );
    assert_eq!(
        (status, json_of(&text)["error"].clone()),
        (409, json!("scratchpad_conflict")),
        "{text}"
    );
    let (status, text) = call(
        Method::POST,
        "/append",
        Some(&cookie),
        Some(json!({"text": "second"})),
    );
    assert_eq!(
        (status, json_of(&text)["appended"].clone()),
        (200, json!("\nsecond")),
        "{text}"
    );
    // The real HTTPS path asks the Wasm guest for stored-record approval details.
    let input = json!({"text":format!("chat {MARK}")});
    let (status, text) = call(
        Method::POST,
        "/chat/approval",
        Some(&cookie),
        Some(input.clone()),
    );
    assert_eq!(status, 200);
    let card = json_of(&text);
    assert_eq!(card["revision"], 2);
    assert_eq!(
        card["characterCount"],
        format!("owner {MARK}\nsecond").encode_utf16().count()
    );
    assert_eq!(card["fields"][0]["value"], input["text"]);
    assert_eq!(
        call(
            Method::POST,
            "/chat/append",
            Some(&cookie),
            Some(input.clone())
        )
        .0,
        500
    );
    // Setup the grant through the real trusted host API, as the approval UI does.
    // No response is intercepted; the server consumes the actual persisted grant.
    struct NoAi;
    impl moss_module_host::ai::Intelligence for NoAi {
        fn generate(
            &self,
            _: &moss_module_host::runtime::CallScope,
            _: &moss_module_host::runtime::Request,
        ) -> anyhow::Result<Value> {
            anyhow::bail!("No AI")
        }
        fn embed(
            &self,
            _: &moss_module_host::runtime::CallScope,
            _: &moss_module_host::runtime::Request,
        ) -> anyhow::Result<Value> {
            anyhow::bail!("No AI")
        }
    }
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(
            safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap(),
        ),
        std::sync::Arc::new(NoAi),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    services
        .approve_tool(&access, "scratchpad", "scratchpad.append", &input)
        .unwrap();
    assert_eq!(
        call(
            Method::POST,
            "/chat/append",
            Some(&other),
            Some(input.clone())
        )
        .0,
        500
    );
    let (status, text) = call(
        Method::POST,
        "/chat/append",
        Some(&cookie),
        Some(input.clone()),
    );
    assert_eq!(status, 200);
    assert_eq!(json_of(&text)["data"]["appended"], format!("\nchat {MARK}"));
    assert_eq!(
        call(Method::POST, "/chat/append", Some(&cookie), Some(input)).0,
        500
    );
    let (status, text) = call(Method::GET, "/chat/read", Some(&cookie), None);
    assert_eq!(status, 200);
    assert_eq!(
        json_of(&text)["data"]["body"],
        format!("owner {MARK}\nsecond\nchat {MARK}")
    );
    println!("scratchpad live: stored-record approval, denied unapproved/other-account/replay, approved chat append through HTTPS");
    // The other person sees none of it, and cannot save over it.
    let (_, text) = call(Method::GET, "/note", Some(&other), None);
    let seen = json_of(&text);
    assert_eq!(
        (seen["body"].clone(), seen["revision"].clone()),
        (json!(""), json!(0))
    );
    assert!(!text.contains(MARK));
    let (status, text) = call(
        Method::PUT,
        "/note",
        Some(&other),
        Some(json!({"body": "taken", "revision": 1})),
    );
    assert_eq!(status, 409, "{text}");
    assert!(
        !text.contains(MARK),
        "a conflict must not show another person's note"
    );
    let (_, text) = call(Method::GET, "/note", Some(&cookie), None);
    assert_eq!(
        json_of(&text)["body"],
        json!(format!("owner {MARK}\nsecond\nchat {MARK}"))
    );
    // Settings, validation and unknown routes.
    let (status, text) = call(
        Method::PATCH,
        "/settings",
        Some(&cookie),
        Some(json!({"shortcut": "alt+j"})),
    );
    assert_eq!(
        (status, json_of(&text)["shortcut"].clone()),
        (200, json!("alt+j")),
        "{text}"
    );
    let (status, text) = call(
        Method::PATCH,
        "/settings",
        Some(&cookie),
        Some(json!({"syncToNotes": true})),
    );
    assert_eq!(
        (status, json_of(&text)["code"].clone()),
        (409, json!("scratchpad_notes_folder_missing")),
        "{text}"
    );
    // Link Notes after readiness and the unlinked-folder assertion, before browser proof.
    if std::env::var_os("JS388_NOTES_PACKAGE").is_some() {
        let folder = root.join("notes").join(owner.to_string()).join("Journal");
        fs::create_dir_all(&folder).unwrap();
        for name in [
            "desktop-delete.md",
            "phone-delete.md",
            "desktop-reject.md",
            "phone-reject.md",
        ] {
            fs::write(
                folder.join(name),
                format!("# Approval proof\nSaved {name} before deletion.\n"),
            )
            .unwrap();
        }
        let linked = client
            .put(format!("{origin}/api/m/notes/notes-source"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .json(&json!({"path":folder}))
            .send()
            .unwrap();
        let status = linked.status();
        let body = linked.text().unwrap();
        assert_eq!(status, 200, "Link the real Notes folder: {body}");
        println!("notes live: linked the real folder after module readiness");
    }
    assert_eq!(
        call(
            Method::PATCH,
            "/settings",
            Some(&cookie),
            Some(json!({"shortcut": "ctrl+k"}))
        )
        .0,
        400
    );
    assert_eq!(
        call(
            Method::PUT,
            "/note",
            Some(&cookie),
            Some(json!({"body": 3, "revision": 0}))
        )
        .0,
        400
    );
    // The server refuses a route the manifest does not declare before the module runs.
    assert_eq!(call(Method::DELETE, "/note", Some(&cookie), None).0, 400);
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
        println!(
            "scratchpad live: another device got {signed_out} signed out and {signed_in} signed in"
        );
        assert_eq!(
            (signed_out.as_str(), signed_in.as_str()),
            ("401", "200"),
            "the other device must reach the server"
        );
    }
    let (status, text) = call(Method::GET, "/account/export", Some(&cookie), None);
    assert_eq!(status, 200);
    assert_eq!(
        json_of(&text)["scratchpad"]["body"],
        format!("owner {MARK}\nsecond\nchat {MARK}")
    );
    assert_eq!(
        call(Method::DELETE, "/account/data", Some(&other), None).0,
        200
    );
    let (_, text) = call(Method::GET, "/account/export", Some(&cookie), None);
    assert!(json_of(&text)["scratchpad"]["body"]
        .as_str()
        .unwrap()
        .contains(MARK));
    let (status, text) = call(Method::DELETE, "/account/data", Some(&cookie), None);
    assert_eq!(status, 200);
    assert_eq!(json_of(&text)["deleted"], 1);
    let (_, text) = call(Method::GET, "/account/export", Some(&cookie), None);
    assert_eq!(json_of(&text), json!({"scratchpad":null}));
    assert!(
        !serde_json::to_string(&services.activity("scratchpad", &access).unwrap())
            .unwrap()
            .contains(MARK)
    );
    println!("scratchpad live: account export and deletion run through HTTPS, activity and server log contain no planted text");
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("scratchpad live: read, save, conflict, append and settings worked over HTTPS for two people");
    let _server = if let Some(finance) = artifacts.iter().find(|a| a.id == "finance") {
        drop(_server);
        let app = runtime.block_on(Database::connect(&app_url, 4, RuntimeRole::App)).unwrap();
        let installer = installed::reopen(
            &root.join("data"), app, &access,
            std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
        );
        installer.install(&access, &source, finance, true).unwrap();
        if std::env::var_os("JS395_FINANCE_BATCH_PROOF").is_some() {
            // Seed the person's ask policy; the proof still uses real model calls and UI decisions.
            services.set_action_policy(&access, "finance", &[("finance.import.apply".into(), true)].into()).unwrap();
        }

        drop(installer);
        start(true)
    } else { _server };
    // Keep the real server and the gate's isolated database alive for browser proof.
    if let Ok(hold) = std::env::var("MOSS_SCRATCHPAD_HOLD") {
        let hold = Path::new(&hold);
        fs::write(hold.join("url.txt"), remote.as_ref().unwrap_or(&origin)).unwrap();
        if std::env::var_os("MOSS_CHAT_BRIDGE_RUNNER").is_some() {
            let other_id: uuid::Uuid = runtime.block_on(async {
                let (db, connection) =
                    tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                        .await
                        .unwrap();
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                db.query_one(
                    "SELECT id FROM app.users WHERE email='scratchpad-other@example.test'",
                    &[],
                )
                .await
                .unwrap()
                .get(0)
            });
            let commitments = if std::env::var_os("JS383_COMMITMENTS_PACKAGE").is_some() {
                runtime.block_on(async {
                    let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
                    tokio::spawn(async move { let _ = connection.await; });
                    let mut ids = Vec::new();
                    for name in ["Desktop approve report", "Desktop decline report", "Phone approve report", "Phone decline report"] {
                        let id = uuid::Uuid::new_v4();
                        db.execute("INSERT INTO app.commitment_candidates(id,owner_user_id,candidate_signature,kind,title,confidence,status,source_count,last_seen_at) VALUES($1,$2,$3,'promise',$4,'high','pending_review',1,now())", &[&id,&owner,&format!("js383-{id}"),&name]).await.unwrap();
                        ids.push(id);
                    }
                    ids
                })
            } else {
                Vec::new()
            };
            let part4d = if std::env::var_os("JS389_CONNECTORS_PACKAGE").is_some() {
                runtime.block_on(async {
                    let (db, connection) =
                        tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                            .await
                            .unwrap();
                    tokio::spawn(async move {
                        let _ = connection.await;
                    });
                    part4d::seed(&db, owner).await
                })
            } else {
                Value::Null
            };
            private(
                &hold.join("bridge.json"),
                &json!({"root":root,"owner":owner,"other":other_id,"origin":origin,"remote":remote,"server_pid":_server.0.id(),"commitments":commitments,"part4d":part4d}),
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3600);
        while !hold.join("finished").exists() && Instant::now() < deadline {
            // A browser proof can ask the trusted fixture to approve and execute a real append.
            // It uses the same persisted one-use grant and HTTPS route already asserted above.
            if let Ok(text) = fs::read_to_string(hold.join("append.txt")) {
                let parameters = json!({"text":text});
                services
                    .approve_tool(&access, "scratchpad", "scratchpad.append", &parameters)
                    .unwrap();
                let (status, _) = call(
                    Method::POST,
                    "/chat/append",
                    Some(&cookie),
                    Some(parameters),
                );
                fs::remove_file(hold.join("append.txt")).unwrap();
                fs::write(hold.join("appended.txt"), status.to_string()).unwrap();
                assert_eq!(status, 200);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(
            hold.join("finished").exists(),
            "screen proof did not finish before deadline"
        );
    }
}
