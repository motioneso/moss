//! Real HTTPS server with Email, Connectors, Calendar and Tasks installed, talking to a real GreenMail
//! container (plain IMAP 3143, SMTP 3025 on this machine). No stand-in mail server, no rewritten responses.
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
fn imap_account_on_greenmail_syncs_reads_and_refreshes_on_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    // Whole-test watchdog. A hang anywhere (server start, a read, the browser) ends the
    // process with a clear message instead of blocking the gate.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(900));
        eprintln!("WATCHDOG: the GreenMail live test ran longer than 900s and was stopped");
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
                .args(["claim", &format!("js324-greenmail-{}", std::process::id())])
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
    let _ = (&owner, &access);
    let imap_port: u16 = std::env::var("GREENMAIL_IMAP_PORT").unwrap_or("3143".into()).parse().unwrap();
    let smtp_port: u16 = std::env::var("GREENMAIL_SMTP_PORT").unwrap_or("3025".into()).parse().unwrap();
    let username = "probe@greenmail.test";
    let password = "probe-pw";
    let run = format!("{:x}", std::process::id());
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,
            "test_only_mail":{"imap_port":imap_port,"imap_tls":false,"smtp_port":smtp_port,"smtp_security":"none"}}),
    );
    let _server = start(true);
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/connectors{path}")).header("origin", &origin);
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
    let get_email = |path: &str| {
        let r = client.get(format!("{origin}/api/m/email{path}")).header("origin", &origin).header("cookie", &cookie).send().unwrap();
        (r.status().as_u16(), r.text().unwrap_or_default())
    };
    // Mail goes into GreenMail the way any outside sender would deliver it: plain SMTP.
    let deliver = |subject: &str, body: &str| {
        use std::io::{BufRead, BufReader, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", smtp_port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        let mut line = String::new();
        let mut step = |send: Option<&str>| {
            if let Some(text) = send {
                s.write_all(text.as_bytes()).unwrap();
            }
            loop {
                line.clear();
                r.read_line(&mut line).unwrap();
                if line.len() < 4 || line.as_bytes()[3] != b'-' {
                    break;
                }
            }
            assert!(line.starts_with('2') || line.starts_with('3'), "SMTP refused: {line}");
        };
        step(None);
        step(Some("HELO live.test\r\n"));
        step(Some("MAIL FROM:<ann@greenmail.test>\r\n"));
        step(Some(&format!("RCPT TO:<{username}>\r\n")));
        step(Some("DATA\r\n"));
        step(Some(&format!("From: Ann Lee <ann@greenmail.test>\r\nTo: {username}\r\nSubject: {subject}\r\nMessage-ID: <{run}-{}@greenmail.test>\r\n\r\n{body}\r\n.\r\n", subject.len())));
        step(Some("QUIT\r\n"));
    };
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/providers", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(get_email("/messages").0, 200, "warm the Email component");
    let mut seen: Vec<String> = vec![];
    let good = json!({"providerId":"imap-fastmail","username":username,"password":password});
    let wrong = json!({"providerId":"imap-fastmail","username":username,"password":"not-the-password"});
    let tested = call(Method::POST, "/imap/test-connection", Some(&cookie), Some(good.clone()));
    assert_eq!((tested.0, json_of(&tested.1)), (200, json!({"result":"ok"})), "{}", tested.1);
    let refused = call(Method::POST, "/imap/test-connection", Some(&cookie), Some(wrong.clone()));
    assert_eq!((refused.0, json_of(&refused.1)), (200, json!({"result":"auth_failed"})), "{}", refused.1);
    println!("PASS sign-in test against GreenMail: right password ok, wrong password refused");
    // Mail already waiting before the account is connected.
    let s1 = format!("Quarterly plan {run}");
    let s2 = format!("Lunch on Friday {run}");
    let b1 = format!("GREEN-PLAN-BODY-{run}");
    let b2 = format!("GREEN-LUNCH-BODY-{run}");
    deliver(&s1, &b1);
    deliver(&s2, &b2);
    let connected = call(Method::POST, "/imap/connect", Some(&cookie), Some(good.clone()));
    assert_eq!(connected.0, 201, "{}", connected.1);
    seen.push(connected.1.clone());
    let account = json_of(&connected.1)["account"].clone();
    let listed = |want: &dyn Fn(&[Value]) -> bool| -> Vec<Value> {
        let started = Instant::now();
        loop {
            let (status, text) = get_email("/messages");
            let rows: Vec<Value> = if status == 200 { json_of(&text)["messages"].as_array().cloned().unwrap_or_default() } else { vec![] }
                .into_iter()
                .filter(|m| m["externalId"].as_str().is_some_and(|k| k.starts_with("imap:")))
                .collect();
            if want(&rows) {
                return rows;
            }
            if started.elapsed() > Duration::from_secs(90) {
                let accounts = call(Method::GET, "/accounts", Some(&cookie), None).1;
                panic!("mail sync did not settle; last {status} {text}\naccounts {accounts}\n{}", log());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    };
    let has = |rows: &[Value], subject: &str| rows.iter().any(|m| m["subject"] == subject);
    let first = listed(&|rows| has(rows, &s1) && has(rows, &s2));
    println!("PASS sync: {} IMAP messages saved, both new subjects present", first.len());
    // Read one message in full through its own route, and search the saved list by body text.
    let plan = first.iter().find(|m| m["subject"] == s1.as_str()).unwrap();
    assert!(plan["snippet"].as_str().unwrap().contains(&b1), "{plan}");
    let id = plan["id"].as_str().unwrap_or_else(|| panic!("no id in {plan}")).to_owned();
    let (status, text) = get_email(&format!("/messages/{id}"));
    assert_eq!(status, 200, "{text}");
    assert!(text.contains(&s1) && text.contains(&b1) && text.contains("ann@greenmail.test"), "{text}");
    println!("PASS read: one message opened by id with subject, sender and body");
    let hits: Vec<&Value> = first.iter().filter(|m| m["snippet"].as_str().is_some_and(|s| s.contains(&b2))).collect();
    assert_eq!(hits.len(), 1, "a body-text search over the saved list finds exactly the lunch message");
    println!("PASS search (over saved mail, by body text): exactly one hit");
    // New mail arriving later is picked up by Today's refresh.
    let s3 = format!("Invoice reminder {run}");
    deliver(&s3, &format!("GREEN-INVOICE-BODY-{run}"));
    let key = "6c2a7b8f-4d3e-4f90-8b1c-2d3e4f5a6b7c";
    let (status, text) = call(Method::POST, "/email-refresh", Some(&cookie), Some(json!({"idempotencyKey": key})));
    assert_eq!(status, 202, "{text}");
    let refresh_id = json_of(&text)["refreshId"].as_str().unwrap().to_owned();
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
    let after = listed(&|rows| has(rows, &s3));
    println!("PASS later mail: refresh {done} brought in the new message ({} saved)", after.len());
    let (status, text) = call(Method::GET, "/accounts", Some(&cookie), None);
    assert_eq!(status, 200);
    seen.push(text.clone());
    let acct = json_of(&text)["accounts"].as_array().unwrap().iter().find(|a| a["providerId"] == "imap-fastmail").unwrap().clone();
    assert_eq!(acct["lastSyncStatus"], "success", "{acct}");
    assert_eq!(account["providerId"], "imap-fastmail");
    for body in &seen {
        assert!(!body.contains(password), "mail password in a response");
    }
    assert!(!log().contains(password), "mail password in the server log");
    println!("PASS the mail password is absent from every response and the server log");
    if let Ok(seconds) = std::env::var("MOSS_CONNECTORS_HOLD_SECONDS") {
        println!("HOLD {origin} for {seconds}s");
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }
    println!("NOT PROVEN: real Google sign-in, STARTTLS or implicit TLS to a mail server, a second person over HTTP, send and reply through the server (no HTTP route exists, see the host-level test)");
}
