//! Real HTTPS server and signed registry fixtures for the Phase 6 management boundary.
mod common;
#[path = "phase6_catalog_and_review/fixtures.rs"]
mod fixtures;
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
fn phase6_update_api() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js410-update-{}", std::process::id())])
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
    let first = fixtures::publish(&keys, &registry, "1.0.0", 1);
    private(
        &root.join("registry.json"),
        &json!({"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}),
    );
    // Stands in for the database supervisor's credentials command.
    let supervisor = root.join("supervisor.sh");
    fs::write(
        &supervisor,
        format!(
            "#!/bin/sh\nwhile [ -e '{}' ]; do touch '{}'; sleep 0.1; done\necho '{}'\n",
            root.join("hold-installer").display(),
            root.join("installer-waiting").display(),
            json!({"install_url": bootstrap_url})
        ),
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
        let mut request = client
            .request(method, format!("{origin}{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let Ok(response) = request.send() else {
            return (0, Value::Null);
        };
        (
            response.status().as_u16(),
            response.json::<Value>().unwrap_or(Value::Null),
        )
    };
    for path in [
        "/api/modules/update-review",
        "/api/modules/sample.counter/update",
        "/api/modules/sample.counter/skip",
        "/api/modules/sample.counter/pin",
    ] {
        assert_eq!(
            api(Method::POST, path, Some(json!({})), None).0,
            401,
            "session required: {path}"
        );
    }
    let review = |path: &str| {
        let (status, value) = api(
            Method::POST,
            path,
            Some(json!({"module":"sample.counter","source":"sample-registry"})),
            Some(&cookie),
        );
        assert_eq!(status, 200, "review {path}: {value}");
        value
    };
    let wait = |id: &str| {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let (status, value) = api(
                Method::GET,
                &format!("/api/modules/operations/{id}"),
                None,
                Some(&cookie),
            );
            assert_eq!(status, 200, "{value}");
            if ["succeeded", "failed"].contains(&value["stage"].as_str().unwrap()) {
                break value;
            }
            assert!(Instant::now() < deadline, "operation deadline: {value}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/update-review",
            Some(json!({"module":"sample.counter","source":"sample-registry"})),
            Some(&cookie)
        )
        .0,
        422,
        "update requires an installed module"
    );
    let initial = review("/api/modules/review");
    assert_eq!(
        api(
            Method::POST,
            &format!(
                "/api/modules/operations/{}/execute",
                initial["id"].as_str().unwrap()
            ),
            Some(json!({"approve":true})),
            Some(&cookie)
        )
        .0,
        202
    );
    assert_eq!(wait(initial["id"].as_str().unwrap())["stage"], "succeeded");
    let installed = || {
        let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
        assert_eq!(status, 200, "{catalog}");
        catalog["modules"][0].clone()
    };
    let health = || {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let response = api(
                Method::GET,
                "/api/m/sample.counter/health",
                None,
                Some(&cookie),
            );
            if response.0 == 200 {
                assert_eq!(response.1["live"], true);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "old module must work: {response:?}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    health();
    let update = |operation: &Value, approve: bool| {
        api(
            Method::POST,
            "/api/modules/sample.counter/update",
            Some(json!({"operation":operation["id"],"approve":approve})),
            Some(&cookie),
        )
    };
    // Both kinds of growth must wait, including an urgent offer.
    for (serial, growth) in [(2, "capability"), (3, "migration")] {
        if std::env::var("JS410_GROWTH").is_ok_and(|only| only != growth) {
            continue;
        }
        let offered =
            fixtures::publish_update(&keys, &registry, &format!("{serial}.0.0"), serial, growth);
        let pending = review("/api/modules/update-review");
        assert_eq!(pending["review"]["urgent"], true);
        assert_eq!(pending["review"]["previous"], first.digest);
        if growth == "capability" {
            assert!(!pending["review"]["permissions"]
                .as_array()
                .unwrap()
                .is_empty());
        } else {
            assert!(!pending["review"]["migrations"]
                .as_array()
                .unwrap()
                .is_empty());
        }
        assert_eq!(
            update(&pending, false).0,
            400,
            "urgent still needs approval"
        );
        assert_eq!(
            api(
                Method::POST,
                "/api/modules/install",
                Some(json!({"module":"sample.counter"})),
                Some(&cookie)
            )
            .0,
            422,
            "growth needs host approval even when urgent: {growth}"
        );
        assert_eq!(
            installed()["installedDigest"],
            first.digest,
            "unapproved digest {}",
            offered.digest
        );
        health();
    }
    let stale = review("/api/modules/update-review");
    fixtures::publish_update(&keys, &registry, "4.0.0", 4, "capability");
    assert_eq!(update(&stale, true).0, 202);
    assert_eq!(
        wait(stale["id"].as_str().unwrap())["stage"],
        "failed",
        "changed digest must refuse stale review"
    );
    assert_eq!(installed()["installedDigest"], first.digest);
    health();
    let same_version = review("/api/modules/update-review");
    fixtures::publish_update(&keys, &registry, "4.0.0", 5, "migration");
    assert_eq!(update(&same_version, true).0, 202);
    assert_eq!(
        wait(same_version["id"].as_str().unwrap())["stage"],
        "failed",
        "same version changed digest must refuse stale review"
    );
    fixtures::publish_update(&keys, &registry, "5.0.0", 6, "capability");
    assert_eq!(installed()["installedDigest"], first.digest);
    health();
    let (status, _) = api(
        Method::POST,
        "/api/modules/sample.counter/update",
        Some(json!({"operation":stale["id"],"approve":true,"actor":"forged"})),
        Some(&cookie),
    );
    assert_eq!(status, 422, "payload actor must be refused");
    let offer = installed();
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/sample.counter/skip",
            Some(json!({"source":"sample-registry","digest":first.digest})),
            Some(&cookie)
        )
        .0,
        422,
        "skip must name the current offer"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/sample.counter/pin",
            Some(json!({"source":"sample-registry","version":"9.0.0"})),
            Some(&cookie)
        )
        .0,
        422,
        "pin must name the installed version"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/sample.counter/skip",
            Some(json!({"source":"sample-registry","digest":offer["digest"]})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/sample.counter/pin",
            Some(json!({"source":"sample-registry","version":"1.0.0"})),
            Some(&cookie)
        )
        .0,
        200
    );
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(30);
    while api(Method::GET, "/api/hello", None, None).0 != 200 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        installed()["skippedDigest"],
        offer["digest"],
        "skip survives restart"
    );
    assert_eq!(installed()["pin"], "1.0.0", "pin survives restart");
    let pinned = review("/api/modules/update-review");
    assert_eq!(update(&pinned, true).0, 202);
    assert_eq!(
        wait(pinned["id"].as_str().unwrap())["stage"],
        "failed",
        "pin prevents update"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/sample.counter/pin",
            Some(json!({"source":"sample-registry","version":null})),
            Some(&cookie)
        )
        .0,
        200
    );
    fixtures::publish_update(&keys, &registry, "6.0.0", 7, "unhealthy");
    let broken = review("/api/modules/update-review");
    assert_eq!(update(&broken, true).0, 202);
    assert_eq!(
        wait(broken["id"].as_str().unwrap())["stage"],
        "failed",
        "health failure refuses activation"
    );
    assert_eq!(
        installed()["installedDigest"],
        first.digest,
        "failed update keeps old digest"
    );
    health();
    fixtures::publish_update(&keys, &registry, "7.0.0", 8, "capability");
    let good = review("/api/modules/update-review");
    assert_eq!(update(&good, true).0, 202);
    assert_eq!(
        wait(good["id"].as_str().unwrap())["stage"],
        "succeeded",
        "approved update must work"
    );
    assert_eq!(installed()["installedDigest"], good["review"]["digest"]);
    health();
    drop(server);
}
