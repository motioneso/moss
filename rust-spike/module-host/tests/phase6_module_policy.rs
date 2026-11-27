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
fn phase6_module_policy() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js415-policy-{}", std::process::id())])
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
        .env("MOSS_TEST_REFRESH_DIAGNOSTICS", "1")
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
    assert_eq!(
        api(Method::GET, "/api/modules/policy", None, Some(&cookie)).0,
        503,
        "module policy endpoint exists before modules are ready"
    );
    // A second account signs in through the same real authentication boundary.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (db, connection) = rt
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    rt.spawn(async move {
        let _ = connection.await;
    });
    let member = uuid::Uuid::new_v4();
    rt.block_on(async {
        db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Policy member','policy-member@example.test',false,false,'active')", &[&member]).await.unwrap();
        db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'", &[&member]).await.unwrap();
    });
    let login = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin).json(&json!({"email":"policy-member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(login.status(), 200);
    let member_cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let account_path = "/api/modules/sample.counter/account-switch";
    let server_path = "/api/modules/sample.counter/server-switch";
    for path in [
        account_path,
        server_path,
        "/api/modules/policy",
        "/api/modules/refresh",
    ] {
        assert_eq!(
            api(Method::POST, path, Some(json!({})), None).0,
            401,
            "session required"
        );
    }
    let review = api(
        Method::POST,
        "/api/modules/review",
        Some(json!({"module":"sample.counter","source":"sample-registry"})),
        Some(&cookie),
    );
    assert_eq!(review.0, 200, "{review:?}");
    let id = review.1["id"].as_str().unwrap();
    assert_eq!(
        api(
            Method::POST,
            &format!("/api/modules/operations/{id}/execute"),
            Some(json!({"approve":true})),
            Some(&cookie)
        )
        .0,
        202
    );
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let operation = api(
            Method::GET,
            &format!("/api/modules/operations/{id}"),
            None,
            Some(&cookie),
        )
        .1;
        if operation["stage"] == "succeeded" {
            break;
        }
        assert_ne!(operation["stage"], "failed", "{operation}");
        assert!(Instant::now() < deadline, "installation deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let health = |who: &str| api(Method::GET, "/api/m/sample.counter/health", None, Some(who)).0;
    let deadline = Instant::now() + Duration::from_secs(30);
    while health(&cookie) != 200 {
        assert!(Instant::now() < deadline, "host load deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(health(&member_cookie), 200);
    assert_eq!(
        api(Method::GET, "/api/modules/policy", None, Some(&cookie)).1,
        json!({"automatic":true,"quietTime":false}),
        "safe default update policy"
    );
    assert_eq!(
        api(
            Method::POST,
            account_path,
            Some(json!({"enabled":false,"actorUserId":member})),
            Some(&cookie)
        )
        .0,
        422,
        "payload actor refused"
    );
    assert_eq!(
        api(
            Method::POST,
            account_path,
            Some(json!({"enabled":false})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_ne!(health(&cookie), 200, "account-off refuses its own route");
    assert_eq!(
        health(&member_cookie),
        200,
        "account-off leaves other accounts on"
    );
    assert_eq!(
        api(
            Method::POST,
            server_path,
            Some(json!({"enabled":false})),
            Some(&member_cookie)
        )
        .0,
        403,
        "server switch is admin only"
    );
    assert_eq!(
        api(
            Method::POST,
            server_path,
            Some(json!({"enabled":false})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_ne!(
        health(&member_cookie),
        200,
        "admin-off stops other accounts"
    );
    assert_ne!(health(&cookie), 200);
    assert_eq!(
        api(
            Method::POST,
            server_path,
            Some(json!({"enabled":true})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_ne!(
        health(&cookie),
        200,
        "admin lift preserves manual account-off"
    );
    assert_eq!(health(&member_cookie), 200);
    assert_eq!(
        api(
            Method::POST,
            account_path,
            Some(json!({"enabled":true})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_eq!(health(&cookie), 200);
    println!("PASS switches: account isolation, admin off, manual off survives lift");

    let deadline = Instant::now() + Duration::from_secs(65);
    while !root.join("module-refresh.json").exists() {
        assert!(Instant::now() < deadline, "initial start refresh");
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_secs(1));
    // Observe the source file, not a mocked transport or a service call counter.
    let count_file = root.join("index-opens");
    let ready = root.join("watch-ready");
    let _watcher = Server(
        Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/phase6_module_policy/watch.py"
            ))
            .arg(&registry)
            .arg(&count_file)
            .arg(&ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let count = || -> u64 { fs::read_to_string(&count_file).unwrap().parse().unwrap() };
    let refresh = || {
        let response = api(
            Method::POST,
            "/api/modules/refresh",
            Some(json!({})),
            Some(&cookie),
        );
        assert_eq!(response.0, 200, "{response:?}");
        assert!(
            response.1["sources"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["error"].is_null()),
            "refresh source failed: {response:?}\nServer log (last 30 lines):\n{}",
            fs::read_to_string(root.join("server.log"))
                .unwrap_or_else(|error| format!("Could not read server log: {error}"))
                .lines()
                .rev()
                .take(30)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        );
    };
    let policy = |automatic: bool, quiet: bool| {
        let response = api(
            Method::POST,
            "/api/modules/policy",
            Some(json!({"automatic":automatic,"quietTime":quiet})),
            Some(&cookie),
        );
        assert_eq!(response.0, 200, "{response:?}");
    };
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/policy",
            Some(json!({"automatic":true,"quietTime":true})),
            Some(&member_cookie)
        )
        .0,
        403,
        "update policy is admin only"
    );
    policy(true, true);
    // Each catalog open refreshes once; its projection reads the saved catalog.
    let before = count();
    assert_eq!(
        api(Method::GET, "/api/modules/catalog", None, Some(&cookie)).0,
        200
    );
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(count() - before, 1, "open reaches real client once");
    let before = count();
    assert_eq!(
        api(Method::GET, "/api/shell", None, Some(&member_cookie)).0,
        200
    );
    std::thread::sleep(Duration::from_millis(100));
    let deadline = Instant::now() + Duration::from_secs(10);
    while count() == before {
        assert!(
            Instant::now() < deadline,
            "app open reaches real client once"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(count() - before, 1, "app open reaches real client once");
    let pin = |version: Value| {
        assert_eq!(
            api(
                Method::POST,
                "/api/modules/sample.counter/pin",
                Some(json!({"source":"sample-registry","version":version})),
                Some(&cookie)
            )
            .0,
            200
        )
    };
    pin(json!("1.0.0"));
    fixtures::publish(&keys, &registry, "2.0.0", 2);
    refresh();
    let digest = || {
        let response = api(
            Method::GET,
            "/api/modules/sample.counter/account-switch",
            None,
            Some(&cookie),
        );
        assert_eq!(response.0, 200, "{response:?}");
        response.1["digest"].as_str().unwrap().to_string()
    };
    assert_eq!(digest(), first.digest, "pinned update never auto-activates");
    pin(Value::Null);
    policy(false, true);
    refresh();
    assert_eq!(
        digest(),
        first.digest,
        "manual update policy refuses auto-activation"
    );
    policy(true, false);
    refresh();
    assert_eq!(
        digest(),
        first.digest,
        "ordinary update waits for quiet time"
    );
    policy(true, true);
    refresh();
    assert_ne!(digest(), first.digest, "safe quiet-time update activates");
    let safe = digest();
    for (serial, growth) in [(3, "capability"), (4, "migration")] {
        if std::env::var("JS415_GROWTH").is_ok_and(|only| only != growth) {
            continue;
        }
        fixtures::publish_update(&keys, &registry, &format!("{serial}.0.0"), serial, growth);
        refresh();
        assert_eq!(digest(), safe, "{growth} growth never auto-activates");
    }
    println!("PASS automatic updates: pin, manual policy, quiet time, urgent capability/migration growth");
    policy(false, true);
    assert_eq!(
        api(
            Method::POST,
            account_path,
            Some(json!({"enabled":false})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_eq!(
        api(
            Method::POST,
            server_path,
            Some(json!({"enabled":false})),
            Some(&cookie)
        )
        .0,
        200
    );
    // A restart is a new start event regardless of the persisted daily timestamp.
    let before = count();
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("restart.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    while count() == before {
        assert!(
            Instant::now() < deadline,
            "start refresh must reach real client"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(count() - before, 1, "start reaches real client once");
    let saved = api(Method::GET, "/api/modules/policy", None, Some(&cookie));
    assert_eq!(
        saved.1,
        json!({"automatic":false,"quietTime":true}),
        "policy persists across restart"
    );
    // Advance only the persisted daily due time, never the production scheduler or client.
    let before = count();
    let clock_file = root.join("module-refresh.json");
    let mut clock: Value = serde_json::from_slice(&fs::read(&clock_file).unwrap()).unwrap();
    clock["lastAttempt"] = json!(0);
    fs::write(&clock_file, serde_json::to_vec(&clock).unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(75);
    while count() == before {
        assert!(
            Instant::now() < deadline,
            "daily refresh must reach real client"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(count() - before, 1, "daily reaches real client once");
    assert_ne!(
        health(&member_cookie),
        200,
        "server-off persists across restart"
    );
    assert_eq!(
        api(
            Method::POST,
            server_path,
            Some(json!({"enabled":true})),
            Some(&cookie)
        )
        .0,
        200
    );
    assert_ne!(
        health(&cookie),
        200,
        "manual account-off persists across restart and admin lift"
    );
    assert_eq!(health(&member_cookie), 200);
    println!("PASS refresh: start, daily and open each read the real signed index exactly once; policy survives restart");
    drop(server);
}
