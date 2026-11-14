//! Installed Weather package served by the real HTTPS executable. Not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
use common::Keys;
use moss_module_host::{
    archive::Package,
    registry::{Artifact, Channel, Index, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use std::collections::{BTreeMap, BTreeSet};
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
#[ignore = "Only through verify-gate and the Weather live gate"]
fn installed_weather_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js278-weather-{}", std::process::id())])
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
    if let Ok(shared) = std::env::var("MOSS_MODULE_SHARED_DIR") {
        // Generated shared styles and fonts, which the sandboxed screens load.
        let status = Command::new("cp")
            .args(["-r", &shared])
            .arg(root.join("web/module-shared"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Weather HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    let ai_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-weather-signing-secret-278","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-weather-password-278-not-a-real-secret"})).send().unwrap();
        let status = response.status();
        if status != 200 {
            panic!("sign-up answered {status}: {}", response.text().unwrap_or_default());
        }
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("weather-owner@example.test", "Weather owner");
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
                "SELECT id FROM app.users WHERE email='weather-owner@example.test'",
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
    let access = AccessContext::new(owner, "weather-install");
    // Publish the Weather package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_WEATHER_PACKAGE", "weather")]
    .iter()
    .map(|(variable, id)| {
        let bytes = fs::read(std::env::var(variable).unwrap()).unwrap();
        let digest = trust::digest(&bytes);
        let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
        let manifest = &package.manifest;
        assert_eq!(manifest.id, *id);
        fs::write(root.join(format!("registry/packages/{digest}.mosspkg")), &bytes).unwrap();
        Artifact {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            digest: digest.clone(),
            size: bytes.len() as u64,
            publisher_key: "weather-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Weather live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "weather-test-registry".into(),
        name: "Weather test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "weather-test".into(),
            Publisher {
                key: Keys::public(&keys.publisher),
                prefix: String::new(),
                replaces: BTreeSet::new(),
            },
        )]),
        lifted_revocations: BTreeSet::new(),
    };
    let index = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: vec![],
    };
    for (name, data, key) in [
        ("registry.json", serde_json::to_vec(&identity).unwrap(), &keys.root),
        ("index.json", serde_json::to_vec(&index).unwrap(), &keys.index),
    ] {
        fs::write(root.join("registry").join(name), &data).unwrap();
        fs::write(root.join("registry").join(format!("{name}.sig")), Keys::sign(key, &data)).unwrap();
    }
    let installer = installed::reopen(
        &root.join("data"),
        app,
        &access,
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    );
    let source = installer
        .refresh(
            &access,
            Source::Folder(root.join("registry")),
            &Keys::public(&keys.root),
            &Keys::public(&keys.publisher),
            "weather-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key}),
    );
    let _server = start(true);
    // Setup allows one owner over HTTP, so the second person is made in the database with the
    // owner's password hash and then signs in through the real route.
    let other = {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let id = uuid::Uuid::new_v4();
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Weather other', 'weather-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"weather-other@example.test","password":"temporary-weather-password-278-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/weather{path}")).header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{method_path} -> {status}", method_path = path);
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    // A private place name and coordinates that must never reach the server log.
    const MARK: &str = "PLANTED-LIVE-MARKER-9c41";
    const MARK_LAT: f64 = 12.345678;
    assert_eq!(call(Method::GET, "/today", None, None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = std::time::Instant::now();
    while call(Method::GET, "/unit", Some(&cookie), None).0 == 503 && started.elapsed() < std::time::Duration::from_secs(60) {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/unit", Some(who), None);
        assert_eq!((status, json_of(&text)), (200, json!({"unit":"imperial"})), "{text}\n{}", log());
        assert_eq!(json_of(&call(Method::GET, "/location", Some(who), None).1), json!({"location":null}));
    }
    // The old Settings paths reach the same package.
    for (path, key) in [("/api/me/weather-unit", "unit"), ("/api/me/weather-location", "location")] {
        let old = client.get(format!("{origin}{path}")).header("origin", &origin).header("cookie", &other).send().unwrap();
        assert_eq!(old.status().as_u16(), 200, "{path}");
        assert!(json_of(&old.text().unwrap()).get(key).is_some(), "{path}");
    }
    let old = client.get(format!("{origin}/api/me/weather-location/search?query=Seattle")).header("origin", &origin).header("cookie", &cookie).send().unwrap();
    assert_eq!(old.status().as_u16(), 200);
    // Real place search through the real fetch path.
    let (status, text) = call(Method::GET, "/location/search?query=Seattle", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let first = json_of(&text)["candidates"][0].clone();
    assert!(first["label"].as_str().unwrap().starts_with("Seattle"), "{text}");
    // The owner saves Seattle and the metric unit. The other person is untouched.
    let (status, text) = call(Method::PUT, "/location", Some(&cookie), Some(first.clone()));
    assert_eq!(status, 200, "{text}");
    assert_eq!(call(Method::PUT, "/unit", Some(&cookie), Some(json!({"unit":"metric"}))).0, 200);
    assert_eq!(json_of(&call(Method::GET, "/location", Some(&cookie), None).1)["location"]["label"], first["label"]);
    assert_eq!(json_of(&call(Method::GET, "/location", Some(&other), None).1), json!({"location":null}));
    assert_eq!(json_of(&call(Method::GET, "/unit", Some(&other), None).1), json!({"unit":"imperial"}));
    // Real Open-Meteo reading and hourly window for the saved place.
    let (status, text) = call(Method::GET, "/today", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let today = json_of(&text);
    assert!(today["data"]["temp"].is_number() && today["data"]["unit"] == "metric", "{text}");
    assert_eq!(today["data"]["location"], first["label"]);
    let (status, text) = call(Method::GET, "/forecast?startHour=8&endHour=20", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let forecast = json_of(&text);
    assert_eq!(forecast["status"], "forecast", "{text}");
    assert!(!forecast["forecast"]["intervals"].as_array().unwrap().is_empty(), "{text}");
    // The other person has no place, and this test connects from loopback, which is skipped,
    // so there is nothing to guess and no reading.
    assert_eq!(json_of(&call(Method::GET, "/today", Some(&other), None).1), json!({"data":null}));
    // Bad input is refused with fixed words.
    assert_eq!(call(Method::PUT, "/unit", Some(&cookie), Some(json!({"unit":"kelvin"}))).0, 400);
    assert_eq!(call(Method::PUT, "/location", Some(&cookie), Some(json!({"lat":MARK_LAT,"lon":999,"label":MARK}))).0, 400);
    // A private name is saved and read back, and appears nowhere in the server log.
    let (status, _) = call(Method::PUT, "/location", Some(&other), Some(json!({"lat":MARK_LAT,"lon":45.0,"label":MARK})));
    assert_eq!(status, 200);
    assert_eq!(json_of(&call(Method::GET, "/location", Some(&other), None).1)["location"]["label"], MARK);
    assert_eq!(json_of(&call(Method::GET, "/location", Some(&cookie), None).1)["location"]["label"], first["label"]);
    let text = log();
    assert!(!text.contains(MARK) && !text.contains("12.345678"), "private place reached the server log");
    // The planted text is in no table other than the saved-setting row: not jobs, not activity,
    // not the shared forecast cache. A planted leak in another table must make the scan fail.
    let scan = || {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tables = db.query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('app','moss_queue','moss_modules') AND table_name<>'preferences'", &[]).await.unwrap();
            for table in tables {
                let name: String = table.get(0);
                let count: i64 = db.query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE '%'||$1||'%' OR t::text LIKE '%12.345678%'"), &[&MARK]).await.unwrap().get(0);
                assert_eq!(count, 0, "the planted place reached {name}");
            }
        })
    };
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.execute("UPDATE app.users SET name=$1 WHERE email='weather-other@example.test'", &[&MARK]).await.unwrap();
    });
    let leak = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&scan));
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.execute("UPDATE app.users SET name='Weather other' WHERE email='weather-other@example.test'", &[]).await.unwrap();
    });
    assert!(leak.is_err(), "the scan must catch a planted leak");
    println!("privacy scan FAILED with a leak planted");
    scan();
    println!("privacy scan PASSED with no leak");
    // The owner clears the place.
    assert_eq!(json_of(&call(Method::PUT, "/location", Some(&cookie), Some(Value::Null)).1), json!({"location":null}));
    println!("weather live: place, unit and real forecasts for two people worked over HTTPS");
}
