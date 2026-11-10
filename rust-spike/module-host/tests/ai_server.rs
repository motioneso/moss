//! Module AI on the real HTTPS executable: closed until a provider exists, then routed through
//! the capability router to a provider that this test runs. Not a native UI proof.
mod common;
#[path = "tasks_server/installed.rs"]
mod installed;
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
#[ignore = "Only through verify-gate and the Tasks server gate"]
fn modules_ask_the_router_and_fail_closed_until_a_provider_exists() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js189-ai-{}", std::process::id())])
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
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Tasks HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-tasks-signing-secret-182","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-tasks-password-182-not-a-real-secret"})).send().unwrap();
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("tasks-owner@example.test", "Tasks owner");
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
                "SELECT id FROM app.users WHERE email='tasks-owner@example.test'",
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
    let access = AccessContext::new(owner, "tasks-install");
    installed::install(
        &root.join("data"),
        &root.join("registry"),
        app,
        &access,
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    );
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key,"notes_base":root.join("notes")}),
    );
    let _server = start(true);
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/tasks{path}"))
            .header("origin", &origin);
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
    // The provider the owner configures. Its address is this process; the key is fake.
    let requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>> = Default::default();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    {
        let requests = requests.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Read, Write};
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap_or(0);
                let path = line.split(' ').nth(1).unwrap_or("").to_owned();
                let (mut length, mut auth) = (0usize, String::new());
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = header["authorization:".len()..].trim().to_owned();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                requests.lock().unwrap().push((
                    path,
                    auth,
                    serde_json::from_slice(&body).unwrap_or(Value::Null),
                ));
                let answer = json!({"choices":[{"message":{"content":"{\"text\":\"stretch\",\"status\":\"done\",\"listIds\":[],\"tagNames\":[]}"}}]}).to_string();
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                );
            }
        });
    }
    let interpret = || {
        call(
            Method::POST,
            "/tasks/search/interpret",
            Some(&cookie),
            Some(json!({"query":"finished stretch tasks"})),
        )
    };
    assert_eq!(call(Method::POST, "/tasks/search/interpret", None, Some(json!({"query":"x"}))).0, 401);
    let (status, body) = interpret();
    assert_eq!(status, 503, "no provider yet must fail closed: {body}");
    assert!(requests.lock().unwrap().is_empty(), "nothing may be sent before a provider exists");
    let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
        .unwrap()
        .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new("TEST-NOT-A-REAL-KEY-189")));
    let seed = |sql: &'static str| {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.batch_execute(sql).await.unwrap();
        })
    };
    let provider: uuid::Uuid = uuid::Uuid::new_v4();
    let model: uuid::Uuid = uuid::Uuid::new_v4();
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        db.execute(
            "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Test provider',$3,$4,true)",
            &[&provider, &owner, &format!("http://127.0.0.1:{provider_port}"), &sealed],
        ).await.unwrap();
        db.execute(
            "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'test-model-189','Test model',ARRAY['chat','json'])",
            &[&model, &provider, &owner],
        ).await.unwrap();
    });
    let (status, body) = interpret();
    assert_eq!(status, 200, "{body}\n{}", fs::read_to_string(root.join("server.log")).unwrap_or_default());
    assert_eq!(body["status"], "done", "{body}");
    {
        let seen = requests.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "/v1/chat/completions");
        assert_eq!(seen[0].1, "Bearer TEST-NOT-A-REAL-KEY-189", "the stored key must be opened and sent");
        assert_eq!(seen[0].2["model"], "test-model-189");
        assert!(seen[0].2["messages"][0]["content"].as_str().unwrap().contains("finished stretch tasks"));
    }
    // Disabling the provider closes the path again.
    seed("UPDATE app.ai_provider_configs SET status='disabled'");
    let (status, body) = interpret();
    assert_eq!(status, 503, "a disabled provider must fail closed: {body}");
    assert_eq!(requests.lock().unwrap().len(), 1);
    let log = fs::read_to_string(root.join("server.log")).unwrap_or_default();
    assert!(!log.contains("TEST-NOT-A-REAL-KEY-189"));
    println!("PASS module AI over HTTPS: 401 signed out, 503 with no provider (nothing sent), 200 after the owner's provider exists with the stored key opened and the chosen model sent, 503 again once it is disabled");
    println!("NOT PROVEN: native UI, second physical device, a real provider, embeddings, second account over HTTP");
}
