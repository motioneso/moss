//! The installed Notes package served by the real HTTPS server executable, with the
//! server's own folder wiring. Real sign-up, real cookies, real Postgres, real files.
//! This is an HTTP check on this machine, not a native screen or second-device proof.
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
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
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("AI is not connected in this check")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Embeddings are not connected in this check")
    }
}
/// A real HTTP embeddings endpoint on this machine (OpenAI-style). It hashes words into a
/// 768-slot vector, so texts sharing words are close. It stands in for a hosted provider.
static SEEN_AUTHORIZATION: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn embedding_stub(port: &str) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                let body = loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    if let Some(at) = text.find("\r\n\r\n") {
                        let length = text[..at]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if data.len() >= at + 4 + length {
                            break data[at + 4..at + 4 + length].to_vec();
                        }
                    }
                };
                let head = String::from_utf8_lossy(&data).to_string();
                for line in head.lines() {
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        SEEN_AUTHORIZATION
                            .lock()
                            .unwrap()
                            .push(line["authorization:".len()..].trim().to_owned());
                    }
                }
                let input: Value = serde_json::from_slice(&body).unwrap();
                let mut vector = vec![0f64; 768];
                for word in input["input"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| !w.is_empty())
                {
                    let slot = word.bytes().fold(7usize, |h, b| h * 31 + b as usize) % 768;
                    vector[slot] += 1.0;
                }
                let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt().max(1.0);
                let vector: Vec<f64> = vector.iter().map(|v| v / norm).collect();
                let reply = json!({"data":[{"embedding":vector}]}).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    reply.len(),
                    reply
                );
            });
        }
    });
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
#[ignore = "Only through verify-gate and the Notes server gate"]
fn installed_notes_package_serves_folder_settings_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js183-notes-{}", std::process::id())])
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
    // MOSS_NOTES_HOST names the address another device uses. When set, the listener binds
    // every interface, trusts that origin and turns sharing on. The test stays on loopback.
    let remote = std::env::var("MOSS_NOTES_HOST")
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
        // Generated shared styles and fonts for a manual browser check.
        assert!(Command::new("cp")
            .args(["-r", &shared])
            .arg(root.join("web/module-shared"))
            .status()
            .unwrap()
            .success());
    }
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Notes</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-notes-signing-secret-183","connector_key":connector_key}),
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
        let deadline = Instant::now() + Duration::from_secs(60);
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
    let server = start(false);
    let response = client
        .post(format!("{origin}/api/auth/sign-up/email"))
        .header("origin", &origin)
        .json(&json!({"name":"Notes owner","email":"notes-owner@example.test","password":"temporary-notes-password-183-not-a-real-secret"}))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
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
                "SELECT id FROM app.users WHERE email='notes-owner@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        (
            owner,
            safety_core::db::Database::connect(&app_url, 4, safety_core::db::RuntimeRole::App)
                .await
                .unwrap(),
        )
    });
    drop(runtime);
    let access = AccessContext::new(owner, "notes-install");
    {
        let key = connector_key.clone();
        let cipher = safety_core::secret::SecretCipher::connectors(
            &std::collections::HashMap::from([("JARVIS_CONNECTOR_SECRET_KEY".into(), key)]),
        )
        .unwrap();
        let application = Application::open_extended_with(
            &root.join("data"),
            app,
            access.clone(),
            Configuration {
                migrations: Secret::new(bootstrap_url.clone()),
                producer: Secret::new(app_url.clone()),
                cipher: Arc::new(cipher),
                intelligence: Arc::new(NoAi),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: None,
                browser_dir: None,
            },
            Ok,
        )
        .unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let files = moss_notes_checks::package_files(
            &repo,
            fs::read(std::env::var("NOTES_TOOL_COMPONENT").unwrap()).unwrap(),
        )
        .unwrap();
        // Memory's own guest sits in the same registry so its route and jobs run in the real server.
        let memory_files = moss_memory_host::package::files(
            &repo,
            &fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap(),
        )
        .unwrap();
        let registry = root.join("registry");
        let fixture = support::Registry::create_all(&registry, &[&files, &memory_files]);
        let catalog = application
            .installer
            .refresh(
                &access,
                Source::Folder(registry),
                &fixture.public,
                &fixture.public,
                "notes-test-registry",
            )
            .unwrap();
        let artifact = catalog
            .select(
                "notes",
                None,
                &"0.1.0".parse().unwrap(),
                &Default::default(),
                &Default::default(),
            )
            .unwrap();
        application
            .installer
            .install(&access, &catalog, artifact, true)
            .unwrap();
        let memory_artifact = catalog
            .select(
                "memory",
                None,
                &"0.1.0".parse().unwrap(),
                &Default::default(),
                &Default::default(),
            )
            .unwrap();
        application
            .installer
            .install(&access, &catalog, memory_artifact, true)
            .unwrap();
    }
    let embedding_port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js187-embed-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!embedding_port.0.is_empty());
    embedding_stub(&embedding_port.0);
    let embedding_url = format!("http://127.0.0.1:{}/v1/embeddings", embedding_port.0);
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes"),"private_base":root.join("private"),"embeddings":{"url":embedding_url,"model":"bag-of-words-768","api_key":"local-stub"}}),
    );
    let _server = start(true);
    // With MOSS_NOTES_HOST set, Notes calls cross the non-loopback address.
    let notes_origin = remote.clone().unwrap_or_else(|| origin.clone());
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{notes_origin}/api/m/notes{path}"))
            .header("origin", &notes_origin);
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
        (status, response.json::<Value>().unwrap_or(Value::Null))
    };
    use reqwest::Method;
    // The account's notes folder is prepared by the host; the test only adds content.
    let account_root = root.join("notes").join(owner.to_string());
    // The host opens in the background after the server starts; 503 means not yet.
    let ready = Instant::now() + Duration::from_secs(120);
    while call(Method::GET, "/notes-source", Some(&cookie), None).0 == 503 {
        assert!(
            Instant::now() < ready,
            "module host never opened\n{}",
            fs::read_to_string(root.join("server.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(call(Method::GET, "/notes-source", None, None).0, 401);
    let (status, none) = call(Method::GET, "/notes-source", Some(&cookie), None);
    assert_eq!((status, none["path"].clone()), (200, Value::Null), "{none}");
    fs::create_dir_all(account_root.join("Journal")).unwrap();
    fs::write(account_root.join("Journal/day.md"), b"# A day\n").unwrap();
    fs::write(
        account_root.join("Journal/coffee.md"),
        b"# Coffee\nEspresso beans from the corner roaster, ground fresh.\n",
    )
    .unwrap();
    fs::write(
        account_root.join("Journal/garden.md"),
        b"# Garden\nTomato seedlings need compost and sunny soil.\n",
    )
    .unwrap();
    // Optional manual browser check: keep the server up and print where it is. The browser
    // must leave the folder unlinked before the hold ends.
    if let Ok(seconds) = std::env::var("MOSS_NOTES_HOLD_SECONDS") {
        println!("HOLD {} for {seconds}s", remote.as_ref().unwrap_or(&origin));
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }
    let (status, roots) = call(
        Method::GET,
        "/notes-source/directories",
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{roots}");
    assert!(
        roots.to_string().contains(&owner.to_string()),
        "the account folder must be the offered root: {roots}"
    );
    let journal = account_root.join("Journal");
    let (status, children) = call(
        Method::GET,
        &format!("/notes-source/directories?path={}", account_root.display()),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{children}");
    assert!(children.to_string().contains("Journal"), "{children}");
    // Exactly one root is offered, and a neighbouring account's folder is out of reach
    // for browsing and linking, with the saved setting left unchanged.
    assert_eq!(
        roots["directories"].as_array().map(Vec::len),
        Some(1),
        "{roots}"
    );
    let neighbour = root.join("notes").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(neighbour.join("Private")).unwrap();
    let (status, browse) = call(
        Method::GET,
        &format!("/notes-source/directories?path={}", neighbour.display()),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 400, "{browse}");
    let (status, link) = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":neighbour})),
    );
    assert_eq!(status, 400, "{link}");
    let (_, still) = call(Method::GET, "/notes-source", Some(&cookie), None);
    assert_eq!(still["path"], Value::Null, "{still}");
    let outside = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":"/etc"})),
    );
    assert_eq!(outside.0, 400, "{}", outside.1);
    let saved = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":journal})),
    );
    assert_eq!(
        saved.0,
        200,
        "{}\n{}",
        saved.1,
        fs::read_to_string(root.join("server.log")).unwrap_or_default()
    );
    let (status, got) = call(Method::GET, "/notes-source", Some(&cookie), None);
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["path"], json!(journal), "{got}");
    let (status, state) = call(Method::GET, "/notes-last-sync", Some(&cookie), None);
    assert_eq!(status, 200, "{state}");
    let sync = call(Method::POST, "/notes/sync", Some(&cookie), Some(json!({})));
    println!("sync request answered {} {}", sync.0, sync.1);
    assert_eq!(sync.0, 202, "{}", sync.1);
    assert!(sync.1["jobId"].is_string(), "{}", sync.1);
    // The server's own worker runs the sync: wait for the rows it indexed.
    let rows = |sql: &'static str| -> Vec<String> {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            db.query(sql, &[&owner])
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<_, String>(0))
                .collect()
        })
    };
    let indexed_sql = "SELECT DISTINCT source_path FROM app.memory_chunks WHERE owner_user_id=$1 AND embedding IS NOT NULL ORDER BY 1";
    let deadline = Instant::now() + Duration::from_secs(90);
    let indexed = loop {
        let found = rows(indexed_sql);
        if found.len() >= 3 {
            break found;
        }
        assert!(
            Instant::now() < deadline,
            "sync did not index the notes: {found:?}\n{}",
            fs::read_to_string(root.join("server.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(500));
    };
    println!("indexed by the server worker: {indexed:?}");
    for name in ["coffee.md", "day.md", "garden.md"] {
        assert!(indexed.iter().any(|p| p.ends_with(name)), "{indexed:?}");
    }
    let (status, state) = call(Method::GET, "/notes-last-sync", Some(&cookie), None);
    assert_eq!(status, 200, "{state}");
    println!("last sync status after indexing: {state}");
    // Linking the folder also created the account's fifteen-minute sync schedule. Add a
    // note, make the schedule due now, and wait for the server's own scheduler and worker
    // to index it without any manual sync request.
    let schedule_sql = "SELECT cron FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%.notes.sync-tick' AND disabled_reason IS NULL";
    assert_eq!(rows(schedule_sql), vec!["*/15 * * * *".to_string()]);
    fs::write(
        journal.join("tick.md"),
        "# Tick\n\nWritten after the first sync; only the schedule can index it.\n",
    )
    .unwrap();
    {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            // One finished checkpoint past retention and one recent one. The tick
            // must delete only the old one.
            for (id, age) in [
                ("0a000000-0000-4000-8000-0000000000a1", "3 days"),
                ("0a000000-0000-4000-8000-0000000000a2", "1 minute"),
            ] {
                db.execute(
                    &format!("INSERT INTO app.notes_sync_checkpoints (id, owner_user_id, checkpoint, created_at) VALUES ($1::text::uuid, $2, '{{\"workerResult\":{{\"ingested\":0,\"skipped\":0,\"errors\":0}}}}'::jsonb, now()-interval '{age}')"),
                    &[&id, &owner],
                )
                .await
                .unwrap();
            }
            let changed = db
                .execute(
                    "UPDATE moss_queue.schedules SET next_at=now()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%.notes.sync-tick'",
                    &[&owner],
                )
                .await
                .unwrap();
            assert_eq!(changed, 1);
        });
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if rows(indexed_sql).iter().any(|p| p.ends_with("tick.md")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the schedule did not index the new note\n{}",
            fs::read_to_string(root.join("server.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    println!("scheduled tick indexed a note added after the first sync");
    // The same tick ran retention: the old checkpoint is gone, the recent one stays.
    let kept = rows("SELECT id::text FROM app.notes_sync_checkpoints WHERE owner_user_id=$1 AND id::text LIKE '0a000000-%' ORDER BY id");
    assert_eq!(kept, vec!["0a000000-0000-4000-8000-0000000000a2".to_string()]);
    println!("tick retention removed the old checkpoint and kept the recent one: {kept:?}");
    // Sync now while a recent request for the same folder is still waiting reuses it
    // instead of stacking a second one.
    let waiting = "0b000000-0000-4000-8000-0000000000b1";
    {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            db.execute(
                "INSERT INTO app.notes_sync_checkpoints (id, owner_user_id, checkpoint) VALUES ($1::text::uuid, $2, jsonb_build_object('sourcePath', $3::text))",
                &[&waiting, &owner, &journal.to_str().unwrap()],
            )
            .await
            .unwrap();
        });
    }
    let again = call(Method::POST, "/notes/sync", Some(&cookie), Some(json!({})));
    assert_eq!(again.0, 202, "{}", again.1);
    assert_eq!(again.1["jobId"], json!(waiting), "{}", again.1);
    println!("Sync now reused the waiting request: {}", again.1);
    // Settings route, live: the owner sets the endpoint in the app. The server must then embed
    // through the saved endpoint with the saved credential, and nothing may leak it.
    {
        const SAVED_KEY: &str = "settings-credential-7d41c9";
        const MARKER_TEXT: &str = "zanzibar-quokka-marker";
        let settings = |method: Method, body: Option<Value>| {
            let mut request = client
                .request(method, format!("{notes_origin}/api/m/memory/embedding"))
                .header("origin", &notes_origin)
                .header("cookie", &cookie);
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request.send().unwrap();
            let status = response.status().as_u16();
            let text = response.text().unwrap();
            (status, text)
        };
        let (status, text) = settings(Method::GET, None);
        assert_eq!(status, 200, "{text}");
        assert!(text.contains("hasCredential"), "{text}");
        let refused = settings(
            Method::PUT,
            Some(json!({"url":embedding_url,"model":"bag-of-words-768","apiKey":SAVED_KEY})),
        );
        assert_eq!(refused.0, 400, "{}", refused.1);
        assert!(refused.1.contains("memory text will be sent"), "{}", refused.1);
        let saved = settings(
            Method::PUT,
            Some(json!({"url":embedding_url,"model":"bag-of-words-768","apiKey":SAVED_KEY,"confirmOffDevice":true})),
        );
        assert_eq!(saved.0, 200, "{}", saved.1);
        let moved = settings(
            Method::PUT,
            Some(json!({"url":"https://other.example.test/v1/embeddings","model":"x","confirmOffDevice":true})),
        );
        assert_eq!(moved.0, 400, "a new address must not inherit the old key: {}", moved.1);
        let insecure = settings(
            Method::PUT,
            Some(json!({"url":"http://203.0.113.9/v1/embeddings","model":"x","apiKey":"k","confirmOffDevice":true})),
        );
        assert_eq!(insecure.0, 400, "plain http off this machine: {}", insecure.1);
        let shown = settings(Method::GET, None);
        assert_eq!(shown.0, 200, "{}", shown.1);
        assert!(shown.1.contains("\"hasCredential\":true"), "{}", shown.1);
        for text in [&saved.1, &shown.1, &refused.1] {
            assert!(!text.contains(SAVED_KEY), "{text}");
        }
        let sealed = fs::read_to_string(root.join("data/embedding-credential.json")).unwrap();
        assert!(!sealed.contains(SAVED_KEY), "the credential file is sealed");
        fs::write(
            journal.join("marker.md"),
            format!("# Marker\n\n{MARKER_TEXT} lives only in this note.\n"),
        )
        .unwrap();
        let sync = call(Method::POST, "/notes/sync", Some(&cookie), Some(json!({})));
        assert_eq!(sync.0, 202, "{}", sync.1);
        let deadline = Instant::now() + Duration::from_secs(90);
        while !rows(indexed_sql).iter().any(|p| p.ends_with("marker.md")) {
            assert!(
                Instant::now() < deadline,
                "the marker note was not indexed through the saved endpoint\n{}",
                fs::read_to_string(root.join("server.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(500));
        }
        let bearer = format!("Bearer {SAVED_KEY}");
        assert!(
            SEEN_AUTHORIZATION.lock().unwrap().iter().any(|h| *h == bearer),
            "the endpoint never received the saved credential"
        );
        let log = fs::read_to_string(root.join("server.log")).unwrap_or_default();
        assert!(!log.contains(SAVED_KEY), "the credential reached the server log");
        assert!(!log.contains(MARKER_TEXT), "note text reached the server log");
        let activity = rows("SELECT coalesce(model_name,'') || '|' || action || '|' || outcome || '|' || coalesce(result,'') FROM app.moss_model_activity_log WHERE kind='embedding' AND owner_user_id=$1");
        assert!(activity.iter().any(|r| r.starts_with("bag-of-words-768|embed document|ok|")), "{activity:?}");
        for row in &activity {
            assert!(!row.contains(MARKER_TEXT) && !row.contains(SAVED_KEY), "{row}");
        }
        println!("PASS memory settings: the owner set the embedding endpoint over HTTPS (refused without the off-device confirmation), the credential was never in a response, the sealed file, the server log or an activity row, the endpoint received it, and a marker note indexed through the saved endpoint; {} activity rows", activity.len());
    }
    // Search runs through the same host ports in this process (the server has no tool
    // endpoint yet), against the real index and the same embeddings endpoint.
    {
        use moss_module_host::{
            ai::{EmbeddingsOnly, FixedEmbeddings, IntelligenceEmbeddings},
            memory_search::MemorySearchPorts,
        };
        let ai: Arc<dyn moss_module_host::ai::Intelligence> = Arc::new(
            EmbeddingsOnly::new(FixedEmbeddings::new(
                embedding_url.parse().unwrap(),
                "bag-of-words-768".into(),
                "local-stub".into(),
            ))
            .unwrap(),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let app = runtime.block_on(async {
            safety_core::db::Database::connect(&app_url, 4, safety_core::db::RuntimeRole::App)
                .await
                .unwrap()
        });
        let search_database = app.clone();
        let cipher = safety_core::secret::SecretCipher::connectors(
            &std::collections::HashMap::from([(
                "JARVIS_CONNECTOR_SECRET_KEY".into(),
                connector_key.clone(),
            )]),
        )
        .unwrap();
        let application = Application::open_extended_with(
            &root.join("data"),
            app,
            access.clone(),
            Configuration {
                migrations: Secret::new(bootstrap_url.clone()),
                producer: Secret::new(app_url.clone()),
                cipher: Arc::new(cipher),
                intelligence: ai.clone(),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: None,
                browser_dir: None,
            },
            |services| {
                Ok(Arc::new(
                    MemorySearchPorts::new(
                        search_database,
                        Arc::new(IntelligenceEmbeddings::new(ai, "bag-of-words-768".into())),
                        std::collections::BTreeMap::from([(
                            ("notes".into(), "source".into()),
                            "notes".into(),
                        )]),
                        services,
                    )
                    .unwrap(),
                ))
            },
        )
        .unwrap();
        let search = |query: &str| -> Value {
            serde_json::from_str(
                &application
                    .installer
                    .call(
                        "notes",
                        AccessContext::new(owner, "notes-search-live"),
                        "tool",
                        &json!({"tool":"notes.search","parameters":{"query":query}}).to_string(),
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        let coffee = search("espresso coffee beans");
        let garden = search("tomato compost soil");
        println!("search coffee -> {coffee}");
        println!("search garden -> {garden}");
        let top = |v: &Value| {
            v["data"]["chunks"][0]["sourcePath"]
                .as_str()
                .unwrap_or_else(|| panic!("no first chunk: {v}"))
                .to_owned()
        };
        assert!(top(&coffee).ends_with("/Journal/coffee.md"), "{coffee}");
        assert!(top(&garden).ends_with("/Journal/garden.md"), "{garden}");
        drop(application);
        drop(runtime);
    }
    // Private note export runs through the same host ports in this process (it is a
    // module-to-module API with no HTTP route), with the real database and real files.
    {
        use moss_module_host::linked_notes::{LinkedNotesPorts, PreferenceFolders};
        let ai: Arc<dyn moss_module_host::ai::Intelligence> = Arc::new(
            moss_module_host::ai::EmbeddingsOnly::new(moss_module_host::ai::FixedEmbeddings::new(
                embedding_url.parse().unwrap(),
                "bag-of-words-768".into(),
                "local-stub".into(),
            ))
            .unwrap(),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let app = runtime.block_on(async {
            safety_core::db::Database::connect(&app_url, 4, safety_core::db::RuntimeRole::App)
                .await
                .unwrap()
        });
        let folder_database = app.clone();
        let cipher = safety_core::secret::SecretCipher::connectors(
            &std::collections::HashMap::from([(
                "JARVIS_CONNECTOR_SECRET_KEY".into(),
                connector_key.clone(),
            )]),
        )
        .unwrap();
        let private_base = root.join("private");
        let base_for_ports = private_base.clone();
        let application = Application::open_extended_with(
            &root.join("data"),
            app,
            access.clone(),
            Configuration {
                migrations: Secret::new(bootstrap_url.clone()),
                producer: Secret::new(app_url.clone()),
                cipher: Arc::new(cipher),
                intelligence: ai,
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: None,
                browser_dir: None,
            },
            |services| {
                let folders = PreferenceFolders::new(
                    folder_database,
                    std::collections::BTreeMap::new(),
                    std::collections::BTreeMap::new(),
                )
                .unwrap()
                .with_private_export("notes", "private-export", base_for_ports);
                Ok(Arc::new(LinkedNotesPorts::new(Arc::new(folders), services)))
            },
        )
        .unwrap();
        let source = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let api = |actor: uuid::Uuid, name: &str, version: u64, content: &str| -> Value {
            serde_json::from_str(
                &application
                    .installer
                    .call(
                        "notes",
                        AccessContext::new(actor, "notes-private-export-live"),
                        "api",
                        &json!({"name":name,"parameters":{"sourceId":source,"version":version,"content":content}})
                            .to_string(),
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        let written = api(owner, "exportPrivateNote", 1, "# Meeting\nprivate text\n");
        assert_eq!(written["status"], "written", "{written}");
        let file = private_base
            .join(owner.to_string())
            .join("notes/generated")
            .join(source)
            .join("v1.md");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Meeting\nprivate text\n"
        );
        assert!(
            !file.starts_with(root.join("notes")),
            "the copy must stay outside every linked notes folder"
        );
        assert_eq!(api(owner, "exportPrivateNote", 1, "# Meeting\nprivate text\n")["status"], "unchanged");
        assert_eq!(api(owner, "exportPrivateNote", 1, "different")["status"], "conflict");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Meeting\nprivate text\n",
            "a conflicting retry must not overwrite"
        );
        assert_eq!(api(owner, "inspectPrivateNote", 2, "next")["status"], "missing");
        let other = uuid::Uuid::new_v4();
        assert_eq!(api(other, "exportPrivateNote", 1, "someone else")["status"], "written");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Meeting\nprivate text\n",
            "another account's copy must not touch this account's file"
        );
        assert!(private_base.join(other.to_string()).join("notes/generated").join(source).join("v1.md").is_file());
        println!("private export -> written, unchanged, conflict (kept), missing; second actor isolated");
        // Memory's own index: the real server starts the sweep over HTTPS, the scheduler
        // keeps a fifteen-minute schedule, and the worker embeds the exported copy.
        let started = client
            .request(Method::POST, format!("{notes_origin}/api/m/memory/vault-index/start"))
            .header("origin", &notes_origin)
            .header("cookie", &cookie)
            .json(&json!({}))
            .send()
            .unwrap();
        let started_status = started.status().as_u16();
        let started_body = started.text().unwrap_or_default();
        assert_eq!(started_status, 202, "{started_body}");
        let memory_sql = "SELECT DISTINCT source_path FROM app.memory_chunks WHERE owner_user_id=$1 AND source_path LIKE 'notes/generated/%' AND embedding IS NOT NULL";
        let memory_deadline = Instant::now() + Duration::from_secs(90);
        let memory_rows = loop {
            let found = rows(memory_sql);
            if !found.is_empty() {
                break found;
            }
            assert!(
                Instant::now() < memory_deadline,
                "memory sweep did not index the export\n{}",
                fs::read_to_string(root.join("server.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(500));
        };
        assert!(memory_rows.iter().any(|p| p.ends_with("v1.md")), "{memory_rows:?}");
        let memory_schedule = "SELECT cron FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%memory.vault-ingest-tick' AND disabled_reason IS NULL";
        assert_eq!(rows(memory_schedule), vec!["*/15 * * * *".to_string()]);
        println!("PASS memory index: the server's sweep, started over HTTPS, embedded the private export {memory_rows:?} through the saved endpoint, and a fifteen-minute schedule was registered");
        drop(application);
        drop(runtime);
    }
    // The daily chat archive is a module-to-module API with no HTTP route. It runs in this
    // process against the real database, the folder the HTTPS steps linked, and real files.
    {
        use moss_module_host::linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders};
        let ai: Arc<dyn moss_module_host::ai::Intelligence> = Arc::new(
            moss_module_host::ai::EmbeddingsOnly::new(moss_module_host::ai::FixedEmbeddings::new(
                embedding_url.parse().unwrap(),
                "bag-of-words-768".into(),
                "local-stub".into(),
            ))
            .unwrap(),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let app = runtime.block_on(async {
            safety_core::db::Database::connect(&app_url, 4, safety_core::db::RuntimeRole::App)
                .await
                .unwrap()
        });
        let folder_database = app.clone();
        let archive_database = app.clone();
        let cipher = safety_core::secret::SecretCipher::connectors(
            &std::collections::HashMap::from([(
                "JARVIS_CONNECTOR_SECRET_KEY".into(),
                connector_key.clone(),
            )]),
        )
        .unwrap();
        let notes_base = root.join("notes");
        let application = Application::open_extended_with(
            &root.join("data"),
            app,
            access.clone(),
            Configuration {
                migrations: Secret::new(bootstrap_url.clone()),
                producer: Secret::new(app_url.clone()),
                cipher: Arc::new(cipher),
                intelligence: ai,
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: None,
                browser_dir: None,
            },
            |services| {
                let folders = PreferenceFolders::new(
                    folder_database,
                    std::collections::BTreeMap::from([(
                        ("notes".to_string(), "source".to_string()),
                        PreferenceFolder {
                            preference: "notes-source-path".into(),
                            relative_to: None,
                        },
                    )]),
                    std::collections::BTreeMap::new(),
                )
                .unwrap()
                .with_account_base(notes_base.clone());
                let linked: Arc<dyn moss_module_host::runtime::Ports> =
                    Arc::new(LinkedNotesPorts::new(Arc::new(folders), services));
                Ok(Arc::new(
                    moss_module_host::folder_settings::FolderSettingsPorts::new(
                        archive_database,
                        std::collections::BTreeMap::from([(
                            ("notes".to_string(), "source".to_string()),
                            moss_module_host::folder_settings::FolderSetting {
                                path_key: "notes-source-path".into(),
                                status_key: "notes-last-sync".into(),
                                roots: std::collections::BTreeMap::new(),
                            },
                        )]),
                        linked,
                    )
                    .unwrap()
                    .with_account_base(notes_base),
                ))
            },
        )
        .unwrap();
        let archive = |sessions: Value| -> Value {
            serde_json::from_str(
                &application
                    .installer
                    .call(
                        "notes",
                        AccessContext::new(owner, "notes-daily-archive-live"),
                        "api",
                        &json!({"name":"writeDailyChatArchive","parameters":{
                            "localDate":"2026-11-10","folder":"Moss/Chats","sessions":sessions}})
                            .to_string(),
                    )
                    .unwrap_or_else(|e| {
                        panic!(
                            "archive call failed: {e:#}; file written: {}",
                            journal.join("Moss/Chats/2026-11-10.md").is_file()
                        )
                    }),
            )
            .unwrap()
        };
        let sessions = json!([{"threadId":"t1","title":"Trip plan","timeLabel":"9:00 AM",
            "messages":[{"role":"user","body":"Where should we stay?"},
                        {"role":"assistant","body":"Near the station."}]}]);
        let first = archive(sessions.clone());
        assert_eq!(first, json!({"written":true,"path":"Moss/Chats/2026-11-10.md"}), "{first}");
        let file = journal.join("Moss/Chats/2026-11-10.md");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("<!-- moss-chat-archive:v1 -->\n"), "{text}");
        assert!(text.contains("## 9:00 AM \u{2014} Trip plan"), "{text}");
        assert!(text.contains("**assistant:** Near the station."), "{text}");
        // A later run replaces only Moss's own file.
        let again = archive(json!([{"threadId":"t1","title":"Trip plan","timeLabel":"9:00 AM",
            "messages":[{"role":"user","body":"Updated question"}]}]));
        assert_eq!(again["path"], "Moss/Chats/2026-11-10.md");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("Updated question") && !text.contains("Near the station"));
        // A person's own file with the day's name is never touched.
        std::fs::write(&file, "# my own journal").unwrap();
        let beside = archive(sessions);
        assert_eq!(beside["path"], "Moss/Chats/2026-11-10 (moss).md", "{beside}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# my own journal");
        assert!(journal.join("Moss/Chats/2026-11-10 (moss).md").is_file());
        let refused = archive(json!([]));
        assert_eq!(refused["reason"], "no-sessions");
        println!("daily archive -> written, replaced own file, kept the person's file and saved beside it, empty refused");
        drop(application);
        drop(runtime);
    }
    let unlinked = call(
        Method::PUT,
        "/notes-source",
        Some(&cookie),
        Some(json!({"path":null})),
    );
    assert_eq!(unlinked.0, 200, "{}", unlinked.1);
    assert!(
        journal.join("day.md").is_file(),
        "unlinking must keep the files"
    );
    assert!(
        rows(schedule_sql).is_empty(),
        "unlinking must cancel the sync schedule"
    );
    println!("PASS installed Notes package served over HTTPS: sign-in required, folder offered and browsed inside the account root, outside path refused, link saved, status readable, sync requested, unlink keeps files");
    println!("PASS schedule: linking created one fifteen-minute sync schedule per account; when due, the server's scheduler and worker indexed a note added later, with no manual request");
    println!("PASS indexing: the server's own worker embedded three real notes through a local HTTP embeddings endpoint, and search returned the matching note first for two queries");
    println!("PASS private export: a versioned note copy was written once into the account's private area (outside the linked folder), a retry was unchanged, a different retry was a kept conflict, and another actor's copy stayed separate");
    println!("PASS daily chat archive: in the linked folder, a day's conversations were written with the Moss marker, refreshed on a second run, and a person's own file of the same name was kept with the archive saved beside it");
    println!("NOT PROVEN: daily archive over HTTP or from chat (it is a module-to-module API run in-process; the chat settings and daily trigger are not joined), private export over HTTP (it is a module-to-module API run in-process) and indexing of private copies, a hosted embeddings provider (a local stand-in endpoint was used), search from the chat or any server endpoint, second signed-in account (setup allows one owner), native UI, second physical device");
}
