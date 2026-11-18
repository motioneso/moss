//! A fresh instance gets People through the installer alone: no hand-made tables, settings
//! file or restart. Real HTTPS executable; not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
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
#[ignore = "Only through verify-gate and the module bootstrap gate"]
fn installer_alone_brings_a_fresh_instance_to_serving_people() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js179-bootstrap-{}", std::process::id())])
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
        "<!doctype html><title>x</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    // The stored login is the real migration owner. Only the install run gets the stronger one.
    let migration_url = std::env::var("JS43_MIGRATION_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-bootstrap-signing-secret-179","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    // What the app writes at setup. There is no owner account and there are no module tables yet.
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("modules"),"migrations_url":migration_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let log = |path: &str| fs::read_to_string(root.join(path)).unwrap_or_default();
    let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
    command
        .arg("serve")
        .arg("--instance")
        .arg(root)
        .arg("--web")
        .arg(root.join("web"));
    let _server = Server(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("server.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while !client
        .get(format!("{origin}/api/hello"))
        .send()
        .is_ok_and(|r| r.status().is_success())
    {
        assert!(Instant::now() < deadline, "server startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let signup = client
        .post(format!("{origin}/api/auth/sign-up/email"))
        .header("origin", &origin)
        .json(&json!({"name":"Bootstrap owner","email":"bootstrap-owner@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"}))
        .send()
        .unwrap();
    assert_eq!(signup.status(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let call = |method: reqwest::Method, path: &str, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/people{path}"))
            .header("origin", &origin)
            .header("cookie", &cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap();
        (
            response.status().as_u16(),
            response.json::<Value>().unwrap_or(Value::Null),
        )
    };
    use reqwest::Method;
    assert_eq!(
        call(Method::GET, "/people", None).0,
        503,
        "nothing installed yet"
    );
    let registry = root.join("registry");
    let keys = installed::publish(&registry);
    let output = Command::new(std::env::var("JS170_SERVER").unwrap())
        .env("MOSS_INSTALL_DATABASE_URL", &bootstrap_url)
        .arg("install-module")
        .arg("--instance")
        .arg(root)
        .args(["--registry-id", "people-test-registry", "--registry-folder"])
        .arg(&registry)
        .args([
            "--root-key",
            &keys.root,
            "--first-party-key",
            &keys.publisher,
            "--approve",
        ])
        .args(["person-providers", "people"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    let owner_folder = {
        let stored: Value =
            serde_json::from_slice(&fs::read(root.join("modules.json")).unwrap()).unwrap();
        root.join("notes")
            .join(stored["admin_user_id"].as_str().expect("owner recorded"))
    };
    // The running server picks the module up with no restart.
    let deadline = Instant::now() + Duration::from_secs(30);
    let (mut status, mut list) = call(Method::GET, "/people", None);
    while status != 200 {
        assert!(
            Instant::now() < deadline,
            "not served after install: {status} {list}\n{}",
            log("server.log")
        );
        std::thread::sleep(Duration::from_millis(500));
        (status, list) = call(Method::GET, "/people", None);
    }
    let saved = call(
        Method::PUT,
        "/people/notes-settings",
        Some(json!({"folder": owner_folder})),
    );
    assert_eq!(saved.0, 200, "{}\n{}", saved.1, log("server.log"));
    let created = call(
        Method::POST,
        "/people",
        Some(json!({"displayName":"Grace Hopper"})),
    );
    assert_eq!(created.0, 200, "{}\n{}", created.1, log("server.log"));
    assert!(owner_folder
        .join(created.1["notePath"].as_str().unwrap())
        .is_file());
    let (_, mine) = call(Method::GET, "/people", None);
    assert!(mine.to_string().contains("Grace Hopper"), "{mine}");
    println!("PASS fresh instance: installer alone prepared tables, recorded the owner and installed People; the running server served it with no restart and no hand-made file");
    println!(
        "NOT PROVEN: second device, native UI, installing from a remote registry over the network"
    );
}
