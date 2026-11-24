//! Real HTTPS server and signed registry fixtures for the Phase 6 management boundary.
mod common;
#[path = "phase6_lifecycle_api/fixtures.rs"]
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
fn phase6_install_requests() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js416-requests-{}", std::process::id())])
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
    let _first = fixtures::publish(&keys, &registry, "1.0.0", 1);
    let other_registry = root.join("other-registry");
    fixtures::publish(&keys, &other_registry, "1.0.0", 1);
    let mut identity: Value =
        serde_json::from_slice(&fs::read(other_registry.join("registry.json")).unwrap()).unwrap();
    identity["id"] = json!("other-registry");
    let identity = serde_json::to_vec(&identity).unwrap();
    fs::write(other_registry.join("registry.json"), &identity).unwrap();
    fs::write(
        other_registry.join("registry.json.sig"),
        common::Keys::sign(&keys.root, &identity),
    )
    .unwrap();
    private(
        &root.join("registry.json"),
        &json!({"registries":[
            {"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)},
            {"id":"other-registry","folder":other_registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}
        ]}),
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
    let wait_ready = || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !client
            .get(format!("{origin}/api/hello"))
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            assert!(Instant::now() < deadline, "server startup deadline");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    wait_ready();
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
        // Approval acknowledges queued work; it must not wait for the paused installer.
        if path.ends_with("/approve") {
            request = request.timeout(Duration::from_secs(3));
        }
        let response = match request.send() {
            Ok(response) => response,
            Err(error) => {
                eprintln!(
                    "request {path} failed: timeout={}, connect={}",
                    error.is_timeout(),
                    error.is_connect()
                );
                return (0, Value::Null);
            }
        };
        (
            response.status().as_u16(),
            response.json::<Value>().unwrap_or(Value::Null),
        )
    };
    // Reuse the existing credential hash to sign in a non-admin through real auth.
    let member_rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (member_db, member_connection) = member_rt
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    member_rt.spawn(async move {
        let _ = member_connection.await;
    });
    let member = uuid::Uuid::new_v4();
    member_rt.block_on(async {
        member_db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Registry member','request-member@example.test',false,false,'active')", &[&member]).await.unwrap();
        member_db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'", &[&member]).await.unwrap();
    });
    let response = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin).json(&json!({"email":"request-member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(response.status(), 200);
    let member_cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let second = uuid::Uuid::new_v4();
    member_rt.block_on(async {
        member_db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Other member','other-member@example.test',false,false,'active')", &[&second]).await.unwrap();
        member_db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'", &[&second]).await.unwrap();
    });
    let second_login = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin).json(&json!({"email":"other-member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(second_login.status(), 200);
    let second_cookie = second_login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let pick = json!({"module":"sample.counter","source":"sample-registry"});
    for (method, path, body) in [
        (Method::POST, "/api/modules/requests", Some(pick.clone())),
        (Method::GET, "/api/modules/requests", None),
        (
            Method::GET,
            "/api/modules/requests/00000000-0000-0000-0000-000000000000",
            None,
        ),
        (
            Method::POST,
            "/api/modules/requests/00000000-0000-0000-0000-000000000000/approve",
            Some(json!({"operation":uuid::Uuid::new_v4(),"approve":true})),
        ),
    ] {
        assert_eq!(
            api(method, path, body, None).0,
            401,
            "existing session boundary: {path}"
        );
    }
    assert_eq!(api(Method::POST, "/api/modules/requests", Some(json!({"module":"sample.counter","source":"sample-registry","ownerAccountId":second})), Some(&member_cookie)).0, 422, "REFUSAL: payload cannot name an owner");
    let reply = api(
        Method::POST,
        "/api/modules/requests",
        Some(pick.clone()),
        Some(&member_cookie),
    );
    assert_eq!(reply.0, 200, "member request must succeed: {}", reply.1);
    assert_eq!(reply.1["status"], "pending");
    assert_eq!(reply.1["ownerAccountId"], member.to_string());
    assert_eq!(
        reply.1["notice"], "unsupported",
        "never pretend a notice was sent"
    );
    let id = reply.1["id"].as_str().unwrap().to_string();
    let path = format!("/api/modules/requests/{id}");
    assert_eq!(
        api(Method::GET, &path, None, Some(&second_cookie)).0,
        404,
        "REFUSAL: another account cannot read the request"
    );
    assert_eq!(
        api(
            Method::GET,
            "/api/modules/requests",
            None,
            Some(&second_cookie)
        )
        .1["requests"],
        json!([])
    );
    let other = api(
        Method::POST,
        "/api/modules/requests",
        Some(pick.clone()),
        Some(&second_cookie),
    );
    assert_eq!(other.0, 200);
    assert_ne!(other.1["id"], id);
    let own_list = api(
        Method::GET,
        "/api/modules/requests",
        None,
        Some(&member_cookie),
    );
    assert_eq!(own_list.1["requests"].as_array().unwrap().len(), 1);
    assert_eq!(own_list.1["requests"][0]["id"], id);
    let unavailable = api(
        Method::POST,
        "/api/modules/requests",
        Some(json!({"module":"sample.missing","source":"sample-registry"})),
        Some(&member_cookie),
    );
    assert_eq!(
        unavailable.0, 422,
        "REFUSAL: unavailable module cannot be requested"
    );
    assert!(unavailable.1["error"]
        .as_str()
        .unwrap()
        .contains("unavailable"));
    assert!(!unavailable.1.to_string().contains("postgres"));
    let admin_list = api(Method::GET, "/api/modules/requests", None, Some(&cookie));
    assert_eq!(admin_list.0, 200);
    assert_eq!(admin_list.1["requests"].as_array().unwrap().len(), 2);
    for private_field in [
        "password",
        "email",
        "connector_key",
        "postgres://",
        "private account content",
    ] {
        assert!(
            !admin_list.1.to_string().contains(private_field),
            "request metadata projection: {private_field}"
        );
    }
    let notices = || {
        let out = api(Method::GET, "/api/desktop/notices", None, Some(&cookie));
        assert_eq!(out.0, 200, "existing recipient feed: {}", out.1);
        out.1["events"].clone()
    };
    let before_notices = notices();
    // Verify why fan-out cannot use the existing app-runtime notification contract.
    member_rt.block_on(async {
        let database = safety_core::db::Database::connect(&app_url, 1, safety_core::db::RuntimeRole::App).await.unwrap();
        let access = access_context::AccessContext::new(member, "notification-recipient-probe");
        let cx = safety_core::db::DataContext::open(&database, &access).await.unwrap();
        let owner: uuid::Uuid = member_db.query_one("SELECT id FROM app.users WHERE email='bootstrap-owner@example.test'", &[]).await.unwrap().get(0);
        let error = cx.db().execute("INSERT INTO app.notifications(id,actor_user_id,recipient_user_id,title) VALUES($1,$2,$3,'Install request recipient probe')", &[&uuid::Uuid::new_v4(), &member, &owner]).await.unwrap_err();
        assert_eq!(error.code().map(|c| c.code()), Some("42501"), "recipient-only notification policy");
    });
    std::thread::scope(|threads| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                threads.spawn(|| {
                    api(
                        Method::POST,
                        "/api/modules/requests",
                        Some(pick.clone()),
                        Some(&member_cookie),
                    )
                })
            })
            .collect();
        for handle in handles {
            let duplicate = handle.join().unwrap();
            assert_eq!(duplicate.0, 200);
            assert_eq!(duplicate.1["id"], id, "duplicate request identity");
        }
    });
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    wait_ready();
    assert!(server.0.try_wait().unwrap().is_none());
    let restarted = api(
        Method::POST,
        "/api/modules/requests",
        Some(pick.clone()),
        Some(&member_cookie),
    );
    assert_eq!(restarted.0, 200);
    assert_eq!(
        restarted.1["id"], id,
        "restart preserves duplicate suppression"
    );
    assert_eq!(restarted.1["status"], "pending");
    assert_eq!(
        notices(),
        before_notices,
        "unsupported notices remain absent after duplicates and restart"
    );
    println!("request submission, ownership, duplicate/restart persistence: passed; admin notice delivery unsupported (recipient-only policy 42501)");
    let review = api(
        Method::POST,
        "/api/modules/review",
        Some(pick.clone()),
        Some(&cookie),
    );
    assert_eq!(review.0, 200, "real admin review: {}", review.1);
    let operation = review.1["id"].as_str().unwrap().to_string();
    let approval = format!("{path}/approve");
    let approved = json!({"operation":operation,"approve":true});
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(approved.clone()),
            Some(&member_cookie)
        )
        .0,
        403,
        "member cannot execute admin approval"
    );
    assert!(
        api(Method::GET, &path, None, Some(&member_cookie)).1["operationId"].is_null(),
        "REFUSAL: member cannot bind approval"
    );
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(json!({"operation":operation,"approve":false})),
            Some(&cookie)
        )
        .0,
        400,
        "REFUSAL: approval must be explicit"
    );
    let wrong_review = api(
        Method::POST,
        "/api/modules/review",
        Some(json!({"module":"sample.counter","source":"other-registry"})),
        Some(&cookie),
    );
    assert_eq!(
        wrong_review.0, 200,
        "second configured source review: {}",
        wrong_review.1
    );
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(json!({"operation":wrong_review.1["id"],"approve":true})),
            Some(&cookie)
        )
        .0,
        409,
        "REFUSAL: review must match the requested source"
    );
    // A registry change after review must still fail through part 1's real execution path.
    fixtures::publish(&keys, &registry, "2.0.0", 2);
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(approved.clone()),
            Some(&cookie)
        )
        .0,
        202
    );
    let wait_status = |expected: &str| {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let (status, value) = api(Method::GET, &path, None, Some(&member_cookie));
            assert_eq!(status, 200);
            if value["status"] == expected {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "request result deadline: {value}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let failed = wait_status("failed");
    assert_eq!(failed["operationId"], operation);
    // The failed install bootstraps the serving host. Startup refresh also asks
    // the supervisor for credentials, so finish it before pausing that supervisor.
    // Otherwise approval can wait behind refresh rather than the queued installer.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let policy = api(Method::GET, "/api/modules/policy", None, Some(&cookie));
        if policy.0 == 200 {
            break;
        }
        assert_eq!(policy.0, 503, "waiting for the module host: {policy:?}");
        assert!(Instant::now() < deadline, "module host startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let refreshed = api(Method::POST, "/api/modules/refresh", None, Some(&cookie));
    assert_eq!(
        refreshed.0, 200,
        "startup refresh before installer pause: {refreshed:?}"
    );
    println!("startup refresh completed before paused-installer check");
    let fresh = api(
        Method::POST,
        "/api/modules/review",
        Some(pick.clone()),
        Some(&cookie),
    );
    assert_eq!(fresh.0, 200, "fresh review: {}", fresh.1);
    let approved = json!({"operation":fresh.1["id"],"approve":true});
    fs::write(root.join("hold-installer"), "hold").unwrap();
    let retry = api(
        Method::POST,
        &approval,
        Some(approved.clone()),
        Some(&cookie),
    );
    assert_eq!(
        retry.0, 202,
        "failed request needs a fresh reviewed retry: {}",
        retry.1
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join("installer-waiting").exists() {
        assert!(Instant::now() < deadline, "installer must reach supervisor");
        std::thread::sleep(Duration::from_millis(100));
    }
    let quick_client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let pending = quick_client
        .get(format!("{origin}{path}"))
        .header("cookie", &member_cookie)
        .send();
    fs::remove_file(root.join("hold-installer")).unwrap();
    assert_eq!(
        pending
            .expect("status must remain readable during installation")
            .status(),
        200
    );
    let completed = wait_status("succeeded");
    assert_eq!(completed["id"], id);
    assert_eq!(completed["operationId"], fresh.1["id"]);
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(approved.clone()),
            Some(&cookie)
        )
        .0,
        202,
        "completed approval is idempotent"
    );
    let replacement = api(
        Method::POST,
        "/api/modules/review",
        Some(pick.clone()),
        Some(&cookie),
    );
    assert_eq!(replacement.0, 200);
    assert_eq!(
        api(
            Method::POST,
            &approval,
            Some(json!({"operation":replacement.1["id"],"approve":true})),
            Some(&cookie)
        )
        .0,
        409,
        "REFUSAL: completed binding cannot be replaced"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let result = api(
            Method::GET,
            "/api/m/sample.counter/health",
            None,
            Some(&member_cookie),
        );
        if result.0 == 200 {
            assert_eq!(result.1["live"], true);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "approved module must serve its real route: {}",
            result.1
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let duplicate = api(
        Method::POST,
        "/api/modules/requests",
        Some(pick),
        Some(&member_cookie),
    );
    assert_eq!(duplicate.1["id"], id);
    assert_eq!(duplicate.1["status"], "succeeded");
    assert_eq!(notices(), before_notices);
    println!("admin reviewed approval, stale-byte refusal, fresh-review retry and real module route: passed");
}
