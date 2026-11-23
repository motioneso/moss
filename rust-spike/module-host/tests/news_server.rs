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
    if let Ok(shell_web) = std::env::var("NEWS_LIVE_WEB") {
        // A built shell, so the screen opens inside the real app frame.
        let status = Command::new("cp").args(["-r", "-T", &shell_web]).arg(root.join("web")).status().unwrap();
        assert!(status.success());
    } else {
        fs::write(
            root.join("web/index.html"),
            "<!doctype html><title>News HTTP fixture</title>",
        )
        .unwrap();
        if std::env::var("NEWS_SCREEN_HOLD").is_ok() {
            // The browser check opens the screens through the shell's own frame page.
            for name in ["module-frame.html", "module-frame.css", "module-frame.js"] {
                fs::copy(
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("../shell/assets").join(name),
                    root.join("web").join(name),
                )
                .unwrap();
            }
        }
    }
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
    assert!(matches!(read["refresh"]["state"].as_str(), Some("idle" | "queued" | "running")), "{text}");
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
    // The overview compiles the page from the real sources on the real server. Nothing is
    // intercepted: the catalog and saved feeds are read live through the public-web fetch.
    // The first read queues a refresh. The server's own worker runs it, and the page appears once
    // the refresh state is idle again.
    let (status, text) = call(Method::GET, "/overview", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let waited = std::time::Instant::now();
    let overview = loop {
        let (_, text) = call(Method::GET, "/overview", Some(&cookie), None);
        let page = json_of(&text);
        let (_, p) = call(Method::GET, "/personalization", Some(&cookie), None);
        let state = json_of(&p)["refresh"]["state"].clone();
        if state == json!("idle") && !page["rankedStories"].as_array().map_or(true, |s| s.is_empty()) {
            break page;
        }
        assert!(waited.elapsed() < Duration::from_secs(180), "the refresh never finished (state {state})\n{}", log());
        std::thread::sleep(Duration::from_secs(3));
    };
    let stories = overview["rankedStories"].as_array().expect("ranked stories");
    assert!(!overview["topStories"].as_array().unwrap().is_empty(), "{overview}");
    assert_eq!(overview["degraded"], json!(false), "{overview}");
    println!("news live: the queued refresh compiled {} real stories, first: {}", stories.len(), stories[0]["title"]);
    // Pictures and icons come back from the real server as real bytes. The shell re-checks them.
    let raw = |path: &str, cookie: &str| {
        let response = client.get(format!("{origin}{path}")).header("origin", &origin).header("cookie", cookie).send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let kind = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let cache = response.headers().get("cache-control").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        (status, kind, cache, response.bytes().unwrap_or_default().to_vec())
    };
    let with_picture: Vec<&Value> = stories.iter().filter(|s| s["imageUrl"].is_string()).collect();
    println!("news live: {} of {} real stories carry a picture address", with_picture.len(), stories.len());
    let mut served = 0;
    let mut served_id = String::new();
    for story in with_picture.iter().take(6) {
        let id = story["id"].as_str().unwrap();
        let (status, kind, cache, bytes) = raw(&format!("/api/m/news/images/{id}"), &cookie);
        println!("news live: picture for story -> {status} {kind} {} bytes ({cache})", bytes.len());
        if status == 200 {
            assert!(kind.starts_with("image/") && cache.starts_with("private, max-age="), "{kind} {cache}");
            assert!(bytes.starts_with(&[0xff, 0xd8, 0xff]) || bytes.starts_with(b"\x89PNG") || bytes.starts_with(b"GIF8") || (bytes.len() > 12 && &bytes[8..12] == b"WEBP"), "bytes are a real picture");
            // The other person may have compiled the same public story into their own page. They
            // get a picture only for a story their own page holds.
            let theirs = json_of(&call(Method::GET, "/overview", Some(&other), None).1);
            let held = theirs["rankedStories"].as_array().is_some_and(|l| l.iter().any(|s| s["id"] == story["id"]));
            let expect = if held { 200 } else { 404 };
            assert_eq!(raw(&format!("/api/m/news/images/{id}"), &other).0, expect, "another person's picture follows their own page");
            served += 1;
            served_id = id.to_owned();
        }
    }
    if !with_picture.is_empty() {
        assert!(served > 0, "no real picture could be served\n{}", log());
        assert_eq!(raw(&format!("/api/news/images/{served_id}"), &cookie).0, 200, "the old picture address still works");
    }
    assert_eq!(raw("/api/m/news/images/not-a-story", &cookie).0, 404);
    let (icon_status, icon_kind, _, icon_bytes) = raw("/api/m/news/favicon/feeds.bbci.co.uk", &cookie);
    println!("news live: icon for the saved publisher -> {icon_status} {icon_kind} {} bytes", icon_bytes.len());
    // The feed host itself publishes no icon (the real site answers 404), so the saved feed has
    // none. The catalog publisher's own site has one and it must arrive as a real icon.
    assert_eq!(icon_status, 404, "the feed host has no icon, so none is served");
    let (status, kind, _, bytes) = raw("/api/m/news/favicon/www.bbc.com", &cookie);
    println!("news live: icon for the catalog publisher -> {status} {kind} {} bytes", bytes.len());
    assert_eq!(status, 200, "the catalog publisher's icon is served");
    assert!(kind.starts_with("image/") && bytes.len() > 100, "{kind}");
    assert_eq!(raw("/api/m/news/favicon/www.bbc.com", &other).0, 200, "a catalog publisher is not private data");
    assert_eq!(raw("/api/m/news/favicon/unsaved.example.org", &cookie).0, 404, "an unseen publisher is refused");
    assert_eq!(raw("/api/m/news/favicon/feeds.bbci.co.uk", &other).0, 404, "another person has no such publisher");
    // Story feedback on the real server. A story marked "less" leaves the owner's overview and
    // stays on the other person's page.
    let first = stories[0]["id"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::POST, "/story-feedback", Some(&cookie), Some(json!({"storyRef":first,"kind":"less_like_this","reason":"live check"})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let feedback_id = json_of(&text)["feedback"]["id"].as_str().unwrap().to_owned();
    let (_, text) = call(Method::GET, "/overview", Some(&cookie), None);
    let ids = |text: &str| -> Vec<String> { json_of(text)["rankedStories"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect() };
    assert!(!ids(&text).contains(&first), "the marked story is left out of the owner's overview");
    let (_, text) = call(Method::GET, "/story-feedback", Some(&other), None);
    assert_eq!(json_of(&text)["feedback"], json!([]), "{text}");
    assert_eq!(call(Method::PATCH, &format!("/story-feedback/{feedback_id}"), Some(&other), Some(json!({"reason":"x"}))).0, 404);
    assert_eq!(call(Method::POST, &format!("/story-feedback/{feedback_id}/undo"), Some(&other), None).0, 404);
    assert_eq!(call(Method::POST, &format!("/story-feedback/{feedback_id}/undo"), Some(&cookie), None).0, 200);
    let (_, text) = call(Method::GET, "/overview", Some(&cookie), None);
    assert!(ids(&text).contains(&first), "undo brings the story back");
    println!("news live: story feedback hid the story for the owner only and undo brought it back");
    // The News screen and the Today widget are declared screens. The shell resolves each to a
    // package page whose security policy lets the sandboxed frame show the pictures it is handed.
    for (path, title_word) in [("/news", "News"), ("/news/today-widget", "News")] {
        let response = client
            .get(format!("{origin}/api/modules/news/screen?path={path}"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(response.status().as_u16(), 200, "screen {path}\n{}", log());
        let screen = json_of(&response.text().unwrap());
        assert!(screen["title"].as_str().unwrap_or("").contains(title_word), "{screen}");
        let page = client
            .get(format!("{origin}{}", screen["src"].as_str().unwrap()))
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(page.status().as_u16(), 200, "page for {path}");
        let policy = page.headers().get("content-security-policy").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        assert!(policy.contains("img-src") && policy.contains("data:"), "{policy}");
        assert!(policy.contains("default-src 'none'"), "{policy}");
    }
    println!("news live: both News screens resolve and carry the frame policy");
    // For the browser check, keep the server up until the named file appears. The login is written
    // beside it. Nothing else changes.
    if let Ok(hold) = std::env::var("NEWS_SCREEN_HOLD") {
        let hold = std::path::PathBuf::from(hold);
        fs::write(
            hold.with_extension("json"),
            json!({"origin":origin,"email":"news-owner@example.test","password":"temporary-news-password-276-not-a-real-secret","certificate":cert}).to_string(),
        )
        .unwrap();
        fs::write(hold.with_extension("ready"), "ready").unwrap();
        while !hold.exists() {
            std::thread::sleep(Duration::from_secs(2));
        }
    }
    // The refresh left a success time and the other person has no refresh record of their own work.
    let rows = |sql: &'static str, who: uuid::Uuid| -> Vec<tokio_postgres::Row> {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            db.query(sql, &[&who]).await.unwrap()
        })
    };
    let done = rows("SELECT last_success_at IS NOT NULL, compiled_generation = requested_generation FROM app.news_refresh_state WHERE owner_user_id=$1", owner);
    assert_eq!((done[0].get::<_, bool>(0), done[0].get::<_, bool>(1)), (true, true));
    println!("news live: refresh history shows a success for the owner");
    // A check of the saved sites through the real route and the server's worker.
    let (status, text) = call(Method::POST, "/revalidation", Some(&cookie), None);
    assert_eq!((status, json_of(&text)["queued"].clone()), (202, json!(true)), "{text}");
    let waited = std::time::Instant::now();
    loop {
        let open = rows("SELECT 1 FROM moss_queue.jobs WHERE actor_user_id=$1 AND queue LIKE '%.news-revalidate' AND state IN ('pending','running')", owner);
        if open.is_empty() {
            break;
        }
        assert!(waited.elapsed() < Duration::from_secs(180), "the check never finished\n{}", log());
        std::thread::sleep(Duration::from_secs(2));
    }
    let (_, text) = call(Method::GET, "/personalization", Some(&cookie), None);
    let health = json_of(&text)["customSources"][0]["healthStatus"].clone();
    let stored = rows("SELECT health_status FROM app.news_custom_sources WHERE owner_user_id=$1", owner);
    assert_eq!(health, json!(stored[0].get::<_, String>(0)), "the page shows the stored health");
    println!("news live: after a real check the saved feed shows health {health}, read from the stored record");
    let other_id: uuid::Uuid = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.query_one("SELECT id FROM app.users WHERE email='news-other@example.test'", &[]).await.unwrap().get(0)
    });
    // The other person's own reads queue their own jobs. Every job in the queue, theirs and the
    // owner's, carries only the queue name and one fixed word.
    let jobs = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.query("SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%.news-%'", &[]).await.unwrap()
    });
    assert!(!jobs.is_empty());
    for row in &jobs {
        let text: String = row.get(0);
        assert!(!text.to_lowercase().contains(&MARK.to_lowercase()) && !text.contains("bbci"), "job payload {text}");
        let payload: Value = serde_json::from_str(&text).unwrap();
        assert!(matches!(payload["params"], Value::Object(ref m) if m.len() == 1 && m.contains_key("kind")), "{text}");
    }
    let _ = other_id;
    println!("news live: {} queued News jobs, all metadata only", jobs.len());

    // Hold the server open so the real screen can be opened in a browser with the real data above.
    if let Ok(hold) = std::env::var("NEWS_LIVE_HOLD") {
        // A real model through the local test endpoint with the person's own stored provider, so a
        // new site can get its policy verdict from a model. The key is read from its config file and
        // never printed.
        let key_path = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/cliproxyapi/client-key");
        if let (Ok(model_name), Ok(key)) = (std::env::var("NEWS_LIVE_MODEL"), fs::read_to_string(&key_path)) {
            let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
                .unwrap()
                .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new(key.trim())));
            let provider: uuid::Uuid = uuid::Uuid::new_v4();
            let model: uuid::Uuid = uuid::Uuid::new_v4();
            runtime.block_on(async {
                let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
                tokio::spawn(async move { let _ = connection.await; });
                db.execute(
                    "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Test endpoint','http://127.0.0.1:5190',$3,true)",
                    &[&provider, &owner, &sealed],
                ).await.unwrap();
                db.execute(
                    "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,$4,'Test model',ARRAY['chat','json'])",
                    &[&model, &provider, &owner, &model_name],
                ).await.unwrap();
            });
            println!("news live: a real model ({model_name}) is set up for the hold");
        }
        fs::write(format!("{hold}/ready.txt"), format!("{origin}\n{cookie}\n{origin}/module-frame?module=news&path=/settings/news\n")).unwrap();
        while !std::path::Path::new(&format!("{hold}/stop")).exists() {
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    // Nothing the test sent reached the server log.
    assert!(!log().to_lowercase().contains(&MARK.to_lowercase()));
    println!("news live: choices, exclusions and topics for two people worked over HTTPS");
}
