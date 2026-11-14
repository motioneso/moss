//! Installed News package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the News live gate"]
fn installed_news_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js276-news-{}", std::process::id())])
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
        "<!doctype html><title>News HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-news-signing-secret-276","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-news-password-276-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("news-owner@example.test", "News owner");
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
                "SELECT id FROM app.users WHERE email='news-owner@example.test'",
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
    let access = AccessContext::new(owner, "news-install");
    // Publish the News package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_NEWS_PACKAGE", "news")]
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
            publisher_key: "news-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "News live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "news-test-registry".into(),
        name: "News test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "news-test".into(),
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
            "news-test-registry",
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'News other', 'news-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"news-other@example.test","password":"temporary-news-password-276-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/news{path}")).header("origin", &origin);
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
    assert_eq!(call(Method::GET, "/prefs", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/news/prefs"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .is_ok_and(|r| r.status().as_u16() != 503);
        if ready {
            break;
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(240), "module host start deadline\n{}", log());
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/prefs", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text), json!({"prefs":[]}));
    }
    // The owner saves a choice twice and keeps one row.
    let (status, text) = call(Method::POST, "/prefs", Some(&cookie), Some(json!({"kind":"source","key":"bbc"})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let pref = json_of(&text)["pref"]["id"].as_str().unwrap().to_owned();
    let (_, again) = call(Method::POST, "/prefs", Some(&cookie), Some(json!({"kind":"source","key":"bbc"})));
    assert_eq!(json_of(&again)["pref"]["id"], json!(pref));
    let (_, list) = call(Method::GET, "/prefs", Some(&cookie), None);
    assert_eq!(json_of(&list)["prefs"].as_array().unwrap().len(), 1, "{list}");
    // The owner excludes a publisher. The typed text lands only in that row.
    let (status, text) = call(Method::POST, "/source-exclusions", Some(&cookie), Some(json!({"source":format!("{MARK}.example.com")})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let excl = json_of(&text)["exclusion"]["id"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::POST, "/source-exclusions", Some(&cookie), Some(json!({"source":"bad host name"})));
    assert_eq!(status, 400, "{text}");
    let (status, text) = call(Method::POST, "/topics", Some(&cookie), Some(json!({"label":"Space"})));
    assert_eq!(status, 503, "{text}");
    let (status, text) = call(Method::GET, "/personalization", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let read = json_of(&text);
    assert_eq!(read["sourceExclusions"].as_array().unwrap().len(), 1, "{text}");
    assert_eq!(read["refresh"]["state"], "idle", "{text}");
    // The other person sees none of it and cannot remove it.
    let (_, text) = call(Method::GET, "/personalization", Some(&other), None);
    assert_eq!(json_of(&text)["sourceExclusions"], json!([]), "{text}");
    assert!(!text.to_lowercase().contains(&MARK.to_lowercase()));
    let (status, text) = call(Method::DELETE, &format!("/source-exclusions/{excl}"), Some(&other), None);
    assert_eq!((status, json_of(&text)), (200, json!({"ok":false})));
    let (status, text) = call(Method::DELETE, &format!("/prefs/{pref}"), Some(&other), None);
    assert_eq!((status, json_of(&text)), (200, json!({"ok":false})));
    let (_, list) = call(Method::GET, "/prefs", Some(&cookie), None);
    assert_eq!(json_of(&list)["prefs"].as_array().unwrap().len(), 1, "B's delete must not remove A's choice");
    // The owner removes both.
    let (_, text) = call(Method::DELETE, &format!("/source-exclusions/{excl}"), Some(&cookie), None);
    assert_eq!(json_of(&text), json!({"ok":true}));
    let (_, text) = call(Method::DELETE, &format!("/prefs/{pref}"), Some(&cookie), None);
    assert_eq!(json_of(&text), json!({"ok":true}));
    // Adding a real public feed. The page and the feed are read from the real internet through the
    // server's own public-web fetch, with nothing rewritten on the way.
    const FEED: &str = "https://feeds.bbci.co.uk/news/rss.xml";
    let (status, text) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"input":FEED})));
    let first = json_of(&text);
    println!("news live: first preview with no model set up -> {status} {}", first["status"]);
    // This server has no text model, so a new site cannot get its policy verdict from one.
    assert_eq!((status, &first["status"]), (200, &json!("unavailable")), "{text}\n{}", log());
    // The person's own remembered verdict stands in for the model. The feed itself is still fetched live.
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.execute(
            "INSERT INTO app.news_policy_verdicts (owner_user_id, canonical_domain, fingerprint, verdict, expires_at) VALUES ($1, 'feeds.bbci.co.uk', 'host-ai-v1', 'approved', now() + interval '1 hour')",
            &[&owner],
        )
        .await
        .unwrap();
    });
    let (status, text) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"input":FEED})));
    let shown = json_of(&text);
    assert_eq!((status, &shown["status"]), (200, &json!("ok")), "{text}\n{}", log());
    assert_eq!(shown["candidates"][0]["retrievalMethod"], "feed", "{text}");
    println!("news live: real feed previewed: {}", shown["candidates"][0]["label"]);
    let confirmation = shown["confirmationId"].clone();
    let (status, text) = call(Method::POST, "/sources", Some(&other), Some(json!({"confirmationId":confirmation})));
    assert_eq!(status, 409, "another person must not save this preview: {text}");
    let (status, text) = call(Method::POST, "/sources", Some(&cookie), Some(json!({"confirmationId":confirmation})));
    assert_eq!(status, 201, "{text}\n{}", log());
    assert_eq!(json_of(&text)["source"]["canonicalDomain"], "feeds.bbci.co.uk");
    let (_, text) = call(Method::GET, "/personalization", Some(&cookie), None);
    assert_eq!(json_of(&text)["customSources"].as_array().unwrap().len(), 1, "{text}");
    let (_, text) = call(Method::GET, "/personalization", Some(&other), None);
    assert_eq!(json_of(&text)["customSources"], json!([]), "{text}");
    println!("news live: the real feed was saved for the owner and is invisible to the other person");

    // Nothing the test sent reached the server log.
    assert!(!log().to_lowercase().contains(&MARK.to_lowercase()));
    println!("news live: choices, exclusions and topics for two people worked over HTTPS");
}
