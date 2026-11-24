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
fn phase6_lifecycle_api() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js413-lifecycle-{}", std::process::id())])
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
    private(
        &root.join("registry.json"),
        &json!({"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}),
    );
    // Stands in for the database supervisor's credentials command.
    let supervisor = root.join("supervisor.sh");
    fs::write(
        &supervisor,
        format!(
            "#!/bin/sh\necho '{}'\n",
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
    let install = || {
        let (status, value) = api(
            Method::POST,
            "/api/modules/install",
            Some(json!({"module":"sample.counter","approve":true,"version":"1.0.0"})),
            Some(&cookie),
        );
        assert_eq!(status, 200, "{value}");
    };
    install();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (mut db, connection) = runtime
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    runtime.spawn(async move {
        let _ = connection.await;
    });
    let owner: uuid::Uuid = runtime
        .block_on(db.query_one(
            "SELECT id::text FROM app.users WHERE email='bootstrap-owner@example.test'",
            &[],
        ))
        .unwrap()
        .get::<_, String>(0)
        .parse()
        .unwrap();
    // Setup closes signup after the owner. Seed disposable credential accounts, then
    // obtain sessions through the real sign-in route, as in the catalog/review runner.
    let sign_in_account = |email: &str, admin: bool| {
        let id = uuid::Uuid::new_v4();
        runtime.block_on(async {
            db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Lifecycle account',$2,false,$3,'active')", &[&id,&email,&admin]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=$2::uuid AND provider_id='credential'", &[&id,&owner]).await.unwrap();
        });
        let response = client.post(format!("{origin}/api/auth/sign-in/email"))
            .header("origin", &origin)
            .json(&json!({"email":email,"password":"temporary-bootstrap-password-179-not-a-real-secret"}))
            .send().unwrap();
        assert_eq!(response.status(), 200, "lifecycle account sign-in");
        let session = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        (id, session)
    };
    let (member, member_cookie) = sign_in_account("lifecycle-member@example.test", false);
    let (_, other_admin_cookie) = sign_in_account("lifecycle-admin@example.test", true);
    let original = vec!["other account private row", "owner row"];
    for (account, title) in [(owner, original[1]), (member, original[0])] {
        runtime
            .block_on(db.execute(
                "INSERT INTO app.sample_counter_entries(id,owner_user_id,title) VALUES($1,$2,$3)",
                &[&uuid::Uuid::new_v4(), &account, &title],
            ))
            .unwrap();
    }
    let rows = || {
        runtime.block_on(async {
            let (reader, connection) =
                tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            reader
                .query(
                    "SELECT title FROM app.sample_counter_entries ORDER BY title",
                    &[],
                )
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<_, String>(0))
                .collect::<Vec<_>>()
        })
    };
    let revision = || {
        runtime.block_on(async {
            let (reader, connection) =
                tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            reader
                .query_one(
                    "SELECT revision FROM moss_modules.catalog WHERE id=true",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, i64>(0)
        })
    };
    let module_folder = root.join("modules/modules/files/sample.counter");
    let file_root = vault::Root::create(&module_folder).unwrap();
    for account in [owner, member] {
        let access = access_context::AccessContext::new(account, "lifecycle-fixture");
        let cx = vault::VaultContext::for_module_files(&file_root, &access).unwrap();
        cx.write("kv.json", br#"{"counter":{"kept":true}}"#)
            .unwrap();
        cx.create_dir("vault").unwrap();
        cx.write("vault/kept.txt", b"retained module file").unwrap();
    }
    let files_kept = || {
        let folder = vault::Root::open(&module_folder).unwrap();
        for account in [owner, member] {
            let access = access_context::AccessContext::new(account, "lifecycle-check");
            let cx = vault::VaultContext::for_module_files(&folder, &access).unwrap();
            assert_eq!(cx.read("kv.json").unwrap(), br#"{"counter":{"kept":true}}"#);
            assert_eq!(cx.read("vault/kept.txt").unwrap(), b"retained module file");
        }
    };
    let before = revision();
    let snapshots_before = api(Method::GET, "/api/modules/snapshots", None, Some(&cookie)).1;
    let (status, value) = api(
        Method::POST,
        "/api/modules/remove",
        Some(json!({"module":"sample.counter","typedName":"wrong","deleteData":true})),
        Some(&cookie),
    );
    assert_eq!(status, 202, "lifecycle submission: {value}");
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
    let operation_id = value["id"].as_str().unwrap();
    let operation_path = format!("/api/modules/operations/{operation_id}");
    let cancel_path = format!("{operation_path}/cancel");
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    for (method, path, body) in [
        (
            Method::POST,
            "/api/modules/remove",
            Some(json!({"module":"sample.counter"})),
        ),
        (
            Method::POST,
            "/api/modules/restore",
            Some(
                json!({"module":"sample.counter","snapshot":snapshot_id,"typedName":"Counter","acknowledgeDataLoss":true}),
            ),
        ),
        (Method::GET, "/api/modules/snapshots", None),
        (Method::GET, operation_path.as_str(), None),
        (Method::POST, cancel_path.as_str(), None),
    ] {
        assert_eq!(
            api(method.clone(), path, body.clone(), None).0,
            401,
            "anonymous lifecycle request: {path}"
        );
        assert_eq!(
            api(method, path, body, Some(&member_cookie)).0,
            403,
            "non-admin lifecycle request: {path}"
        );
    }
    for (method, path) in [
        (Method::GET, operation_path.as_str()),
        (Method::POST, cancel_path.as_str()),
    ] {
        assert_eq!(
            api(method, path, None, Some(&other_admin_cookie)).0,
            403,
            "another administrator must not own the session operation: {path}"
        );
    }
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/remove",
            Some(json!({"module":"sample.counter","actor":owner})),
            Some(&member_cookie)
        )
        .0,
        422,
        "payload actor must be refused rather than replacing the session"
    );
    println!("PASS anonymous and non-admin lifecycle requests refuse; other admin cannot read or cancel; payload actor refuses");
    let mismatch = wait(operation_id);
    assert_eq!(mismatch["stage"], "failed", "{mismatch}");
    assert!(
        mismatch["result"]["message"]
            .as_str()
            .unwrap()
            .contains("Type the module name"),
        "{mismatch}"
    );
    assert_eq!(revision(), before);
    assert_eq!(rows(), original);
    files_kept();
    let (status, snapshots) = api(Method::GET, "/api/modules/snapshots", None, Some(&cookie));
    assert_eq!(status, 200, "{snapshots}");
    assert_eq!(
        snapshots, snapshots_before,
        "a refusal must not take another snapshot"
    );
    println!("PASS typed-name mismatch refused before changes");
    let submit = |path: &str, body: Value| {
        let (status, value) = api(Method::POST, path, Some(body), Some(&cookie));
        assert_eq!(status, 202, "{path}: {value}");
        value["id"].as_str().unwrap().to_owned()
    };
    let remove = || submit("/api/modules/remove", json!({"module":"sample.counter"}));
    let delete = || {
        submit(
            "/api/modules/remove",
            json!({"module":"sample.counter","deleteData":true,"typedName":"Sample counter"}),
        )
    };
    let restore = |id: &str| {
        submit(
            "/api/modules/restore",
            json!({"module":"sample.counter","snapshot":id,"typedName":"Sample counter","acknowledgeDataLoss":true}),
        )
    };
    let succeeded = |id: &str| {
        let value = wait(id);
        assert_eq!(value["stage"], "succeeded", "{value}");
        value
    };
    let id = remove();
    let removed = succeeded(&id);
    assert_eq!(rows(), original);
    files_kept();
    install();
    assert_eq!(rows(), original);
    files_kept();
    assert_eq!(
        api(
            Method::GET,
            &format!("/api/modules/operations/{id}"),
            None,
            Some(&cookie)
        )
        .1,
        removed
    );
    println!("PASS remove and real reinstall retain both accounts' rows");
    let deleted = succeeded(&delete());
    assert!(deleted["result"]["message"]
        .as_str()
        .unwrap()
        .contains("snapshot"));
    assert!(runtime
        .block_on(db.query_one(
            "SELECT to_regclass('app.sample_counter_entries') IS NULL",
            &[]
        ))
        .unwrap()
        .get::<_, bool>(0));
    let (status, snapshots) = api(Method::GET, "/api/modules/snapshots", None, Some(&cookie));
    assert_eq!(status, 200, "{snapshots}");
    let snapshot = snapshots
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["reason"] == "delete-data")
        .unwrap();
    let snapshot_id = snapshot["id"].as_str().unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(snapshot["expires"].as_str().unwrap()).unwrap()
            - chrono::DateTime::parse_from_rfc3339(snapshot["created"].as_str().unwrap()).unwrap()
            == chrono::Duration::days(30)
    );
    assert!(!snapshots.to_string().contains("other account private row"));
    assert!(
        snapshot.get("previous").is_none(),
        "public metadata must omit stored module record"
    );
    succeeded(&restore(snapshot_id));
    assert_eq!(rows(), original);
    files_kept();
    // Ordinary runtime role remains subject to owner RLS even for an administrator.
    let tx = runtime.block_on(db.transaction()).unwrap();
    let role = moss_module_host::database::runtime_role("sample.counter");
    runtime
        .block_on(tx.batch_execute(&format!("SET LOCAL ROLE {role}")))
        .unwrap();
    runtime
        .block_on(tx.query_one(
            "SELECT set_config('app.actor_user_id',$1,true)",
            &[&owner.to_string()],
        ))
        .unwrap();
    assert_eq!(
        runtime
            .block_on(tx.query_one("SELECT count(*) FROM app.sample_counter_entries", &[]))
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    runtime.block_on(tx.rollback()).unwrap();
    println!(
        "PASS delete snapshots all accounts, restore returns identical rows and preserves RLS"
    );
    // Real retained metadata is expired in the isolated fixture, then exercised through HTTP.
    let meta_path = root
        .join("modules/modules/snapshots/sample.counter")
        .join(snapshot_id)
        .join("snapshot.json");
    let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    meta["expires"] = json!((chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339());
    fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let expired = wait(&restore(snapshot_id));
    assert_eq!(expired["stage"], "failed", "{expired}");
    assert!(
        expired["result"]["message"]
            .as_str()
            .unwrap()
            .contains("expired"),
        "{expired}"
    );
    assert_eq!(rows(), original);
    files_kept();
    println!("PASS expired snapshot refuses with plain reason and unchanged rows");
    // Hold activation after purge, so a real child is interrupted with its journal durable.
    let tx = runtime.block_on(db.transaction()).unwrap();
    runtime
        .block_on(tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtext('moss:module-catalog'))",
            &[],
        ))
        .unwrap();
    let interrupted = delete();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let purged = runtime.block_on(async {
            let (reader, connection) =
                tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            reader
                .query_one(
                    "SELECT to_regclass('app.sample_counter_entries') IS NULL",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, bool>(0)
        });
        if purged && root.join("modules/modules/operation.json").exists() {
            break;
        }
        if Instant::now() >= deadline {
            let saved: Value = serde_json::from_slice(
                &fs::read(
                    root.join("module-operations")
                        .join(format!("{interrupted}.json")),
                )
                .unwrap(),
            )
            .unwrap();
            let locks = runtime.block_on(tx.query("SELECT mode,granted,coalesce(relation::regclass::text,'') FROM pg_locks WHERE relation IS NOT NULL AND pid <> pg_backend_pid()", &[])).unwrap();
            let locks: Vec<_> = locks
                .iter()
                .map(|r| {
                    (
                        r.get::<_, String>(0),
                        r.get::<_, bool>(1),
                        r.get::<_, String>(2),
                    )
                })
                .collect();
            panic!(
                "purge boundary not reached: stage={} result={} journal={} locks={locks:?}",
                saved["view"]["stage"],
                saved["view"]["result"],
                root.join("modules/modules/operation.json").exists()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("PASS real purge committed while catalog activation is held");
    assert_eq!(
        api(
            Method::POST,
            &format!("/api/modules/operations/{interrupted}/cancel"),
            Some(json!({})),
            Some(&cookie)
        )
        .0,
        409,
        "running changes complete or recover safely"
    );
    let queued = remove();
    let cancel_path = format!("/api/modules/operations/{queued}/cancel");
    let cancelled = api(Method::POST, &cancel_path, Some(json!({})), Some(&cookie));
    assert_eq!(cancelled.0, 200, "{cancelled:?}");
    assert_eq!(cancelled.1["stage"], "failed");
    assert!(cancelled.1["result"]["message"]
        .as_str()
        .unwrap()
        .contains("cancelled"));
    // Find only this server's direct child processes; never inspect environments or credentials.
    let mut killed = false;
    for thread in fs::read_dir(format!("/proc/{}/task", server.0.id())).unwrap() {
        let children =
            fs::read_to_string(thread.unwrap().path().join("children")).unwrap_or_default();
        for pid in children.split_whitespace() {
            let args = fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            if args
                .split(|b| *b == 0)
                .any(|arg| arg == b"lifecycle-module")
            {
                assert!(Command::new("kill")
                    .args(["-KILL", pid])
                    .status()
                    .unwrap()
                    .success());
                killed = true;
            }
        }
    }
    assert!(killed, "killed the real migration child during deletion");
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    runtime.block_on(tx.rollback()).unwrap();
    server = Server(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(30);
    while api(Method::GET, "/api/hello", None, None).0 != 200 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(100));
    }
    let recovered = wait(&interrupted);
    assert_eq!(recovered["stage"], "failed", "{recovered}");
    assert_eq!(rows(), original);
    files_kept();
    assert_eq!(wait(&queued), cancelled.1);
    assert!(!root.join("modules/modules/operation.json").exists());
    assert_eq!(
        api(
            Method::GET,
            &format!("/api/modules/operations/{interrupted}"),
            None,
            Some(&cookie)
        )
        .1,
        recovered
    );
    println!("PASS child crash after purge and server restart recover all rows; queued cancel stays unchanged; results survive");
    let expired_again = wait(&restore(snapshot_id));
    assert_eq!(expired_again["stage"], "failed");
    assert!(expired_again["result"]["message"]
        .as_str()
        .unwrap()
        .contains("expired"));
    let _ = &server;
}
