//! Synthetic Wasm integration fixture, not a real reminder producer or native UI proof.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    ai::Intelligence,
    application::{Application, Configuration},
    jobs::{manifest_hash, module_key, specs},
    manifest::{Capability, Route},
    registry::Source,
    runtime::{CallScope, Request},
};
use moss_platform_contracts::Actor;
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::{Secret, SecretCipher},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("unconfigured")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("unconfigured")
    }
}
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
const DEFAULT_REQUEST: &str = r#"{"operation":"post","resource":"alerts","parameters":{"text":"Synthetic module worker alert"}}"#;
fn fixture(fail: bool, request: &str) -> Vec<u8> {
    let reply = r#"{"status":200,"body":{"posted":true}}"#;
    let data = |text: &str| {
        text.bytes()
            .map(|b| format!("\\{b:02x}"))
            .collect::<String>()
    };
    let mut wat =
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/notify@");
    wat = wat.replace("(data (i32.const 128) \"healthy\"))", &format!("(data (i32.const 128) \"healthy\") (data (i32.const 256) \"{}\") (data (i32.const 512) \"{}\"))", data(request), data(reply)));
    let start = wat.find("      local.get $kind i32.load8_u").unwrap();
    let end = wat[start..].find("      i32.const 32))").unwrap() + start;
    wat.replace_range(start..end, &format!(
        "      local.get $kind i32.load8_u i32.const 114 i32.eq local.get $kind i32.load8_u i32.const 106 i32.eq i32.or if\n      i32.const 256 i32.const {} i32.const 32 call $kv\n      {}\n      i32.const 32 i32.load i32.eqz if\n        i32.const 36 i32.const 512 i32.store\n        i32.const 40 i32.const {} i32.store\n      end\n      else\n        i32.const 32 i32.const 0 i32.store\n        i32.const 36 i32.const 128 i32.store\n        i32.const 40 i32.const 7 i32.store\n      end\n", request.len(), if fail { "unreachable" } else { "" }, reply.len()));
    wat::parse_str(wat).unwrap()
}
#[test]
#[ignore = "Only through verify-gate and the assembly gate"]
fn module_worker_and_https_feed_assemble_without_a_desktop() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js170-assembly-{}", std::process::id())])
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
        "<!doctype html><title>Assembly HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-assembly-signing-secret-170","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(5))
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
    let server = start(false);
    let signup = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":"Assembly owner","email":"assembly@example.test","password":"temporary-assembly-password-170-not-a-real-secret"})).send().unwrap();
    assert_eq!(signup.status(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    drop(server);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (db, app, owner) = runtime.block_on(async {
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
                "SELECT id FROM app.users WHERE email='assembly@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        let app = Database::connect(&app_url, 4, RuntimeRole::App)
            .await
            .unwrap();
        (db, app, owner)
    });
    let access = AccessContext::new(owner, "assembly");
    let config = Configuration {
        migrations: Secret::new(bootstrap_url.clone()),
        producer: Secret::new(app_url.clone()),
        cipher: Arc::new(
            SecretCipher::connectors(
                &[("JARVIS_CONNECTOR_SECRET_KEY".into(), connector_key.clone())].into(),
            )
            .unwrap(),
        ),
        intelligence: Arc::new(NoAi),
        version: "0.1.0".parse().unwrap(),
        compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
    };
    let application =
        Application::open_extended(&root.join("data"), app.clone(), access.clone(), config)
            .unwrap();
    let registry = root.join("registry");
    fs::create_dir(&registry).unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(&registry, "1.0.0", 1, vec![]);
    let source = application
        .installer
        .refresh(
            &access,
            Source::Folder(registry),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut manifest = common::manifest("1.0.0");
    manifest.capabilities = vec![
        Capability {
            port: "notify".into(),
            operations: ["post".into()].into(),
            resources: ["alerts".into()].into(),
            allow_private: false,
        },
        Capability {
            port: "jobs".into(),
            operations: ["schedule".into()].into(),
            resources: ["alert".into()].into(),
            allow_private: false,
        },
    ];
    manifest.jobs.insert("alert".into(), Default::default());
    manifest.routes.push(Route {
        method: "POST".into(),
        path: "/alert".into(),
        sign_in: true,
    });
    let mut files = common::files(&manifest);
    let install = |files: &std::collections::BTreeMap<String, Vec<u8>>| {
        let bytes = moss_module_host::archive::pack(files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        application
            .installer
            .import_file(
                &access,
                &source,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    };
    let _ = artifact;
    files.insert("code/module.wasm".into(), fixture(true, DEFAULT_REQUEST));
    install(&files);
    assert!(application
        .installer
        .call(&manifest.id, access.clone(), "route", "null")
        .is_err());
    assert_eq!(
        runtime
            .block_on(db.query_one(
                "SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1",
                &[&owner]
            ))
            .unwrap()
            .get::<_, i64>(0),
        0,
        "A failed invocation must roll its notification back"
    );
    manifest.version = "1.1.0".parse().unwrap();
    files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    files.insert("code/module.wasm".into(), fixture(false, DEFAULT_REQUEST));
    install(&files);
    runtime.block_on(db.execute(
        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notifications:sample.counter',$2)",
        &[&owner, &json!({"enabled": false})],
    )).unwrap();
    application
        .installer
        .call(&manifest.id, access.clone(), "route", "null")
        .unwrap();
    assert_eq!(
        runtime
            .block_on(db.query_one(
                "SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1",
                &[&owner],
            ))
            .unwrap()
            .get::<_, i64>(0),
        0,
        "A muted module must not post into the recipient feed"
    );
    runtime.block_on(db.execute(
        "DELETE FROM app.preferences WHERE owner_user_id=$1 AND key='notifications:sample.counter'", &[&owner],
    )).unwrap();
    // Notification policy, through the same host path the worker uses.
    let mut serial = 10u32;
    let mut variant = |parameters: Value| {
        serial += 1;
        let request = json!({"operation":"post","resource":"alerts","parameters":parameters}).to_string();
        manifest.version = format!("1.{serial}.0").parse().unwrap();
        files.insert("moss.module.json".into(), serde_json::to_vec(&manifest).unwrap());
        files.insert("code/module.wasm".into(), fixture(false, &request));
        install(&files);
        application.installer.call(&manifest.id, access.clone(), "route", "null")
    };
    let shape = |db: &tokio_postgres::Client| {
        runtime.block_on(db.query(
            "SELECT title, body, href, urgency, deferred_until IS NOT NULL, \
                    (SELECT count(*) FROM app.notification_reads r WHERE r.notification_id=n.id) \
               FROM app.notifications n WHERE recipient_user_id=$1 AND module_id='sample.counter' ORDER BY title",
            &[&owner],
        )).unwrap()
    };
    variant(json!({"text":"Keyed A","body":"first body","href":"/tasks/7","eventKey":"k1"})).unwrap();
    let first = shape(&db);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].get::<_, Option<String>>(2).as_deref(), Some("/tasks/7"));
    let notification: uuid::Uuid = runtime.block_on(db.query_one("SELECT id FROM app.notifications WHERE recipient_user_id=$1", &[&owner])).unwrap().get(0);
    runtime.block_on(db.execute("INSERT INTO app.notification_reads(notification_id,user_id) VALUES($1,$2)", &[&notification, &owner])).unwrap();
    variant(json!({"text":"Keyed B","eventKey":"k1"})).unwrap();
    let again = shape(&db);
    assert_eq!(again.len(), 1, "the same event key must update one notification");
    assert_eq!(again[0].get::<_, String>(0), "Keyed B");
    assert_eq!(again[0].get::<_, i64>(5), 0, "an updated notification returns to unread");
    for bad in ["https://evil.example/x", "//evil.example", "/a\\b", "javascript:alert(1)"].iter() {
        assert!(variant(json!({"text":"Bad link","href":bad})).is_err(), "{bad}");
        assert_eq!(shape(&db).len(), 1);
    }
    runtime.block_on(db.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'quiet-hours',$2)", &[&owner, &json!({"enabled":true,"start":"00:00","end":"00:00","timezone":"UTC"})])).unwrap();
    variant(json!({"text":"Quiet normal"})).unwrap();
    variant(json!({"text":"Quiet urgent","urgency":"urgent"})).unwrap();
    let quiet = shape(&db);
    let deferred = |title: &str| quiet.iter().find(|r| r.get::<_, String>(0) == title).unwrap().get::<_, bool>(4);
    assert!(deferred("Quiet normal"), "a normal alert inside quiet hours waits");
    assert!(!deferred("Quiet urgent"), "an urgent alert is never held back");
    let forever = runtime.block_on(db.query_one("SELECT deferred_until = 'infinity' FROM app.notifications WHERE recipient_user_id=$1 AND title='Quiet normal'", &[&owner])).unwrap();
    assert!(forever.get::<_, bool>(0), "start equal to end holds alerts back until quiet hours are switched off");
    runtime.block_on(db.execute("DELETE FROM app.preferences WHERE owner_user_id=$1 AND key='quiet-hours'", &[&owner])).unwrap();
    files.insert("code/module.wasm".into(), fixture(false, DEFAULT_REQUEST));
    manifest.version = "2.0.0".parse().unwrap();
    files.insert("moss.module.json".into(), serde_json::to_vec(&manifest).unwrap());
    install(&files);
    runtime.block_on(db.execute("DELETE FROM app.notifications WHERE recipient_user_id=$1", &[&owner])).unwrap();
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    drop(application);
    // Only the executable below advances and executes this overdue schedule.
    runtime.block_on(async {
        let declarations = specs(&manifest);
        let queue = Queue::connect(&app_url, Role::Producer, declarations.clone()).await.unwrap();
        let id = uuid::Uuid::new_v4();
        queue.schedule(Actor::from_authenticated_session(owner, uuid::Uuid::new_v4()), id, &declarations[0].name, json!({"actorUserId":owner,"moduleId":module_key(&manifest.id),"manifestHash":manifest_hash(&manifest),"jobKind":declarations[0].name,"params":{}}), "* * * * *", "UTC", chrono::Utc::now()-chrono::Duration::minutes(2)).await.unwrap();
    });
    let server = start(true);
    let deadline = Instant::now() + Duration::from_secs(30);
    let client_id = uuid::Uuid::new_v4();
    let notice_id = loop {
        let response = client
            .get(format!("{origin}/api/desktop/notices?client={client_id}"))
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().unwrap();
        if let Some(id) = body["events"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
        {
            break id.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "server worker must run the due schedule and publish to the feed"
        );
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(
        client
            .post(format!("{origin}/api/m/sample.counter/alert"))
            .header("origin", &origin)
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        401
    );
    let reply = client
        .post(format!("{origin}/api/m/sample.counter/alert"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({}))
        .send()
        .unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(reply.json::<Value>().unwrap(), json!({"posted":true}));
    let accepted = client
        .post(format!("{origin}/api/desktop/notices"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({"client":client_id,"events":[notice_id]}))
        .send()
        .unwrap();
    assert_eq!(accepted.status(), 200);
    // A receipt for an older version of a notification never covers its newer update.
    let late = uuid::Uuid::new_v4();
    let stale = client
        .post(format!("{origin}/api/desktop/notices"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({"client":late,"events":[notice_id],"versions":[1]}))
        .send()
        .unwrap();
    assert_eq!(stale.status(), 200);
    let feed: Value = client
        .get(format!("{origin}/api/desktop/notices?client={late}"))
        .header("cookie", &cookie)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(!feed["acknowledged"].as_array().unwrap().iter().any(|id| *id == json!(notice_id)), "a late receipt for an old version does not cover the newer one");
    let notification_id = uuid::Uuid::parse_str(&notice_id).unwrap();
    runtime.block_on(async {
        assert_eq!(db.query_one("SELECT count(*) FROM app.desktop_notification_receipts WHERE user_id=$1 AND client_id=$2 AND notification_id=$3", &[&owner, &client_id, &notification_id]).await.unwrap().get::<_,i64>(0), 1);

        assert!(db.query_one("SELECT count(*) FROM app.notifications WHERE recipient_user_id=$1 AND module_id='sample.counter'", &[&owner]).await.unwrap().get::<_,i64>(0) >= 2);
        assert_eq!(db.query_one("SELECT count(*) FROM app.notification_reads WHERE user_id=$1", &[&owner]).await.unwrap().get::<_,i64>(0), 0);
    });
    // The independent notifier: a device token, no session, no window.
    let device = uuid::Uuid::new_v4();
    let registered: Value = client
        .post(format!("{origin}/api/desktop/notifier"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({"client":device}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    let token = registered["token"].as_str().unwrap().to_owned();
    let feed = |auth: Option<&str>, who: uuid::Uuid| {
        let mut r = client.get(format!("{origin}/api/notifier/notices?client={who}"));
        if let Some(a) = auth {
            r = r.header("authorization", format!("Bearer {a}"));
        }
        r.send().unwrap()
    };
    assert_eq!(feed(None, device).status(), 401);
    assert_eq!(feed(Some(&"x".repeat(64)), device).status(), 401);
    assert_eq!(feed(Some(&token), uuid::Uuid::new_v4()).status(), 401, "a token works only for its own client");
    assert_eq!(feed(Some(&token), device).status(), 200);
    assert_eq!(
        client.get(format!("{origin}/api/today")).header("authorization", format!("Bearer {token}")).send().unwrap().status(),
        401,
        "a device token opens no other route"
    );
    let stored: String = runtime.block_on(db.query_one("SELECT token_hash FROM app.desktop_notifier_devices WHERE client_id=$1", &[&device])).unwrap().get(0);
    assert_ne!(stored, token, "only a hash of the token is stored");
    let fingerprint = String::from_utf8(Command::new("openssl").args(["x509","-noout","-fingerprint","-sha256","-in"]).arg(&cert).output().unwrap().stdout).unwrap();
    let pin = fingerprint.trim().split_once('=').unwrap().1.replace(':', ": ");
    let data = root.join("app-data");
    fs::create_dir(&data).unwrap();
    let app = std::env::var("JS196_APP").unwrap();
    assert!(Command::new(&app).args(["notifier","add","--data"]).arg(&data).args(["--server","s1","--origin",&origin,"--pin",&pin,"--client",&device.to_string(),"--token",&token]).status().unwrap().success());
    let stub = std::env::var("JS196_STUB").unwrap();
    let mut rounds = 0;
    let mut round = || -> Vec<Value> {
        rounds += 1;
        let log = root.join(format!("toasts-{rounds}.jsonl"));
        fs::write(&log, "").unwrap();
        let ran = Command::new("dbus-run-session").arg("--").arg("sh").arg("-c")
            .arg("python3 \"$1\" \"$2\" & stub=$!; sleep 1.5; \"$3\" notifier once --data \"$4\"; code=$?; sleep 0.5; kill $stub; exit $code")
            .arg("sh").arg(&stub).arg(&log).arg(&app).arg(&data)
            .output().unwrap();
        assert!(ran.status.success(), "{}", String::from_utf8_lossy(&ran.stderr));
        println!("round {rounds} notifier stderr: {}", String::from_utf8_lossy(&ran.stderr));
        // The server's own schedule keeps posting its synthetic alert every minute.
        fs::read_to_string(&log).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|t| t["title"] != "Synthetic module worker alert").collect()
    };
    runtime.block_on(db.execute("DELETE FROM app.notifications WHERE recipient_user_id=$1", &[&owner])).unwrap();
    let plant = |title: &str, deferred: bool| -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        runtime.block_on(db.execute(
            "INSERT INTO app.notifications(id,actor_user_id,recipient_user_id,title,body,module_id,deferred_until) VALUES($1,$2,$2,$3,'details','sample.counter', CASE WHEN $4 THEN now()+interval '8 hours' END)",
            &[&id, &owner, &title, &deferred],
        )).unwrap();
        id
    };
    let alert = plant("Alert one", false);
    plant("Held by quiet hours", true);
    let toasts = round();
    assert_eq!(toasts.len(), 1, "{toasts:?}");
    assert_eq!(toasts[0]["title"], "Alert one");
    let second = round();
    assert_eq!(second.len(), 0, "an accepted alert does not show twice: {second:?}");
    runtime.block_on(db.execute("UPDATE app.notifications SET updated_at=now(), title='Alert one again' WHERE id=$1", &[&alert])).unwrap();
    let again = round();
    assert_eq!(again.len(), 1, "a refreshed notification alerts again");
    assert_eq!(again[0]["title"], "Alert one again");
    let read_count: i64 = runtime.block_on(db.query_one("SELECT count(*) FROM app.notification_reads WHERE user_id=$1", &[&owner])).unwrap().get(0);
    assert_eq!(read_count, 0, "desktop alerts never mark bell items read");
    fs::write(data.join("app-active.json"), "s1").unwrap();
    plant("While the window is open", false);
    assert_eq!(round().len(), 0, "the notifier leaves a server the open window already handles");
    fs::remove_file(data.join("app-active.json")).unwrap();
    assert_eq!(round().len(), 1, "with the window closed the notifier alerts");
    assert_eq!(
        client.delete(format!("{origin}/api/desktop/notifier?client={device}")).header("origin", &origin).header("cookie", &cookie).send().unwrap().status(),
        200
    );
    assert_eq!(feed(Some(&token), device).status(), 401, "a removed device token stops working");
    println!("PASS notifier: device token opens only its feed (wrong client, no token, other routes refused; hash only stored); real desktop-service Notify calls captured on a private session bus; quiet-hours holds back; accepted alerts do not repeat, refreshed ones do; no bell reads; window heartbeat hands off; removal revokes");
    drop(server);
    println!("PASS real HTTPS executable: owner signup, existing module catalog, server-owned due schedule execution, synthetic Wasm notification in desktop feed, authenticated module dispatch, durable acknowledgement without bell reads; failed guest rolls notification back; module mute suppresses posts");
    println!("NOT PROVEN: real reminder producers, installed desktop, background process, native target devices or second-device HTTPS");
}
