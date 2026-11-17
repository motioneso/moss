//! Installed Email package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Email live gate"]
fn installed_email_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js225-email-{}", std::process::id())])
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
        "<!doctype html><title>Email HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-email-signing-secret-225","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-email-password-225-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("email-owner@example.test", "Email owner");
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
                "SELECT id FROM app.users WHERE email='email-owner@example.test'",
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
    let access = AccessContext::new(owner, "email-install");
    // Publish the Email package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS225_EMAIL_PACKAGE", "email"), ("JS224_CONNECTORS_PACKAGE", "connectors")]
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
            publisher_key: "email-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Email live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "email-test-registry".into(),
        name: "Email test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "email-test".into(),
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
            "email-test-registry",
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
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/email{path}"))
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
    // Fixture writer: the connector account and one message are written with the bootstrap
    // connection, because nothing in this package syncs mail.
    let message_id = uuid::Uuid::new_v4();
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let account = uuid::Uuid::new_v4();
        db.execute(
            "INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,scopes,status,encrypted_secret,created_at,updated_at) VALUES($1,'google',$2,ARRAY['https://www.googleapis.com/auth/gmail.modify'],'active','{}'::jsonb,now(),now())",
            &[&account, &owner],
        ).await.unwrap();
        db.execute(
            "INSERT INTO app.email_messages(id,connector_account_id,owner_user_id,sender,recipients,subject,snippet,body_excerpt,received_at,external_id) VALUES($1,$2,$3,$4,ARRAY[$5::text],'Live subject','Live snippet',$6,now(),'live-1')",
            &[&message_id, &account, &owner, &MARKER_ADDRESS, &MARKER_ADDRESS, &MARKER_BODY],
        ).await.unwrap();
    });
    let mut seen: Vec<String> = vec![];
    assert_eq!(call(Method::GET, "/messages", None, None).0, 401);
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/messages", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!(status, 200, "{text}\n{}", log());
    let listed = json_of(&text);
    assert_eq!(listed["messages"].as_array().map(Vec::len), Some(1), "{text}");
    assert_eq!(listed["messages"][0]["id"], message_id.to_string(), "{text}");
    assert_eq!(listed["messages"][0]["subject"], "Live subject", "{text}");
    let (status, text) = call(Method::GET, &format!("/messages/{message_id}"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["message"]["id"], message_id.to_string(), "{text}");
    let missing = uuid::Uuid::new_v4();
    let (status, text) = call(Method::GET, &format!("/messages/{missing}"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (404, json!({"error":"Email message not found"})));
    // Settings: defaults, a change, then the change read back.
    let (status, text) = call(Method::GET, "/briefing-settings", Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"settings":{"createTasks":true,"suggestReplies":true,"draftReplies":true,"autoSend":false}})), "{text}");
    let (status, text) = call(Method::PATCH, "/briefing-settings", Some(&cookie), Some(json!({"autoSend":true,"draftReplies":false})));
    assert_eq!((status, json_of(&text)), (200, json!({"settings":{"createTasks":true,"suggestReplies":true,"draftReplies":false,"autoSend":true}})), "{text}");
    let (status, text) = call(Method::GET, "/briefing-settings", Some(&cookie), None);
    assert_eq!(json_of(&text)["settings"]["autoSend"], true, "{status} {text}");
    let (status, text) = call(Method::GET, "/task-creation-mode", Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"mode":"suggest"})), "{text}");
    let (status, text) = call(Method::PUT, "/task-creation-mode", Some(&cookie), Some(json!({"mode":"auto_safe"})));
    assert_eq!((status, json_of(&text)), (200, json!({"mode":"auto_safe"})), "{text}");
    assert_eq!(json_of(&call(Method::GET, "/task-creation-mode", Some(&cookie), None).1), json!({"mode":"auto_safe"}));
    assert_eq!(call(Method::PUT, "/task-creation-mode", Some(&cookie), Some(json!({"mode":"loud"}))).0, 400);
    assert_eq!(json_of(&call(Method::GET, "/briefing-source", Some(&cookie), None).1), json!({"enabled":true}));
    assert_eq!(json_of(&call(Method::PUT, "/briefing-source", Some(&cookie), Some(json!({"enabled":false}))).1), json!({"enabled":false}));
    assert_eq!(json_of(&call(Method::GET, "/briefing-source", Some(&cookie), None).1), json!({"enabled":false}));
    assert_eq!(json_of(&call(Method::GET, "/draft-policy", Some(&cookie), None).1), json!({"tier":"ask_each_time"}));
    assert_eq!(json_of(&call(Method::PUT, "/draft-policy", Some(&cookie), Some(json!({"tier":"trusted_auto"}))).1), json!({"tier":"trusted_auto"}));
    assert_eq!(json_of(&call(Method::GET, "/draft-policy", Some(&cookie), None).1), json!({"tier":"trusted_auto"}));
    // Understanding: the one cached message was sent by the person's own address, so the pass
    // settles it without any model call and a second pass finds nothing left to do.
    assert_eq!(call(Method::POST, "/understand", None, Some(json!({}))).0, 401);
    let (status, text) = call(Method::POST, "/understand", Some(&cookie), Some(json!({})));
    assert_eq!((status, json_of(&text)), (200, json!({"analysed":1,"failed":0,"needsConfiguration":false})), "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/understand", Some(&cookie), Some(json!({})));
    assert_eq!((status, json_of(&text)), (200, json!({"analysed":0,"failed":0,"needsConfiguration":false})), "{text}");
    seen.push(text);
    // Responses to settings calls and the not-found answer carry no message content.
    for (_, text) in [call(Method::GET, "/briefing-settings", Some(&cookie), None), call(Method::GET, "/task-creation-mode", Some(&cookie), None)] {
        seen.push(text);
    }
    seen.push(call(Method::GET, &format!("/messages/{missing}"), Some(&cookie), None).1);
    for body in &seen {
        for marker in [MARKER_BODY, MARKER_ADDRESS] {
            assert!(!body.contains(marker), "marker in a response that should not carry it: {body}");
        }
    }
    // The message body and address must be in no log line and no job or audit row.
    let markers = [MARKER_BODY, MARKER_ADDRESS];
    for marker in markers {
        assert!(!log().contains(marker), "marker in the server log");
    }
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let tables = db
            .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') AND (table_name ILIKE '%job%' OR table_name ILIKE '%audit%')", &[])
            .await
            .unwrap();
        assert!(tables.len() >= 2, "expected job and audit tables");
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
        // Control: the same search finds the values where they really are stored.
        for marker in markers {
            let control: i64 = db
                .query_one("SELECT count(*) FROM app.email_messages t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'", &[&marker])
                .await
                .unwrap()
                .get(0);
            assert_eq!(control, 1, "the search must find a stored value");
        }
    });
    println!("PASS Email routes on the real server: sign-in required, list, detail, unknown message 404, briefing settings, task mode, briefing source, draft policy; message body and address absent from the server log and every job and audit row");
    let screen_url = format!("{origin}/api/modules/email/screen?path=/settings/email");
    assert_eq!(client.get(&screen_url).send().unwrap().status(), 401);
    let screen: Value = client.get(&screen_url).header("cookie", &cookie).send().unwrap().json().unwrap();
    let src = screen["src"].as_str().expect("screen address");
    assert!(src.starts_with("/module-ui/email/"), "{screen}");
    assert_eq!(client.get(format!("{origin}{src}")).header("origin", "null").header("sec-fetch-site", "cross-site").send().unwrap().status(), 200);
    println!("PASS Email settings screen address and files served over HTTPS");
    {
        let script = std::env::var("MOSS_EMAIL_BROWSER_SCRIPT").expect("the gate must supply the browser script");
        let out = std::env::var("MOSS_EMAIL_BROWSER_OUT").unwrap_or_else(|_| root.display().to_string());
        let status = Command::new("pnpm")
            .args(["exec", "tsx", &script])
            .env("ORIGIN", &origin)
            .env("EMAIL", "email-owner@example.test")
            .env("PASSWORD", "temporary-email-password-225-not-a-real-secret")
            .env("OUT", out)
            .status()
            .unwrap();
        assert!(status.success(), "browser check failed\n{}", log());
    }
    if let Ok(seconds) = std::env::var("MOSS_EMAIL_HOLD_SECONDS") {
        println!("HOLD {origin} for {seconds}s");
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }
    println!("NOT PROVEN: a second person over HTTP (setup allows one owner; proven in the database test), a second physical device");
}
const MARKER_BODY: &str = "SENTINEL-BODY-text-5c1e";
const MARKER_ADDRESS: &str = "sentinel-address-3b7d@example.test";
