//! Installed Connectors package served by the real HTTPS executable. Not a native UI proof.
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
static CLAIMED_PORT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
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
#[ignore = "Only through verify-gate and the Connectors live gate"]
fn installed_connectors_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    // Whole-test watchdog. A hang anywhere (server start, a read, the browser) ends the
    // process with a clear message instead of blocking the gate.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(900));
        eprintln!("WATCHDOG: the Connectors live test ran longer than 900s and was stopped");
        // exit() skips the cleanup guards, so stop the server, fake Google and browser
        // runner and hand the port back here.
        let _ = Command::new("pkill").args(["-KILL", "-P", &std::process::id().to_string()]).status();
        if let Some(port) = CLAIMED_PORT.get() {
            let _ = Command::new("devports").args(["release", port]).output();
        }
        std::process::exit(124);
    });
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js224-connectors-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!port.0.is_empty());
    let _ = CLAIMED_PORT.set(port.0.clone());
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
        "<!doctype html><title>Connectors HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-connectors-signing-secret-224","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-connectors-password-224-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("connectors-owner@example.test", "Connectors owner");
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
                "SELECT id FROM app.users WHERE email='connectors-owner@example.test'",
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
    let access = AccessContext::new(owner, "connectors-install");
    // Publish the Connectors package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS225_EMAIL_PACKAGE", "email"), ("JS220_TASKS_PACKAGE", "tasks"), ("JS181_CALENDAR_PACKAGE", "calendar"), ("JS224_CONNECTORS_PACKAGE", "connectors")]
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
            publisher_key: "connectors-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Connectors live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "connectors-test-registry".into(),
        name: "Connectors test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "connectors-test".into(),
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
            "connectors-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);
    // The fake Google runs as its own process. The server reaches it only through the
    // test-only setting, which is never on in a normal install.
    let mut fake_google = Server(
        Command::new(std::env::var("JS230_FAKE_GOOGLE").expect("the gate must supply the fake Google"))
            .args(["live-http-code", "live-browser-code"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    // Read the fake's startup lines on a helper thread with a deadline, so a missing line
    // fails the test loudly instead of blocking it forever.
    let mut google_lines = std::collections::HashMap::new();
    {
        use std::io::BufRead;
        let mut out = std::io::BufReader::new(fake_google.0.stdout.take().unwrap());
        let (lines, received) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut line = String::new();
            while out.read_line(&mut line).is_ok_and(|n| n > 0) {
                if lines.send(line.trim().to_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        while ["token-url", "client-id", "client-secret"].iter().any(|k| !google_lines.contains_key(*k)) {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = received
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("the fake Google did not print its startup lines in 15s; got {google_lines:?}"));
            if let Some((key, value)) = line.split_once(' ') {
                google_lines.insert(key.to_owned(), value.to_owned());
            }
        }
    }
    let mut google_commands = fake_google.0.stdin.take().unwrap();
    {
        use std::io::Write;
        for line in ["event Planning 1", "event Review 2", "event Offsite 3", "message Quarterly plan", "message Lunch on Friday", "message Invoice reminder"] {
            writeln!(google_commands, "{line}").unwrap();
        }
        google_commands.flush().unwrap();
    }
    let token_url = google_lines["token-url"].clone();
    let google_id = google_lines["client-id"].clone();
    let google_secret = google_lines["client-secret"].clone();
    // The fake mail server also runs as its own process, serving TLS with a throwaway
    // certificate that the test-only setting trusts. A real provider is never contacted.
    let mail_certificate = root.join("fake-mail.cert.pem");
    let mut fake_mail = Server(
        Command::new(std::env::var("JS237_FAKE_MAIL").expect("the gate must supply the fake mail server"))
            .arg(&mail_certificate)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut mail_commands = fake_mail.0.stdin.take().unwrap();
    let mut mail_lines = std::collections::HashMap::new();
    {
        use std::io::BufRead;
        let mut out = std::io::BufReader::new(fake_mail.0.stdout.take().unwrap());
        let (lines, received) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut line = String::new();
            while out.read_line(&mut line).is_ok_and(|n| n > 0) {
                if lines.send(line.trim().to_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        while ["imap-port", "smtp-port", "username", "password"].iter().any(|k| !mail_lines.contains_key(*k)) {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = received
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("the fake mail server did not print its startup lines in 15s; got {mail_lines:?}"));
            if let Some((key, value)) = line.split_once(' ') {
                mail_lines.insert(key.to_owned(), value.to_owned());
            }
        }
    }
    // The stand-in Outlook page also runs as its own process. The server reaches it only
    // through the outlook_browser setting, which names this person and one invented account.
    let mut fake_outlook = Server(
        Command::new(std::env::var("JS270_FAKE_OUTLOOK").expect("the gate must supply the fake Outlook page"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut outlook_commands = fake_outlook.0.stdin.take().unwrap();
    let outlook_endpoint = {
        use std::io::BufRead;
        let mut out = std::io::BufReader::new(fake_outlook.0.stdout.take().unwrap());
        let (lines, received) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut line = String::new();
            while out.read_line(&mut line).is_ok_and(|n| n > 0) {
                if lines.send(line.trim().to_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = received.recv_timeout(left).expect("the fake Outlook page did not print its endpoint in 15s");
            if let Some(endpoint) = line.strip_prefix("endpoint ") {
                break endpoint.to_owned();
            }
        }
    };
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"test_only_google_token_url":token_url,"outlook_browser":{"endpoint":outlook_endpoint,"owner":owner.to_string(),"account":"person@example.invalid"},
            "test_only_mail":{"imap_port":mail_lines["imap-port"].parse::<u16>().unwrap(),"imap_tls":true,"smtp_port":mail_lines["smtp-port"].parse::<u16>().unwrap(),"smtp_security":"implicit_tls","trusted_certificate":mail_certificate}}),
    );
    let _server = start(true);
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/connectors{path}"))
            .header("origin", &origin);
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
    // Every response body is kept so the marker search below covers all of them.
    let mut seen: Vec<String> = vec![];
    assert_eq!(call(Method::GET, "/accounts", None, None).0, 401);
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/providers", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!(status, 200, "{text}\n{}", log());
    seen.push(text.clone());
    assert!(json_of(&text)["providers"].as_array().is_some_and(|p| !p.is_empty()), "{text}");
    let (status, text) = call(
        Method::POST,
        "/accounts",
        Some(&cookie),
        Some(json!({"providerId":"google","scopes":["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"],"tokenPayload":{"password":MARKER,"accessToken":MARKER_TOKEN,"refreshToken":MARKER_REFRESH}})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    seen.push(text.clone());
    let created = json_of(&text);
    let id = created["account"]["id"].as_str().or(created["id"].as_str()).unwrap_or_else(|| panic!("no id in {text}")).to_owned();
    let (status, text) = call(Method::GET, "/accounts", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert!(text.contains(&id), "{text}");
    let (status, text) = call(Method::GET, &format!("/accounts/{id}/feature-grants"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"email":true,"calendar":true})));
    seen.push(text);
    let (status, text) = call(Method::PUT, &format!("/accounts/{id}/feature-grants"), Some(&cookie), Some(json!({"calendar":false})));
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert_eq!(json_of(&text)["calendar"], false, "{text}");
    let (status, text) = call(Method::PATCH, &format!("/accounts/{id}"), Some(&cookie), Some(json!({"scopes":["https://www.googleapis.com/auth/gmail.modify"]})));
    assert_eq!(status, 200, "{text}");
    seen.push(text);
    let (status, text) = call(Method::GET, "/admin/accounts", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text);
    let missing = uuid::Uuid::new_v4();
    assert_eq!(call(Method::PATCH, &format!("/accounts/{missing}"), Some(&cookie), Some(json!({"scopes":[]}))).0, 404);
    assert_eq!(call(Method::POST, &format!("/accounts/{missing}/revoke"), Some(&cookie), None).0, 404);
    let (status, text) = call(Method::POST, &format!("/accounts/{id}/revoke"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert_eq!(json_of(&text)["account"]["status"].as_str().or(json_of(&text)["status"].as_str()), Some("revoked"), "{text}");
    // Google connect over HTTP with the fake Google: start, then finish with the pasted address.
    let (status, text) = call(
        Method::POST,
        "/google/authorize",
        Some(&cookie),
        Some(json!({"clientId":google_id,"clientSecret":google_secret})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    seen.push(text.clone());
    let auth_url = url::Url::parse(json_of(&text)["authUrl"].as_str().expect("authUrl")).unwrap();
    assert_eq!(auth_url.host_str(), Some("accounts.google.com"));
    let state = auth_url.query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
    let pasted = format!("http://localhost:1/?code=live-http-code&state={state}");
    let (status, text) = call(Method::POST, "/google/complete", Some(&cookie), Some(json!({"redirectUrl":pasted})));
    assert_eq!(status, 201, "{text}\n{}", log());
    seen.push(text.clone());
    assert_eq!(json_of(&text)["account"]["status"], "active", "{text}");
    println!("PASS Google connect over HTTP: authorize then complete answered 201 with an active account");
    let google_account = json_of(&text)["account"]["id"].as_str().expect("account id").to_owned();
    // Connecting starts a sync. Wait for it, then read what it saved through Email and Calendar.
    let account_row = || {
        let all = json_of(&call(Method::GET, "/accounts", Some(&cookie), None).1);
        all["accounts"].as_array().unwrap().iter().find(|a| a["id"] == google_account.as_str()).cloned().unwrap()
    };
    let saved_mail = || {
        let r = client.get(format!("{origin}/api/m/email/messages")).header("origin", &origin).header("cookie", &cookie).send().unwrap();
        json_of(&r.text().unwrap_or_default())["messages"].as_array().cloned().unwrap_or_default()
    };
    let saved_events = || {
        let r = client.get(format!("{origin}/api/m/calendar/events")).header("origin", &origin).header("cookie", &cookie).send().unwrap();
        json_of(&r.text().unwrap_or_default())["events"].as_array().cloned().unwrap_or_default()
    };
    let jobs_now = || {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let result = db
                .query("SELECT queue, state, attempts::text||' '||coalesce(failure_code,'') FROM moss_queue.jobs WHERE queue LIKE '%google%' ORDER BY run_at DESC LIMIT 6", &[])
                .await;
            match result {
                Ok(rows) => rows.iter().map(|r| format!("{} {} {}", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2))).collect::<Vec<_>>(),
                Err(e) => {
                    let tables = db
                        .query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_name ILIKE '%job%' OR table_schema ILIKE '%boss%' OR table_schema ILIKE '%job%'", &[])
                        .await
                        .map(|rows| rows.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>());
                    vec![format!("job query failed: {:?}; tables {:?}", e.as_db_error().map(|d| d.message().to_owned()), tables)]
                }
            }
        })
    };
    let wait_until = |what: &str, check: &dyn Fn() -> bool| {
        let started = Instant::now();
        while !check() {
            assert!(started.elapsed() < Duration::from_secs(120), "Google sync did not settle: {what}; account {} mail {} events {}; jobs {:?}\n{}", account_row(), saved_mail().len(), saved_events().len(), jobs_now(), log());
            std::thread::sleep(Duration::from_millis(500));
        }
    };
    // The sync queued by connecting runs with the stand-in grant, which has no Calendar scope.
    // Let it finish, then set the real scopes and sync by hand.
    wait_until("sync after connecting", &|| account_row()["lastSyncStatus"] == "success");
    let (status, text) = call(
        Method::PATCH,
        &format!("/accounts/{google_account}"),
        Some(&cookie),
        Some(json!({"scopes":["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"]})),
    );
    assert_eq!(status, 200, "{text}");
    // An earlier step switched Calendar off for this account, so switch it back on.
    let (status, text) = call(Method::PUT, &format!("/accounts/{google_account}/feature-grants"), Some(&cookie), Some(json!({"calendar":true})));
    assert_eq!((status, json_of(&text)["calendar"].clone()), (200, json!(true)), "{text}");
    let (status, text) = call(Method::POST, "/google/sync", Some(&cookie), Some(json!({})));
    assert_eq!(status, 202, "{text}");
    wait_until("first run", &|| account_row()["lastSyncStatus"] == "success" && saved_mail().len() == 3 && saved_events().len() == 3);
    let titles: std::collections::BTreeSet<String> = saved_events().iter().map(|e| e["title"].as_str().unwrap_or("").to_owned()).collect();
    assert_eq!(titles, ["Offsite", "Planning", "Review"].map(String::from).into(), "{titles:?}");
    let first = account_row();
    assert_eq!(first["lastSyncCounts"]["calendarUpserted"], 3, "{first}");
    println!("PASS Google sync on the real server: 3 events and 3 messages saved after connecting");
    {
        // A message is removed and an event is removed in Google. A manual sync follows.
        use std::io::Write;
        writeln!(google_commands, "delete-message Lunch on Friday").unwrap();
        writeln!(google_commands, "label-message Quarterly plan").unwrap();
        writeln!(google_commands, "remove-event Offsite").unwrap();
        google_commands.flush().unwrap();
    }
    let (status, text) = call(Method::POST, "/google/sync", Some(&cookie), Some(json!({})));
    assert_eq!(status, 202, "{text}");
    wait_until("second run", &|| {
        let events: Vec<String> = saved_events().iter().map(|e| e["title"].as_str().unwrap_or("").to_owned()).collect();
        events.len() == 2 && !events.iter().any(|t| t == "Offsite") && account_row()["lastSyncStatus"] == "success"
    });
    println!("PASS Google sync second run: the event removed in Google is pruned under the runtime role");
    // The marker must be in no response, no log line, and no stored job; the stored secret is sealed.
    let markers = [MARKER, MARKER_TOKEN, MARKER_REFRESH];
    for body in &seen {
        for marker in markers {
            assert!(!body.contains(marker), "marker in a response: {body}");
        }
    }
    for marker in markers {
        assert!(!log().contains(marker), "marker in the server log");
    }
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let tables = db
            .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') AND (table_name ILIKE '%job%' OR table_name ILIKE '%audit%' OR table_name='connector_accounts')", &[])
            .await
            .unwrap();
        assert!(tables.len() >= 3, "expected job, audit and account tables");
        for row in tables {
            let (schema, name): (String, String) = (row.get(0), row.get(1));
            for marker in markers {
                let hits: i64 = db
                    .query_one(&format!("SELECT count(*) FROM \"{schema}\".\"{name}\" t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'"), &[&marker])
                    .await
                    .unwrap()
                    .get(0);
                assert_eq!(hits, 0, "marker found in {schema}.{name}");
            }
        }
        // Control: the same search does find a value that really is stored, so a zero above means absent.
        let control: i64 = db
            .query_one("SELECT count(*) FROM app.connector_accounts t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'", &[&"gmail.modify"])
            .await
            .unwrap()
            .get(0);
        assert!(control >= 1, "the search must find a stored value");
        let sealed: i64 = db
            .query_one("SELECT count(*) FROM app.connector_accounts WHERE owner_user_id=$1 AND encrypted_secret ? 'ciphertext'", &[&owner])
            .await
            .unwrap()
            .get(0);
        assert_eq!(sealed, 1, "the stored secret should be one sealed envelope");
    });
    println!("PASS Connectors routes on the real server: sign-in required, providers, create, list, grants, edit, admin list, unknown account 404, revoke; marker secret absent from every response, the server log, and every job, audit and account row");
    let screen_url = format!("{origin}/api/modules/connectors/screen?path=/settings/connections");
    assert_eq!(client.get(&screen_url).send().unwrap().status(), 401);
    let screen: Value = client.get(&screen_url).header("cookie", &cookie).send().unwrap().json().unwrap();
    let src = screen["src"].as_str().expect("screen address");
    assert!(src.starts_with("/module-ui/connectors/"), "{screen}");
    assert_eq!(client.get(format!("{origin}{src}")).header("origin", "null").header("sec-fetch-site", "cross-site").send().unwrap().status(), 200);
    println!("PASS Connections screen address and files served over HTTPS");
    {
        let script = std::env::var("MOSS_CONNECTORS_BROWSER_SCRIPT").expect("the gate must supply the browser script");
        let out = std::env::var("MOSS_CONNECTORS_BROWSER_OUT").unwrap_or_else(|_| root.display().to_string());
        let status = Command::new("timeout")
            .args(["--kill-after=10", "300", "pnpm", "exec", "tsx", &script])
            .env("ORIGIN", &origin)
            .env("EMAIL", "connectors-owner@example.test")
            .env("PASSWORD", "temporary-connectors-password-224-not-a-real-secret")
            .env("GOOGLE_CLIENT_ID", &google_id)
            .env("GOOGLE_CLIENT_SECRET", &google_secret)
            .env("GOOGLE_CODE", "live-browser-code")
            .env("OUT", out)
            .status()
            .unwrap();
        assert!(status.success(), "browser check failed\n{}", log());
    }
    {
        // After both Google connects (HTTP and browser): none of the secrets or tokens is
        // in the server log or any stored row in plain text.
        let google_markers = [google_secret.as_str(), "ya29.fake-access-", "1//fake-refresh-", "GOOGLE-BODY-MARKER"];
        for marker in google_markers {
            assert!(!log().contains(marker), "Google marker in the server log: {marker}");
        }
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db
                .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')", &[])
                .await
                .unwrap();
            for row in tables {
                let (schema, name): (String, String) = (row.get(0), row.get(1));
                for marker in google_markers {
                    let hits: i64 = db
                        .query_one(&format!("SELECT count(*) FROM \"{schema}\".\"{name}\" t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'"), &[&marker])
                        .await
                        .unwrap()
                        .get(0);
                    assert_eq!(hits, 0, "Google marker {marker} found in {schema}.{name}");
                }
            }
            let control: i64 = db
                .query_one("SELECT count(*) FROM app.connector_accounts t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'", &[&"google"])
                .await
                .unwrap()
                .get(0);
            assert!(control >= 1, "the search must find a stored value");
            let pending: i64 = db.query_one("SELECT count(*) FROM app.connector_oauth_pending", &[]).await.unwrap().get(0);
            assert_eq!(pending, 0, "no pending sign-in is left after both connects");
        });
        println!("PASS Google secrets and tokens absent from the server log and every stored row; no pending sign-in left");
    }
    {
        // Mail connect over HTTPS against the fake mail server. The password must not reach
        // any response, the server log or any stored row; the stored bundle is sealed.
        // The first call into Email compiles its component, which a debug build does slowly,
        // and a sync that triggers that compile inside its own time limit would be cut off.
        // One ordinary Email request warms the compiled copy first.
        let warm = client
            .get(format!("{origin}/api/m/email/messages"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(warm.status().as_u16(), 200);
        let username = mail_lines["username"].clone();
        let password = mail_lines["password"].clone();
        let good = json!({"providerId":"imap-yahoo","username":username,"password":password});
        let wrong = json!({"providerId":"imap-yahoo","username":username,"password":"not-the-password"});
        let tested = call(Method::POST, "/imap/test-connection", Some(&cookie), Some(good.clone()));
        assert_eq!((tested.0, json_of(&tested.1)), (200, json!({"result":"ok"})), "{}", tested.1);
        let refused = call(Method::POST, "/imap/test-connection", Some(&cookie), Some(wrong.clone()));
        assert_eq!((refused.0, json_of(&refused.1)), (200, json!({"result":"auth_failed"})), "{}", refused.1);
        let bad = call(Method::POST, "/imap/connect", Some(&cookie), Some(wrong));
        assert_eq!(bad.0, 400, "{}", bad.1);
        assert_eq!(json_of(&bad.1)["error"], "The mail server rejected the supplied username/password");
        let unauthenticated = call(Method::POST, "/imap/connect", None, Some(good.clone()));
        assert_eq!(unauthenticated.0, 401);
        let connected = call(Method::POST, "/imap/connect", Some(&cookie), Some(good.clone()));
        assert_eq!(connected.0, 201, "{}", connected.1);
        let account = json_of(&connected.1)["account"].clone();
        assert_eq!(account["providerId"], "imap-yahoo");
        let again = call(Method::POST, "/imap/connect", Some(&cookie), Some(good));
        assert_eq!(again.0, 201, "{}", again.1);
        assert_eq!(json_of(&again.1)["account"]["id"], account["id"], "a second connect updates the same account");
        seen.extend([tested.1, refused.1, bad.1, connected.1, again.1]);
        for body in &seen {
            assert!(!body.contains(&password), "mail password in a response: {body}");
        }
        assert!(!log().contains(&password), "mail password in the server log");
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db
                .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')", &[])
                .await
                .unwrap();
            for row in tables {
                let (schema, name): (String, String) = (row.get(0), row.get(1));
                let hits: i64 = db
                    .query_one(&format!("SELECT count(*) FROM \"{schema}\".\"{name}\" t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'"), &[&password])
                    .await
                    .unwrap()
                    .get(0);
                assert_eq!(hits, 0, "mail password found in {schema}.{name}");
            }
            let control: i64 = db
                .query_one("SELECT count(*) FROM app.connector_accounts t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'", &[&"email.read"])
                .await
                .unwrap()
                .get(0);
            assert!(control >= 1, "the search must find the stored mail account");
        });
        println!("PASS mail connect on the real server: good and wrong password, test-connection, sign-in required, one account on repeat; password absent from every response, the server log and every stored row");
    }
    {
        // Mail sync through the real worker, queue and Email module. The fake server starts
        // with three messages. One is then rewritten and one removed, and a second connect
        // starts another sync.
        let listed = |want: &dyn Fn(&[Value]) -> bool| -> Vec<Value> {
            let started = Instant::now();
            loop {
                let (status, text) = {
                    let r = client
                        .get(format!("{origin}/api/m/email/messages"))
                        .header("origin", &origin)
                        .header("cookie", &cookie)
                        .send()
                        .unwrap();
                    (r.status().as_u16(), r.text().unwrap_or_default())
                };
                // The Google run earlier saved mail for the same owner, so only the IMAP rows count here.
                let rows: Vec<Value> = if status == 200 { json_of(&text)["messages"].as_array().cloned().unwrap_or_default() } else { vec![] }
                    .into_iter()
                    .filter(|m| m["externalId"].as_str().is_some_and(|k| k.starts_with("imap:")))
                    .collect();
                if want(&rows) {
                    return rows;
                }
                assert!(started.elapsed() < Duration::from_secs(90), "mail sync did not settle; last answer {status} {text}\n{}", log());
                std::thread::sleep(Duration::from_millis(500));
            }
        };
        let first = listed(&|rows| rows.len() == 3);
        let subjects: std::collections::BTreeSet<String> = first.iter().map(|m| m["subject"].as_str().unwrap_or("").to_owned()).collect();
        assert_eq!(subjects, ["Invoice reminder", "Lunch on Friday", "Quarterly plan"].map(String::from).into());
        assert!(first.iter().all(|m| m["externalId"].as_str().is_some_and(|k| k.starts_with("imap:INBOX:"))), "{first:?}");
        let plan = first.iter().find(|m| m["subject"] == "Quarterly plan").unwrap();
        assert!(plan["snippet"].as_str().unwrap().contains("PLAN-BODY-SENTINEL"), "{plan}");
        let plan_key = plan["externalId"].as_str().unwrap().to_owned();
        let lunch_key = first.iter().find(|m| m["subject"] == "Lunch on Friday").unwrap()["externalId"].as_str().unwrap().to_owned();
        let uid_of = |key: &str| key.rsplit(':').next().unwrap().to_owned();
        use std::io::Write;
        writeln!(mail_commands, "replace {}", uid_of(&plan_key)).unwrap();
        writeln!(mail_commands, "delete {}", uid_of(&lunch_key)).unwrap();
        mail_commands.flush().unwrap();
        let resync = call(Method::POST, "/imap/connect", Some(&cookie), Some(json!({"providerId":"imap-yahoo","username":mail_lines["username"],"password":mail_lines["password"]})));
        assert_eq!(resync.0, 201, "{}", resync.1);
        let second = listed(&|rows| {
            rows.len() == 2 && rows.iter().any(|m| m["snippet"].as_str().is_some_and(|s| s.contains("CHANGED-BODY-SENTINEL")))
        });
        assert!(second.iter().all(|m| m["subject"] != "Lunch on Friday"), "the deleted message must be gone");
        assert!(second.iter().all(|m| !m["snippet"].as_str().unwrap_or("").contains("PLAN-BODY-SENTINEL")), "the changed message keeps no old text");
        let mut account = Value::Null;
        for _ in 0..40 {
            let status = call(Method::GET, "/accounts", Some(&cookie), None);
            let accounts = json_of(&status.1);
            account = accounts["accounts"].as_array().unwrap().iter().find(|a| a["providerId"] == "imap-yahoo").unwrap().clone();
            if !account["lastSyncFinishedAt"].is_null() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert_eq!(account["lastSyncStatus"], "success", "{account}");
        // A second run may follow the one that changed the cache and find nothing left to fetch.
        assert!(account["lastSyncCounts"]["emailUpserted"].as_u64().unwrap() <= 1, "unchanged messages are not fetched again: {account}");
        // Today's refresh asks every connected account to sync now and reports each one.
        let key = "5b1f6a7e-3c2d-4e8f-9a0b-1c2d3e4f5a6b";
        let (status, text) = call(Method::POST, "/email-refresh", Some(&cookie), Some(json!({"idempotencyKey": key})));
        assert_eq!(status, 202, "{text}");
        let started_refresh = json_of(&text);
        let refresh_id = started_refresh["refreshId"].as_str().unwrap().to_owned();
        let again = call(Method::POST, "/email-refresh", Some(&cookie), Some(json!({"idempotencyKey": key})));
        assert_eq!(json_of(&again.1)["refreshId"], refresh_id.as_str(), "a repeated key returns the same refresh");
        let began = Instant::now();
        let done = loop {
            let (status, text) = call(Method::GET, &format!("/email-refresh/{refresh_id}"), Some(&cookie), None);
            assert_eq!(status, 200, "{text}");
            let state = json_of(&text);
            if !matches!(state["status"].as_str(), Some("queued" | "running")) {
                break state;
            }
            assert!(began.elapsed() < Duration::from_secs(120), "refresh did not settle: {state}\n{}", log());
            std::thread::sleep(Duration::from_millis(500));
        };
        assert_eq!(done["status"], "succeeded", "{done}");
        let kinds: std::collections::BTreeSet<String> = done["accounts"].as_array().unwrap().iter().map(|a| a["providerType"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kinds, ["google", "imap"].map(String::from).into(), "{done}");
        assert!(done["accounts"].as_array().unwrap().iter().all(|a| a["status"] == "succeeded"), "{done}");
        println!("PASS email refresh on the real server: {done}");
        // Each connected Google account has an email check (15 minutes) and a calendar check
        // (30 minutes). Revoking the account removes both. The schedule rows hold ids only.
        let schedules = |expect: i64, label: &str| {
            runtime.block_on(async {
                let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                let rows = db
                    .query(
                        "SELECT queue, cron, payload::text FROM moss_queue.schedules WHERE (queue LIKE '%.email-monitor' OR queue LIKE '%.calendar-monitor') AND payload::text LIKE '%' || $1 || '%' ORDER BY queue",
                        &[&google_account],
                    )
                    .await
                    .unwrap();
                assert_eq!(rows.len() as i64, expect, "{label}: {} monitor schedules", rows.len());
                rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2))).collect::<Vec<_>>()
            })
        };
        let found = schedules(2, "after connect");
        assert!(found[0].0.ends_with(".calendar-monitor") && found[0].1 == "*/30 * * * *", "{found:?}");
        assert!(found[1].0.ends_with(".email-monitor") && found[1].1 == "*/15 * * * *", "{found:?}");
        for (_, _, payload) in &found {
            assert!(!payload.contains("BODY-SENTINEL") && !payload.contains(MARKER_TOKEN), "private text in a schedule: {payload}");
        }
        let (status, text) = call(Method::POST, &format!("/accounts/{google_account}/revoke"), Some(&cookie), None);
        assert_eq!(status, 200, "{text}");
        schedules(0, "after revoke");
        println!("PASS monitor schedules on the real server: email 15 min and calendar 30 min per Google account, removed on revoke");
        let password = mail_lines["password"].clone();
        assert!(!log().contains(&password), "mail password in the server log");
        for word in ["PLAN-BODY-SENTINEL", "LUNCH-BODY-SENTINEL", "INVOICE-BODY-SENTINEL", "CHANGED-BODY-SENTINEL"] {
            assert!(!log().contains(word), "mail text {word} in the server log");
        }
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db
                .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')", &[])
                .await
                .unwrap();
            for row in tables {
                let (schema, name): (String, String) = (row.get(0), row.get(1));
                if (schema.as_str(), name.as_str()) == ("app", "email_messages") {
                    continue;
                }
                for word in [password.as_str(), "BODY-SENTINEL"] {
                    let hits: i64 = db
                        .query_one(&format!("SELECT count(*) FROM \"{schema}\".\"{name}\" t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'"), &[&word])
                        .await
                        .unwrap()
                        .get(0);
                    assert_eq!(hits, 0, "{word} found in {schema}.{name}");
                }
            }
        });
        println!("PASS mail sync on the real server: three messages cached through Email, a rewritten one replaced, a removed one gone, only the changed one fetched again, sync recorded as success; mail text and password absent from the log and every row outside Email's own cache, including job payloads and activity");
        // Outlook calendar: the stand-in page is read through the helper binding and its
        // events reach Calendar. Signing the page out stops the reader.
        let outlook = |method: reqwest::Method, path: &str| json_of(&call(method, &format!("/outlook-calendar{path}"), Some(&cookie), None).1);
        let wait_state = |want: &str| {
            let started = Instant::now();
            loop {
                let shown = outlook(Method::GET, "");
                if shown["state"] == want {
                    return shown;
                }
                assert!(started.elapsed() < Duration::from_secs(120), "Outlook never reached {want}: {shown}\n{}", log());
                std::thread::sleep(Duration::from_millis(500));
            }
        };
        assert_eq!(outlook(Method::GET, "")["available"], true);
        outlook(Method::POST, "/connect");
        let current = wait_state("current");
        let titles: Vec<String> = saved_events().iter().filter_map(|e| e["title"].as_str().map(String::from)).collect();
        assert!(titles.iter().any(|t| t == "Invented standup") && titles.iter().any(|t| t == "Invented review"), "{titles:?}");
        for word in ["Invented standup", "Invented review"] {
            assert!(!log().contains(word), "Outlook page text {word} in the server log");
        }
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            for table in ["moss_queue.jobs", "moss_queue.schedules"] {
                let hits: i64 = db
                    .query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%Invented%' OR to_jsonb(t)::text LIKE '%person@example.invalid%'"), &[])
                    .await
                    .unwrap()
                    .get(0);
                assert_eq!(hits, 0, "Outlook page text found in {table}");
            }
        });
        {
            use std::io::Write;
            writeln!(outlook_commands, "sign-out").unwrap();
            outlook_commands.flush().unwrap();
        }
        outlook(Method::POST, "/refresh");
        wait_state("sign-in-needed");
        let gone = outlook(Method::POST, "/disconnect");
        assert_eq!(gone["state"], "disconnected", "{gone}");
        println!("PASS Outlook calendar on the real server: stand-in page read week by week, events in Calendar, state {}, page text absent from the log and every job and schedule row, sign-out stops the reader, disconnect works", current["state"]);
    }
    drop(fake_outlook);
    drop(fake_mail);
    drop(fake_google);
    if let Ok(seconds) = std::env::var("MOSS_CONNECTORS_HOLD_SECONDS") {
        println!("HOLD {origin} for {seconds}s");
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }
    println!("NOT PROVEN: a second person over HTTP (setup allows one owner; proven in the database test), a second physical device, a real mail provider, the STARTTLS upgrade");
}
const MARKER: &str = "SENTINEL-PASSWORD-7f3a";
const MARKER_TOKEN: &str = "SENTINEL-ACCESS-TOKEN-91bc";
const MARKER_REFRESH: &str = "SENTINEL-REFRESH-TOKEN-02de";
