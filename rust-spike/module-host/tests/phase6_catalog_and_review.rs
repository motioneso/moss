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
    assert_eq!(api(Method::GET, "/api/modules/catalog", None, None).0, 401);
    let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(status, 200, "catalog contract: {catalog}");
    assert_eq!(catalog["sources"][0]["id"], "sample-registry");
    assert_eq!(catalog["modules"][0]["digest"], first.digest);
    assert_eq!(catalog["modules"][0]["source"], "sample-registry");
    let review = || {
        let (status, value) = api(
            Method::POST,
            "/api/modules/review",
            Some(json!({"module":"sample.counter","source":"sample-registry"})),
            Some(&cookie),
        );
        assert_eq!(status, 200, "review contract: {value}");
        value
    };
    let (status, legacy_list) = api(Method::GET, "/api/modules", None, Some(&cookie));
    assert_eq!(status, 200, "{legacy_list}");
    assert_eq!(legacy_list["registry"], "sample-registry");
    let (status, legacy_plan) = api(
        Method::POST,
        "/api/modules/plan",
        Some(json!({"module":"sample.counter"})),
        Some(&cookie),
    );
    assert_eq!(status, 200, "{legacy_plan}");
    assert_eq!(legacy_plan["version"], "1.0.0");
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/install",
            Some(json!({"module":"sample.counter"})),
            Some(&cookie)
        )
        .0,
        422
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/install",
            Some(json!({"module":"sample.counter","approve":true,"version":"0.0.1"})),
            Some(&cookie)
        )
        .0,
        422
    );
    let reviewed = review();
    assert_eq!(reviewed["review"]["digest"], first.digest);
    assert!(!serde_json::to_string(&reviewed)
        .unwrap()
        .contains(&bootstrap_url));
    assert!(!serde_json::to_string(&catalog)
        .unwrap()
        .contains(&bootstrap_url));
    assert!(reviewed["review"]["capabilities"]
        .as_array()
        .is_some_and(|v| !v.is_empty()));
    assert!(reviewed["review"]["migrations"].is_array());
    let operation = reviewed["id"].as_str().unwrap();
    let execute_path = format!("/api/modules/operations/{operation}/execute");
    let status_path = format!("/api/modules/operations/{operation}");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (db, connection) = runtime
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    runtime.spawn(async move {
        connection.await.unwrap();
    });
    // Setup only creates one owner; seed a member with the owner's disposable password hash,
    // then obtain its session through the real sign-in route (as other installed gates do).
    let owner_id: uuid::Uuid = runtime
        .block_on(db.query_one(
            "SELECT id::text FROM app.users WHERE email='bootstrap-owner@example.test'",
            &[],
        ))
        .unwrap()
        .get::<_, String>(0)
        .parse()
        .unwrap();
    let member_id = uuid::Uuid::new_v4();
    runtime.block_on(async {
        db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Member','member@example.test',false,false,'active')", &[&member_id]).await.unwrap();
        db.execute("INSERT INTO app.auth_accounts (id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=$2::uuid AND provider_id='credential'", &[&member_id,&owner_id]).await.unwrap();
    });
    let signup = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
        .json(&json!({"email":"member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(signup.status(), 200, "member sign-in");
    let member = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    for path in ["/api/modules/catalog", &status_path] {
        assert_eq!(api(Method::GET, path, None, Some(&member)).0, 403);
    }
    assert_eq!(
        api(
            Method::POST,
            &execute_path,
            Some(json!({"approve":true})),
            Some(&member)
        )
        .0,
        403
    );
    runtime
        .block_on(db.execute(
            "UPDATE app.users SET is_instance_admin=true WHERE id=$1",
            &[&member_id],
        ))
        .unwrap();
    assert_eq!(
        api(Method::GET, &status_path, None, Some(&member)).0,
        403,
        "another admin cannot read the review"
    );
    assert_eq!(
        api(
            Method::POST,
            &execute_path,
            Some(json!({"approve":true})),
            Some(&member)
        )
        .0,
        403,
        "another admin cannot execute the review"
    );
    runtime
        .block_on(db.execute(
            "UPDATE app.users SET is_instance_admin=false WHERE id=$1",
            &[&member_id],
        ))
        .unwrap();
    assert_eq!(
        api(
            Method::POST,
            &execute_path,
            Some(json!({"approve":false})),
            Some(&cookie)
        )
        .0,
        400
    );
    // The queued operation and review survive server restart.
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if api(Method::GET, "/api/hello", None, None).0 == 200 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        api(Method::GET, &status_path, None, Some(&cookie)).1,
        reviewed
    );
    let execute = || {
        api(
            Method::POST,
            &execute_path,
            Some(json!({"approve":true})),
            Some(&cookie),
        )
    };
    std::thread::scope(|scope| {
        let one = scope.spawn(&execute);
        let two = scope.spawn(&execute);
        for result in [one.join().unwrap(), two.join().unwrap()] {
            assert_eq!(result.0, 202, "{result:?}");
            assert_eq!(result.1["id"], operation);
        }
    });
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
            assert!(Instant::now() < deadline, "operation timed out: {value}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let completed = wait(operation);
    assert_eq!(completed["stage"], "succeeded", "{completed}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let health = api(
            Method::GET,
            "/api/m/sample.counter/health",
            None,
            Some(&cookie),
        );
        if health.0 == 200 {
            assert_eq!(health.1["live"], true);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "installed guest must serve its real route: {health:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let files = vault::Root::create(&root.join("modules/modules/files")).unwrap();
    let module_files = files.create_subdir("sample.counter").unwrap();
    let access = access_context::AccessContext::new(owner_id, "phase6-preserved-data");
    let data = vault::VaultContext::for_module_files(&module_files, &access).unwrap();
    data.write(
        "kv.json",
        br#"{"counter":{"marker":"kept across refused update"}}"#,
    )
    .unwrap();
    let revision = || {
        runtime
            .block_on(db.query_one(
                "SELECT revision FROM moss_modules.catalog WHERE id=true",
                &[],
            ))
            .unwrap()
            .get::<_, i64>(0)
    };
    // Recheck after the server gate waits, and inside a child started after role revocation.
    let pending_auth = review();
    let queued_auth = review();
    fs::write(root.join("hold-installer"), b"hold").unwrap();
    let execute_review = |value: &Value| {
        api(
            Method::POST,
            &format!(
                "/api/modules/operations/{}/execute",
                value["id"].as_str().unwrap()
            ),
            Some(json!({"approve":true})),
            Some(&cookie),
        )
    };
    assert_eq!(execute_review(&pending_auth).0, 202);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join("installer-waiting").exists() {
        assert!(
            Instant::now() < deadline,
            "installer should reach supervisor"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(execute_review(&queued_auth).0, 202);
    assert_eq!(
        api(
            Method::GET,
            &format!(
                "/api/modules/operations/{}",
                queued_auth["id"].as_str().unwrap()
            ),
            None,
            Some(&cookie)
        )
        .1["stage"],
        "queued"
    );
    runtime.block_on(db.execute("UPDATE app.users SET is_instance_admin=false WHERE email='bootstrap-owner@example.test'", &[])).unwrap();
    assert_eq!(execute_review(&queued_auth).0, 403);
    fs::remove_file(root.join("hold-installer")).unwrap();
    // While authorization is revoked, inspect only the private host journal to await completion.
    for value in [&pending_auth, &queued_auth] {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let saved: Value = serde_json::from_slice(
                &fs::read(
                    root.join("module-operations")
                        .join(format!("{}.json", value["id"].as_str().unwrap())),
                )
                .unwrap(),
            )
            .unwrap();
            if saved["view"]["stage"] == "failed" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "revoked operation must fail: {saved}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    runtime.block_on(db.execute("UPDATE app.users SET is_instance_admin=true WHERE email='bootstrap-owner@example.test'", &[])).unwrap();
    let before_retry = revision();
    assert_eq!(execute().1, completed, "retry returns the same result");
    assert_eq!(revision(), before_retry, "retry must not activate again");
    // A second trusted source remains distinct, even for the same module and publisher.
    let second_dir = root.join("second-registry");
    fixtures::publish(&keys, &second_dir, "1.0.0", 1);
    let mut identity: Value =
        serde_json::from_slice(&fs::read(second_dir.join("registry.json")).unwrap()).unwrap();
    identity["id"] = json!("second-registry");
    let bytes = serde_json::to_vec(&identity).unwrap();
    fs::write(second_dir.join("registry.json"), &bytes).unwrap();
    fs::write(
        second_dir.join("registry.json.sig"),
        common::Keys::sign(&keys.root, &bytes),
    )
    .unwrap();
    fs::remove_file(root.join("registry.json")).unwrap();
    private(
        &root.join("registry.json"),
        &json!({"registries":[
            {"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)},
            {"id":"second-registry","folder":second_dir,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}
        ]}),
    );
    let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(status, 200, "{catalog}");
    assert_eq!(catalog["sources"].as_array().unwrap().len(), 2);
    assert_eq!(catalog["modules"].as_array().unwrap().len(), 2);
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/review",
            Some(json!({"module":"sample.counter","source":"missing"})),
            Some(&cookie)
        )
        .0,
        400
    );
    // A different trusted folder cannot inherit a review, even with identical signed bytes.
    let changed_source = review();
    let original_configuration = fs::read(root.join("registry.json")).unwrap();
    let moved_registry = root.join("moved-registry");
    fs::create_dir_all(moved_registry.join("packages")).unwrap();
    for name in ["registry.json", "registry.json.sig", "index.json", "index.json.sig"] {
        fs::copy(registry.join(name), moved_registry.join(name)).unwrap();
    }
    let package = format!("packages/{}.mosspkg", first.digest);
    fs::copy(registry.join(&package), moved_registry.join(&package)).unwrap();
    let mut configuration: Value = serde_json::from_slice(&original_configuration).unwrap();
    configuration["registries"][0]["folder"] = json!(moved_registry);
    fs::remove_file(root.join("registry.json")).unwrap();
    private(&root.join("registry.json"), &configuration);
    assert_eq!(execute_review(&changed_source).0, 202);
    let changed_result = wait(changed_source["id"].as_str().unwrap());
    assert_eq!(
        changed_result["stage"], "failed",
        "a changed trusted source must require a new review: {changed_result}"
    );
    fs::remove_file(root.join("registry.json")).unwrap();
    private(
        &root.join("registry.json"),
        &serde_json::from_slice(&original_configuration).unwrap(),
    );
    // A newer signed selection cannot inherit approval of the previously reviewed digest.
    let next = fixtures::publish(&keys, &registry, "2.0.0", 2);
    let stale = review();
    assert_eq!(stale["review"]["digest"], next.digest);
    let newest = fixtures::publish(&keys, &registry, "3.0.0", 3);
    let stale_id = stale["id"].as_str().unwrap();
    assert_eq!(
        api(
            Method::POST,
            &format!("/api/modules/operations/{stale_id}/execute"),
            Some(json!({"approve":true})),
            Some(&cookie)
        )
        .0,
        202
    );
    let stale_result = wait(stale_id);
    assert_eq!(
        stale_result["stage"], "failed",
        "new signed bytes must not inherit review: {stale_result}"
    );
    // Even the reviewed filename must be hashed again when execution downloads its bytes.
    let stale = review();
    assert_eq!(stale["review"]["digest"], newest.digest);
    fs::write(
        registry.join(format!("packages/{}.mosspkg", newest.digest)),
        b"changed after review",
    )
    .unwrap();
    let id = stale["id"].as_str().unwrap();
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
    let failed = wait(id);
    assert_eq!(
        failed["stage"], "failed",
        "changed bytes must refuse: {failed}"
    );
    let (_, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(catalog["modules"][0]["installedDigest"], first.digest);
    assert_eq!(
        api(
            Method::GET,
            "/api/m/sample.counter/health",
            None,
            Some(&cookie)
        )
        .0,
        200,
        "old signed guest remains callable after refusal"
    );
    assert!(data
        .read_to_string("kv.json")
        .unwrap()
        .contains("kept across refused update"));
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    server = Server(command.spawn().unwrap());
    assert!(server.0.try_wait().unwrap().is_none());
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        api(Method::GET, &status_path, None, Some(&cookie)).1,
        completed
    );
    println!("PASS phase6_catalog_and_review: signed sources and configuration binding, review, auth, concurrent execution, restart and changed bytes refusal with old digest retained");
    println!("NOT PROVEN: UI, remote HTTPS registry, process kill during SQL, three-OS behavior");
}
