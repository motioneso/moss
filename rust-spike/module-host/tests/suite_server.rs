//! News, Sports, Weather and Briefings installed together from one signed registry and served by
//! the real HTTPS executable. Real ESPN, feeds, Reddit and Open-Meteo. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the suite live gate"]
fn installed_news_sports_weather_and_briefings_work_together() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js340-suite-{}", std::process::id())])
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
    // A second device reaches the same server by the LAN address when SUITE_LAN_HOST is set.
    let lan = std::env::var("SUITE_LAN_HOST").ok().map(|h| format!("https://{h}:{}", port.0));
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .args(lan.iter())
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
    if let Ok(shell_web) = std::env::var("MOSS_SHELL_WEB_DIR") {
        // The built app, so a held-open run can show Today and the module frames.
        let status = Command::new("cp")
            .args(["-r", &format!("{shell_web}/.")])
            .arg(root.join("web"))
            .status()
            .unwrap();
        assert!(status.success());
    } else {
        fs::write(
            root.join("web/index.html"),
            "<!doctype html><title>Suite HTTP fixture</title>",
        )
        .unwrap();
    }
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    let ai_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-weather-signing-secret-340","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("{}:{}",if lan.is_some() {"0.0.0.0"} else {"127.0.0.1"},port.0),"origins":std::iter::once(origin.clone()).chain(lan.clone()).collect::<Vec<_>>(),"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-suite-password-340-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("suite-owner@example.test", "Suite owner");
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
                "SELECT id FROM app.users WHERE email='suite-owner@example.test'",
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
    let access = AccessContext::new(owner, "suite-install");
    // Publish the Weather package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_WEATHER_PACKAGE", "weather"), ("JS235_NEWS_PACKAGE", "news"), ("JS235_SPORTS_PACKAGE", "sports"), ("JS235_BRIEFINGS_PACKAGE", "briefings")]
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
            publisher_key: "suite-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Suite live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "suite-test-registry".into(),
        name: "Suite test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "suite-test".into(),
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
            "suite-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    // Optional upgrade check. Rows copied from a dev owner are loaded for the test owner before the
    // server starts, so the packages open data an older install wrote.
    let copy = std::env::var("SUITE_DEV_COPY").ok();
    let seeded_topic = "Seeded upgrade topic";
    if let Some(path) = &copy {
        let sql = fs::read_to_string(path).unwrap().replace("__OWNER__", &owner.to_string());
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.batch_execute(&sql).await.unwrap();
            // The dev data holds no saved topic, so one is added the way the old app stored it.
            db.execute("INSERT INTO app.news_custom_topics (id, owner_user_id, label, guidance, validation_status, validation_fingerprint, validated_at) VALUES (gen_random_uuid(), $1, $2, 'upgrade check', 'approved', 'seeded', now())", &[&owner, &seeded_topic]).await.unwrap();
        });
    }
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key}),
    );
    // The model the owner configures is a small server in this process behind the real router.
    let requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    {
        let requests = requests.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Read, Write};
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0usize;
                let mut line = String::new();
                reader.read_line(&mut line).unwrap_or(0);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = header.to_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                requests.lock().unwrap().push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                let answer = json!({"choices":[{"message":{"content":"Steady morning.\n\n## Prepare\nBring notes at 9 AM. WRITTEN-BY-STANDIN-MODEL"}}]}).to_string();
                let mut stream = stream;
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
            }
        });
    }
    let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
        .unwrap()
        .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new("TEST-NOT-A-REAL-KEY-267")));
    let (provider, model) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        db.execute("INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Test provider',$3,$4,true)", &[&provider, &owner, &format!("http://127.0.0.1:{provider_port}"), &sealed]).await.unwrap();
        db.execute("INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'test-model-267','Test model',ARRAY['chat','json','summarization'])", &[&model, &provider, &owner]).await.unwrap();
    });
    let _server = start(true);
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |module: &str, method: reqwest::Method, path: &str, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/{module}{path}")).header("origin", &origin).header("cookie", &cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{module}{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{module}{path} -> {status}");
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    // The server answers 503 until its module host has finished starting.
    let started = Instant::now();
    for (module, path) in [("weather", "/unit"), ("news", "/prefs"), ("sports", "/follows"), ("briefings", "/definitions")] {
        // A request made while the module host starts can be held until the client times out.
        let mut last = String::from("no answer");
        while !client.get(format!("{origin}/api/m/{module}{path}")).header("origin", &origin).header("cookie", &cookie).send().map(|r| { let code = r.status().as_u16(); last = format!("status {code}"); code != 503 }).unwrap_or_else(|e| { last = e.to_string(); false }) {
            assert!(started.elapsed() < Duration::from_secs(600), "module host start deadline on {module}{path} ({last})\n{}", log());
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let count = |table: &str| -> i64 {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.query_one(&format!("SELECT count(*) FROM app.{table} WHERE owner_user_id = $1"), &[&owner]).await.unwrap().get(0)
        })
    };
    let len = |v: &Value, key: &str| v[key].as_array().map_or(0, |a| a.len() as i64);
    // Upgrade check: every copied row reads back through the new routes.
    if copy.is_some() {
        let (_, t) = call("sports", Method::GET, "/follows", None);
        assert_eq!(len(&json_of(&t), "follows"), count("sports_follows"), "{t}");
        let (_, t) = call("sports", Method::GET, "/sources", None);
        assert_eq!(len(&json_of(&t), "sources"), count("sports_custom_sources") + 1, "custom sources plus ESPN: {t}");
        let (_, t) = call("news", Method::GET, "/prefs", None);
        assert_eq!(len(&json_of(&t), "prefs"), count("news_prefs"), "{t}");
        let (_, t) = call("news", Method::GET, "/personalization", None);
        assert_eq!(len(&json_of(&t), "customSources"), count("news_custom_sources"), "{t}");
        assert!(t.contains(seeded_topic), "the saved topic is missing: {t}");
        let (_, t) = call("weather", Method::GET, "/location", None);
        let place = json_of(&t)["location"]["label"].as_str().unwrap_or_default().to_owned();
        assert!(!place.is_empty(), "the saved place is missing: {t}");
        let (_, t) = call("sports", Method::GET, "/standings-preferences", None);
        println!("upgrade: standings choices {t}");
        println!("UPGRADE KEPT: {} follows, {} sports sources, {} news sources, {} news choices, 1 topic, saved place present",
            count("sports_follows"), count("sports_custom_sources"), count("news_custom_sources"), count("news_prefs"));
    }
    // Weather: a saved place gives a real Open-Meteo reading.
    if copy.is_none() {
        let (status, text) = call("weather", Method::GET, "/location/search?query=Seattle", None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let first = json_of(&text)["candidates"][0].clone();
        assert_eq!(call("weather", Method::PUT, "/location", Some(first)).0, 200);
    }
    // The forecast service is sometimes unreachable from this machine. A refusal is retried, the real
    // answer is printed, and a service that stays down is reported as not proven.
    let mut weather_ok = false;
    for attempt in 1..=4 {
        let (status, text) = call("weather", Method::GET, "/today", None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let today = json_of(&text);
        if today["data"]["temp"].is_number() {
            println!("weather live: {} {}", today["data"]["location"], today["data"]["temp"]);
            let (status, text) = call("weather", Method::GET, "/forecast?startHour=8&endHour=20", None);
            assert_eq!(status, 200, "{text}");
            assert!(!json_of(&text)["forecast"]["intervals"].as_array().map_or(true, |a| a.is_empty()), "{text}");
            weather_ok = true;
            break;
        }
        println!("weather live: attempt {attempt} -> {text}");
        std::thread::sleep(Duration::from_secs(30));
    }
    if !weather_ok {
        println!("weather live: NOT PROVEN: the forecast service did not answer, so no real reading was taken");
    }
    // Sports: real ESPN follow, overview, standings and result.
    let (status, text) = call("sports", Method::POST, "/follows", Some(json!({"competitionKey":"nfl","teamKey":"dal"})));
    println!("sports follow dal -> {status} {}", text.chars().take(80).collect::<String>());
    // A cold overview over several followed leagues can be refused empty on its first try. Each try
    // fills the cache, so the status of every try is printed and the call is repeated.
    let (mut status, mut text) = (0, String::new());
    for attempt in 1..=6 {
        (status, text) = call("sports", Method::GET, "/overview", None);
        println!("sports overview attempt {attempt} -> {status} ({} bytes)", text.len());
        if status == 200 {
            break;
        }
    }
    assert_eq!(status, 200, "{text}\n{}", log());
    let overview = json_of(&text);
    assert!(overview["followed"].as_array().is_some_and(|c| !c.is_empty()), "{text}");
    assert!(overview["standings"].as_array().is_some_and(|s| !s.is_empty()), "{text}");
    println!("sports live: {} followed cards, degraded {}", len(&overview, "followed"), overview["degraded"]);
    let (status, text) = call("sports", Method::GET, "/standings?competitionKey=nfl", None);
    assert_eq!(status, 200, "{text}");
    assert!(json_of(&text)["group"]["sections"].as_array().is_some_and(|s| !s.is_empty()), "{text}");
    let (status, text) = call("sports", Method::GET, "/results/latest?competitionKey=nfl&teamName=dallas", None);
    assert_eq!(status, 200, "{text}");
    println!("sports live: latest result {}", json_of(&text)["status"]);
    // Sports: a real subreddit. Reddit refuses this machine now and then, so each answer is printed.
    for attempt in 1..=4 {
        let (status, text) = call("sports", Method::POST, "/sources/preview", Some(json!({"url":"r/nfl","assignments":[{"target":{"kind":"sport","sportKey":"football"}}]})));
        let shown = json_of(&text);
        println!("sports live: reddit preview attempt {attempt} -> {status} {}", text.chars().take(600).collect::<String>());
        if status == 200 && shown["status"] == "ok" {
            break;
        }
        std::thread::sleep(Duration::from_secs(20));
    }
    // News: a real feed. The person's own remembered verdict stands in for the model.
    const FEED: &str = "https://feeds.bbci.co.uk/news/rss.xml";
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        db.execute("INSERT INTO app.news_policy_verdicts (owner_user_id, canonical_domain, fingerprint, verdict, expires_at) VALUES ($1, 'feeds.bbci.co.uk', 'host-ai-v1', 'approved', now() + interval '1 hour') ON CONFLICT DO NOTHING", &[&owner]).await.unwrap();
    });
    let (status, text) = call("news", Method::POST, "/sources/preview", Some(json!({"input":FEED})));
    let shown = json_of(&text);
    assert_eq!((status, &shown["status"]), (200, &json!("ok")), "{text}\n{}", log());
    println!("news live: real feed previewed: {}", shown["candidates"][0]["label"]);
    let waited = Instant::now();
    let page = loop {
        let (_, text) = call("news", Method::GET, "/overview", None);
        let page = json_of(&text);
        let (_, p) = call("news", Method::GET, "/personalization", None);
        if json_of(&p)["refresh"]["state"] == json!("idle") && !page["rankedStories"].as_array().map_or(true, |s| s.is_empty()) {
            break page;
        }
        assert!(waited.elapsed() < Duration::from_secs(240), "the news refresh never finished\n{}", log());
        std::thread::sleep(Duration::from_secs(3));
    };
    println!("news live: {} real stories, first: {}", len(&page, "rankedStories"), page["rankedStories"][0]["title"]);
    // Briefings with all three installed. The model is the stand-in, so the prompt it receives shows
    // what the briefing gathered from Weather, Sports and News.
    let (status, text) = call("briefings", Method::POST, "/definitions", Some(json!({"title":"Suite morning","briefingType":"morning","cadence":"manual"})));
    assert_eq!(status, 201, "{text}\n{}", log());
    let id = json_of(&text)["definition"]["id"].as_str().unwrap().to_owned();
    let before = requests.lock().unwrap().len();
    let (status, text) = call("briefings", Method::POST, &format!("/definitions/{id}/run"), Some(json!({})));
    assert_eq!(status, 202, "{text}\n{}", log());
    let queued = json_of(&text);
    let (job, run) = (queued["jobId"].as_str().unwrap().to_owned(), queued["runId"].as_str().unwrap().to_owned());
    let waited = Instant::now();
    let state = loop {
        let (_, t) = call("briefings", Method::GET, &format!("/definitions/{id}/runs/{run}?jobId={job}"), None);
        let state = json_of(&t)["state"].as_str().unwrap_or_default().to_owned();
        if state != "pending" || waited.elapsed() > Duration::from_secs(180) {
            break state;
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    assert_eq!(state, "ready", "{}", log());
    let (_, t) = call("briefings", Method::GET, &format!("/definitions/{id}/runs/{run}"), None);
    let detail = json_of(&t);
    println!("briefings source metadata: {}", detail["run"]["sourceMetadata"]);
    let sent = requests.lock().unwrap().clone();
    assert!(sent.len() > before, "the briefing never reached the model");
    let prompt = sent[before]["messages"][0]["content"].as_str().unwrap_or_default().to_owned();
    fs::write(root.join("briefing-prompt.txt"), &prompt).unwrap();
    if let Ok(keep) = std::env::var("SUITE_PROMPT_COPY") {
        fs::write(keep, &prompt).unwrap();
    }
    let lower = prompt.to_lowercase();
    for (name, word) in [("weather", "weather"), ("sports", "cowboys"), ("news", "news")] {
        println!("briefing prompt mentions {name}: {}", lower.contains(word));
    }
    println!("briefing prompt length: {}", prompt.len());
    // The briefing must carry each module's own block. Sports may read "none today" on a day with no game.
    assert!(prompt.contains("<external_source type=\"news\">\n- "), "no news headlines reached the prompt");
    assert!(prompt.contains("<external_source type=\"sports\">"), "no sports block reached the prompt");
    if weather_ok {
        assert!(prompt.contains("<external_source type=\"weather\">"), "no weather block reached the prompt");
    }
    for line in prompt.lines().filter(|l| { let l = l.to_lowercase(); l.contains("sport") || l.contains("follow") || l.contains("nfl") || l.contains("gap") }).take(12) {
        println!("prompt sports line: {}", line.chars().take(240).collect::<String>());
    }
    // Optional real-model pass through a local OpenAI-compatible proxy. The key comes from a file.
    if let (Ok(url), Ok(key_file), Ok(model_name)) = (std::env::var("BRIEFINGS_REAL_MODEL_URL"), std::env::var("BRIEFINGS_REAL_MODEL_KEY_FILE"), std::env::var("BRIEFINGS_REAL_MODEL_NAME")) {
        let real_key = fs::read_to_string(key_file).unwrap().trim().to_owned();
        let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
            .unwrap()
            .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new(&real_key)));
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.execute("UPDATE app.ai_provider_configs SET base_url=$1, encrypted_credential=$2 WHERE id=$3", &[&url, &sealed, &provider]).await.unwrap();
            db.execute("UPDATE app.ai_configured_models SET provider_model_id=$1 WHERE id=$2", &[&model_name, &model]).await.unwrap();
        });
        let (_, text) = call("briefings", Method::POST, &format!("/definitions/{id}/run"), Some(json!({})));
        let queued = json_of(&text);
        let (job, run) = (queued["jobId"].as_str().unwrap_or_default().to_owned(), queued["runId"].as_str().unwrap_or_default().to_owned());
        let waited = Instant::now();
        let mut poll_text = String::new();
        loop {
            let (_, t) = call("briefings", Method::GET, &format!("/definitions/{id}/runs/{run}?jobId={job}"), None);
            poll_text = t.clone();
            if json_of(&t)["state"] != json!("pending") || waited.elapsed() > Duration::from_secs(240) {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        let (_, t) = call("briefings", Method::GET, &format!("/definitions/{id}/runs/{run}"), None);
        let d = json_of(&t);
        println!("REAL MODEL: after {:?}: {}", waited.elapsed(), t.chars().take(1500).collect::<String>());
        println!("REAL MODEL poll: {}", poll_text.chars().take(600).collect::<String>());
        if let Ok(keep) = std::env::var("SUITE_REAL_TEXT_COPY") {
            fs::write(keep, d["run"]["summaryText"].as_str().unwrap_or_default()).unwrap();
        }
    }
    println!("suite live: Weather, Sports, News and Briefings worked together over HTTPS");
    // Held-open mode for browser proof from a second device.
    if let Ok(hold) = std::env::var("SUITE_HOLD_OPEN") {
        fs::write(&hold, json!({"origin":origin,"lan":lan,"cookie":cookie,"certificate":cert}).to_string()).unwrap();
        while !Path::new(&format!("{hold}.stop")).exists() {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
