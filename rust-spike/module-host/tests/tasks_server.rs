//! Installed Tasks package served by the real HTTPS executable. Not a native UI proof.
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
fn installed_tasks_package_serves_routes_and_nightly_job_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js182-tasks-{}", std::process::id())])
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
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
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
    // The server opens its module host in the background; wait until it answers.
    let ready = Instant::now() + Duration::from_secs(90);
    while call(Method::GET, "/tasks", None, None).0 == 503 {
        assert!(Instant::now() < ready, "module host never became ready");
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(call(Method::GET, "/tasks", None, None).0, 401);
    let created = call(
        Method::POST,
        "/tasks",
        Some(&cookie),
        Some(json!({"title":"Daily stretch","recurrence":{"freq":"daily","interval":1,"occurrence_date":"2020-01-01"}})),
    );
    assert_eq!(created.0, 201, "{}\n{}", created.1, fs::read_to_string(root.join("server.log")).unwrap_or_default());
    let id: uuid::Uuid = created.1["task"]["id"].as_str().unwrap().parse().unwrap();
    // Raw reads here bypass the route's lazy roll-forward, so any change must come from the job.
    let (db, occurrence) = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let first: String = db
            .query_one("SELECT recurrence->>'occurrence_date' FROM app.tasks WHERE id=$1", &[&id])
            .await
            .unwrap()
            .get(0);
        (db, first)
    });
    assert_eq!(occurrence, "2020-01-01");
    let schedules: i64 = runtime
        .block_on(db.query_one("SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence'", &[&owner]))
        .unwrap()
        .get(0);
    assert_eq!(schedules, 1, "creating a recurring task must schedule one nightly roll-forward");
    // A second recurring task replaces the schedule instead of adding another.
    let second = call(
        Method::POST,
        "/tasks",
        Some(&cookie),
        Some(json!({"title":"Water plants","recurrence":{"freq":"daily","interval":1,"occurrence_date":"2020-01-02"}})),
    );
    assert_eq!(second.0, 201);
    let schedules: i64 = runtime
        .block_on(db.query_one("SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence'", &[&owner]))
        .unwrap()
        .get(0);
    assert_eq!(schedules, 1);
    // Make the schedule due now; the running server's own worker must fire it.
    runtime
        .block_on(db.execute("UPDATE moss_queue.schedules SET next_at=clock_timestamp()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence'", &[&owner]))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let rolled = loop {
        let now: String = runtime
            .block_on(db.query_one("SELECT recurrence->>'occurrence_date' FROM app.tasks WHERE id=$1", &[&id]))
            .unwrap()
            .get(0);
        if now.as_str() > "2026-01-01" {
            break now;
        }
        assert!(Instant::now() < deadline, "the nightly job never rolled the series forward\n{}", fs::read_to_string(root.join("server.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(500));
    };
    // The fired job carries the manifest's retry count (legacy value 0), not the host default of 3.
    let retries: i32 = runtime
        .block_on(db.query_one("SELECT retry_limit FROM moss_queue.jobs WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence' ORDER BY run_at DESC LIMIT 1", &[&owner]))
        .unwrap()
        .get(0);
    assert_eq!(retries, 0, "the nightly job should not retry");
    let (status, list) = call(Method::GET, "/tasks", Some(&cookie), None);
    assert_eq!(status, 200, "{list}");
    let titles: Vec<_> = list["tasks"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_owned()).collect();
    assert!(titles.contains(&"Daily stretch".to_owned()) && titles.contains(&"Water plants".to_owned()), "{list}");
    println!("PASS installed Tasks package over HTTPS: sign-in required, recurring create makes one nightly schedule, the server's own worker ran it and moved 2020-01-01 to {rolled}, and the queued job has retry limit 0 as declared");
    println!("NOT PROVEN: native UI, second physical device, second account over HTTP (setup allows one owner)");
}
