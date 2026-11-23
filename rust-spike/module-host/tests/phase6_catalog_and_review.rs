//! The instance owner installs People through the server's own module endpoints, with the
//! permission prompt first. The server holds no elevated login; a stand-in for the database
//! supervisor hands one to each installer run. Real HTTPS executable.
mod common;
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
fn phase6_catalog_and_review() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js188-install-{}", std::process::id())])
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
    let registry = root.join("registry");
    let keys = common::Keys::new();
    let first = keys.write(&registry, "1.0.0", 1, vec![]);
    private(
        &root.join("registry.json"),
        &json!({"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}),
    );
    // Stands in for the database supervisor's credentials command.
    let supervisor = root.join("supervisor.sh");
    fs::write(
        &supervisor,
        format!("#!/bin/sh\necho '{}'\n", json!({"install_url": bootstrap_url})),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&supervisor, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let log = |path: &str| fs::read_to_string(root.join(path)).unwrap_or_default();
    let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
    command
        .env("MOSS_DB_PROGRAM", &supervisor)
        .arg("serve")
        .arg("--instance")
        .arg(root)
        .arg("--web")
        .arg(root.join("web"));
    let mut server = Server(
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
    use reqwest::Method;
    let api = |method: reqwest::Method, path: &str, body: Option<Value>, cookie: Option<&str>| {
        let mut request = client.request(method, format!("{origin}{path}")).header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let Ok(response) = request.send() else { return (0, Value::Null) };
        (response.status().as_u16(), response.json::<Value>().unwrap_or(Value::Null))
    };
    assert_eq!(api(Method::GET, "/api/modules/catalog", None, None).0, 401);
    let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(status, 200, "catalog contract: {catalog}");
    assert_eq!(catalog["sources"][0]["id"], "sample-registry");
    assert_eq!(catalog["modules"][0]["digest"], first.digest);
    assert_eq!(catalog["modules"][0]["source"], "sample-registry");
    let review = || {
        let (status, value) = api(Method::POST, "/api/modules/review", Some(json!({"module":"sample.counter","source":"sample-registry"})), Some(&cookie));
        assert_eq!(status, 200, "review contract: {value}");
        value
    };
    let reviewed = review();
    assert_eq!(reviewed["review"]["digest"], first.digest);
    assert!(reviewed["review"]["capabilities"].as_array().is_some_and(|v| !v.is_empty()));
    assert!(reviewed["review"]["migrations"].is_array());
    let operation = reviewed["id"].as_str().unwrap();
    let execute_path = format!("/api/modules/operations/{operation}/execute");
    let status_path = format!("/api/modules/operations/{operation}");
    // An account that cannot manage modules cannot inspect or execute the owner's operation.
    let signup = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin)
        .json(&json!({"name":"Member","email":"member@example.test","password":"temporary-member-password-js403"})).send().unwrap();
    assert_eq!(signup.status(), 200);
    let member = signup.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    for path in ["/api/modules/catalog", &status_path] {
        assert_eq!(api(Method::GET, path, None, Some(&member)).0, 403);
    }
    assert_eq!(api(Method::POST, &execute_path, Some(json!({"approve":true})), Some(&member)).0, 403);
    assert_eq!(api(Method::POST, &execute_path, Some(json!({"approve":false})), Some(&cookie)).0, 400);
    // The queued operation and review survive server restart.
    server.0.kill().unwrap(); server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if api(Method::GET, "/api/hello", None, None).0 == 200 { break; }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(api(Method::GET, &status_path, None, Some(&cookie)).1, reviewed);
    let execute = || api(Method::POST, &execute_path, Some(json!({"approve":true})), Some(&cookie));
    std::thread::scope(|scope| {
        let one = scope.spawn(&execute); let two = scope.spawn(&execute);
        for result in [one.join().unwrap(), two.join().unwrap()] {
            assert_eq!(result.0, 202, "{result:?}");
            assert_eq!(result.1["id"], operation);
        }
    });
    let wait = |id: &str| {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let (status, value) = api(Method::GET, &format!("/api/modules/operations/{id}"), None, Some(&cookie));
            assert_eq!(status, 200, "{value}");
            if ["succeeded", "failed"].contains(&value["stage"].as_str().unwrap()) { break value; }
            assert!(Instant::now() < deadline, "operation timed out: {value}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let completed = wait(operation);
    assert_eq!(completed["stage"], "succeeded", "{completed}");
    assert_eq!(execute().1, completed, "retry returns the same result");
    // A second trusted source remains distinct, even for the same module and publisher.
    let second_dir = root.join("second-registry");
    keys.write(&second_dir, "1.0.0", 1, vec![]);
    let mut identity: Value = serde_json::from_slice(&fs::read(second_dir.join("registry.json")).unwrap()).unwrap();
    identity["id"] = json!("second-registry");
    let bytes = serde_json::to_vec(&identity).unwrap();
    fs::write(second_dir.join("registry.json"), &bytes).unwrap();
    fs::write(second_dir.join("registry.json.sig"), common::Keys::sign(&keys.root, &bytes)).unwrap();
    fs::remove_file(root.join("registry.json")).unwrap();
    private(&root.join("registry.json"), &json!({"registries":[
        {"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)},
        {"id":"second-registry","folder":second_dir,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}
    ]}));
    let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(status, 200, "{catalog}");
    assert_eq!(catalog["sources"].as_array().unwrap().len(), 2);
    assert_eq!(catalog["modules"].as_array().unwrap().len(), 2);
    assert_eq!(api(Method::POST, "/api/modules/review", Some(json!({"module":"sample.counter","source":"missing"})), Some(&cookie)).0, 400);
    // Review v2, change its bytes after review, and preserve the running v1 on refusal.
    let next = keys.write(&registry, "2.0.0", 2, vec![]);
    let stale = review();
    assert_eq!(stale["review"]["digest"], next.digest);
    fs::write(registry.join(format!("packages/{}.mosspkg", next.digest)), b"changed after review").unwrap();
    let id = stale["id"].as_str().unwrap();
    assert_eq!(api(Method::POST, &format!("/api/modules/operations/{id}/execute"), Some(json!({"approve":true})), Some(&cookie)).0, 202);
    let failed = wait(id);
    assert_eq!(failed["stage"], "failed", "changed bytes must refuse: {failed}");
    let (_, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(catalog["modules"][0]["installedDigest"], first.digest);
    server.0.kill().unwrap(); server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(api(Method::GET, &status_path, None, Some(&cookie)).1, completed);
    println!("PASS phase6_catalog_and_review: signed sources, review, auth, concurrent execution, restart and changed bytes refusal with old digest retained");
    println!("NOT PROVEN: UI, remote HTTPS registry, process kill during SQL, three-OS behavior");
}
