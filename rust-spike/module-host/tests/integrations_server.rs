//! Connected-tool routes on the real HTTPS executable, through the real route path, with a tiny
//! stand-in tool service on this machine. No response is intercepted or rewritten.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const CREDENTIAL: &str = "MOSS-LIVE-credential-5d21";
const PRIVATE: &str = "MOSS-LIVE-private-note-84be";

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

static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn claim(name: &str) -> Port {
    let out = Command::new("devports").args(["claim", &format!("{name}-{}", std::process::id())]).output().unwrap();
    let port = String::from_utf8(out.stdout).unwrap().trim().to_owned();
    assert!(!port.is_empty());
    Port(port)
}

/// A one-tool MCP service. It records every Authorization header it receives.
fn service(port: &str) {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = vec![0u8; 16384];
            let mut read = 0;
            let (head, body) = loop {
                let n = stream.read(&mut buffer[read..]).unwrap_or(0);
                if n == 0 {
                    break (String::new(), String::new());
                }
                read += n;
                let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let head = text[..split].to_owned();
                    let length = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if text.len() >= split + 4 + length {
                        break (head, text[split + 4..split + 4 + length].to_owned());
                    }
                }
            };
            for line in head.lines().filter(|l| l.to_ascii_lowercase().starts_with("authorization:")) {
                SEEN.lock().unwrap().push(line.to_owned());
            }
            let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let reply = match request["method"].as_str() {
                Some("initialize") => Some(json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"stand-in","version":"1"}}})),
                Some("tools/list") => Some(json!({"jsonrpc":"2.0","id":request["id"],"result":{"tools":[
                    {"name":"list_things","description":format!("List things. {PRIVATE}"),"inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}},
                    {"name":"fetch_item","description":"Fetch one item.","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}})),
                _ => None,
            };
            let (status, payload) = match reply {
                Some(r) => ("200 OK", r.to_string()),
                None => ("202 Accepted", String::new()),
            };
            let _ = write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
        }
    });
}

fn private(path: &Path, value: &Value) {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}

#[test]
#[ignore = "Only through verify-gate and the integrations live gate"]
fn the_real_server_serves_connected_tools() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = claim("js312-int");
    let tool_port = claim("js312-svc");
    service(&tool_port.0);
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
    fs::write(root.join("web/index.html"), "<!doctype html><title>fixture</title>").unwrap();
    let (app_url, worker_url, bootstrap_url, auth_url) = (
        std::env::var("JS43_APP_URL").unwrap(),
        std::env::var("JS43_WORKER_URL").unwrap(),
        std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
        std::env::var("JS170_AUTH_URL").unwrap(),
    );
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-integrations-signing-secret-312","connector_key":connector_key}),
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
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let start = |modules: bool| {
        let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
        command.arg("--network").arg(root.join("network.json")).arg("--web").arg(root.join("web"));
        if modules {
            command.arg("--modules").arg(root.join("modules.json"));
        }
        let file = fs::OpenOptions::new().create(true).append(true).open(root.join("server.log")).unwrap();
        let mut server = Server(command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(file).spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(server.0.try_wait().unwrap().is_none(), "server startup failed");
            if client.get(format!("{origin}/api/hello")).send().is_ok_and(|r| r.status().is_success()) {
                break;
            }
            assert!(Instant::now() < deadline, "server startup deadline");
            std::thread::sleep(Duration::from_millis(100));
        }
        server
    };
    let signup = |email: &str, name: &str| {
        let response = client
            .post(format!("{origin}/api/auth/sign-up/email"))
            .header("origin", &origin)
            .json(&json!({"name":name,"email":email,"password":"temporary-integrations-password-312-not-real"}))
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };

    let server = start(false);
    let cookie_a = signup("int-a@example.test", "Int A");
    drop(server);

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
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
        // The gate's migration step already applied the integration SQL; apply it only when absent.
        let present = db.query_one("SELECT to_regclass('app.integration_connections') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0);
        if !present {
            let dir = format!("{}/../../packages/integrations/sql", env!("CARGO_MANIFEST_DIR"));
            for file in [
                "0207_integration_connections.sql",
                "0208_integration_unsuppressed_tools.sql",
                "0209_integration_group_derivation_grandfather.sql",
                "0253_integration_classifier_settings.sql",
                "0268_integration_classifier_sort.sql",
                "0269_integration_classifier_sort_convert.sql",
                "0270_integration_classifier_sort_worker.sql",
                "0272_integration_classifier_prepare_worker.sql",
                "0353_integration_classifier_scan.sql",
            ] {
                db.batch_execute(&fs::read_to_string(format!("{dir}/{file}")).unwrap()).await.unwrap();
            }
        }
    });
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    let _server = start(true);

    // Sign-up allows one owner over HTTP, so the second person is made in the database with
    // the first person's password hash and then signs in through the real route.
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let id = uuid::Uuid::new_v4();
        db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Int B', 'int-b@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
        db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts a JOIN app.users u ON u.id = a.user_id WHERE u.email = 'int-a@example.test' AND a.provider_id = 'credential'", &[&id]).await.unwrap();
    });
    let cookie_b = {
        let signed = client
            .post(format!("{origin}/api/auth/sign-in/email"))
            .header("origin", &origin)
            .json(&json!({"email":"int-b@example.test","password":"temporary-integrations-password-312-not-real"}))
            .send()
            .unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };

    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}{path}")).header("origin", &origin);
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
    use reqwest::Method;

    // Signed out is refused.
    assert_eq!(call(Method::GET, "/api/integrations", None, None).0, 401);

    let url = format!("http://127.0.0.1:{}/mcp", tool_port.0);
    let (status, text) = call(
        Method::POST,
        "/api/integrations",
        Some(&cookie_a),
        Some(json!({"name":"Stand-in service","kind":"mcp","url":url,"credential":CREDENTIAL,"credentialPlacement":{"kind":"bearer"}})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let created: Value = serde_json::from_str(&text).unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    assert!(!text.contains(CREDENTIAL), "the create reply must not echo the credential");
    assert_eq!(created["hasCredential"], json!(true));
    assert!(SEEN.lock().unwrap().iter().any(|h| h.contains(&format!("Bearer {CREDENTIAL}"))), "the service should receive the credential");
    let names: Vec<&str> = created["tools"].as_array().map(|t| t.iter().filter_map(|t| t["name"].as_str()).collect()).unwrap_or_default();
    println!("tools discovered: {names:?}");

    let (status, text) = call(Method::GET, "/api/integrations", Some(&cookie_a), None);
    assert_eq!(status, 200);
    assert!(text.contains(&id) && !text.contains(CREDENTIAL));

    // A second person sees nothing of it.
    let (status, text) = call(Method::GET, "/api/integrations", Some(&cookie_b), None);
    assert_eq!((status, text.contains(&id)), (200, false));
    assert_eq!(call(Method::GET, &format!("/api/integrations/{id}"), Some(&cookie_b), None).0, 404);
    assert_eq!(call(Method::DELETE, &format!("/api/integrations/{id}"), Some(&cookie_b), None).0, 404);

    // The worker picks up the queued sort. No chat model exists, so it records "no model".
    let deadline = Instant::now() + Duration::from_secs(30);
    let detail = loop {
        let (_, text) = call(Method::GET, &format!("/api/integrations/{id}"), Some(&cookie_a), None);
        if text.contains("no_model") || text.contains("noModel") || text.contains("No model") {
            break text;
        }
        assert!(Instant::now() < deadline, "the worker never recorded a sort result: {text}\n{}", log());
        std::thread::sleep(Duration::from_millis(500));
    };
    assert!(!detail.contains(CREDENTIAL));

    let (status, _) = call(Method::PATCH, &format!("/api/integrations/{id}"), Some(&cookie_a), Some(json!({"name":"Renamed"})));
    assert_eq!(status, 200);
    assert_eq!(call(Method::DELETE, &format!("/api/integrations/{id}"), Some(&cookie_a), None).0, 204);
    assert_eq!(call(Method::GET, &format!("/api/integrations/{id}"), Some(&cookie_a), None).0, 404);

    // Neither secret nor private tool text reaches the server log or the job queue.
    let logged = log();
    assert!(!logged.contains(CREDENTIAL) && !logged.contains(PRIVATE), "server log leaked");
    let payloads: Vec<String> = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.query("SELECT payload::text FROM moss_queue.jobs", &[]).await.unwrap().iter().map(|r| r.get(0)).collect()
    });
    assert!(!payloads.is_empty());
    assert!(payloads.iter().all(|p| !p.contains(CREDENTIAL) && !p.contains(PRIVATE)));
}
