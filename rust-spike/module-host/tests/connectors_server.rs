//! Installed Connectors package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Connectors live gate"]
fn installed_connectors_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js224-connectors-{}", std::process::id())])
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
        "<!doctype html><title>Connectors HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-connectors-signing-secret-224","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-connectors-password-224-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("connectors-owner@example.test", "Connectors owner");
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
                "SELECT id FROM app.users WHERE email='connectors-owner@example.test'",
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
    let access = AccessContext::new(owner, "connectors-install");
    // Publish the Connectors package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS224_CONNECTORS_PACKAGE", "connectors")]
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
            publisher_key: "connectors-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Connectors live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "connectors-test-registry".into(),
        name: "Connectors test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "connectors-test".into(),
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
            "connectors-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key}),
    );
    let _server = start(true);
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/connectors{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{path} -> {status}");
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    // Every response body is kept so the marker search below covers all of them.
    let mut seen: Vec<String> = vec![];
    assert_eq!(call(Method::GET, "/accounts", None, None).0, 401);
    let started = Instant::now();
    let (status, text) = loop {
        let answer = call(Method::GET, "/providers", Some(&cookie), None);
        if answer.0 != 503 || started.elapsed() > Duration::from_secs(60) {
            break answer;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!(status, 200, "{text}\n{}", log());
    seen.push(text.clone());
    assert!(json_of(&text)["providers"].as_array().is_some_and(|p| !p.is_empty()), "{text}");
    let (status, text) = call(
        Method::POST,
        "/accounts",
        Some(&cookie),
        Some(json!({"providerId":"google","scopes":["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"],"tokenPayload":{"password":MARKER,"accessToken":MARKER_TOKEN,"refreshToken":MARKER_REFRESH}})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    seen.push(text.clone());
    let created = json_of(&text);
    let id = created["account"]["id"].as_str().or(created["id"].as_str()).unwrap_or_else(|| panic!("no id in {text}")).to_owned();
    let (status, text) = call(Method::GET, "/accounts", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert!(text.contains(&id), "{text}");
    let (status, text) = call(Method::GET, &format!("/accounts/{id}/feature-grants"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"email":true,"calendar":true})));
    seen.push(text);
    let (status, text) = call(Method::PUT, &format!("/accounts/{id}/feature-grants"), Some(&cookie), Some(json!({"calendar":false})));
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert_eq!(json_of(&text)["calendar"], false, "{text}");
    let (status, text) = call(Method::PATCH, &format!("/accounts/{id}"), Some(&cookie), Some(json!({"scopes":["https://www.googleapis.com/auth/gmail.modify"]})));
    assert_eq!(status, 200, "{text}");
    seen.push(text);
    let (status, text) = call(Method::GET, "/admin/accounts", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text);
    let missing = uuid::Uuid::new_v4();
    assert_eq!(call(Method::PATCH, &format!("/accounts/{missing}"), Some(&cookie), Some(json!({"scopes":[]}))).0, 404);
    assert_eq!(call(Method::POST, &format!("/accounts/{missing}/revoke"), Some(&cookie), None).0, 404);
    let (status, text) = call(Method::POST, &format!("/accounts/{id}/revoke"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    seen.push(text.clone());
    assert_eq!(json_of(&text)["account"]["status"].as_str().or(json_of(&text)["status"].as_str()), Some("revoked"), "{text}");
    // The marker must be in no response, no log line, and no stored job; the stored secret is sealed.
    let markers = [MARKER, MARKER_TOKEN, MARKER_REFRESH];
    for body in &seen {
        for marker in markers {
            assert!(!body.contains(marker), "marker in a response: {body}");
        }
    }
    for marker in markers {
        assert!(!log().contains(marker), "marker in the server log");
    }
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let tables = db
            .query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') AND (table_name ILIKE '%job%' OR table_name ILIKE '%audit%' OR table_name='connector_accounts')", &[])
            .await
            .unwrap();
        assert!(tables.len() >= 3, "expected job, audit and account tables");
        for row in tables {
            let (schema, name): (String, String) = (row.get(0), row.get(1));
            for marker in markers {
                let hits: i64 = db
                    .query_one(&format!("SELECT count(*) FROM \"{schema}\".\"{name}\" t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'"), &[&marker])
                    .await
                    .unwrap()
                    .get(0);
                assert_eq!(hits, 0, "marker found in {schema}.{name}");
            }
        }
        // Control: the same search does find a value that really is stored, so a zero above means absent.
        let control: i64 = db
            .query_one("SELECT count(*) FROM app.connector_accounts t WHERE to_jsonb(t)::text LIKE '%' || $1 || '%'", &[&"gmail.modify"])
            .await
            .unwrap()
            .get(0);
        assert_eq!(control, 1, "the search must find a stored value");
        let sealed: i64 = db
            .query_one("SELECT count(*) FROM app.connector_accounts WHERE owner_user_id=$1 AND encrypted_secret ? 'ciphertext'", &[&owner])
            .await
            .unwrap()
            .get(0);
        assert_eq!(sealed, 1, "the stored secret should be one sealed envelope");
    });
    println!("PASS Connectors routes on the real server: sign-in required, providers, create, list, grants, edit, admin list, unknown account 404, revoke; marker secret absent from every response, the server log, and every job, audit and account row");
    let screen_url = format!("{origin}/api/modules/connectors/screen?path=/settings/connections");
    assert_eq!(client.get(&screen_url).send().unwrap().status(), 401);
    let screen: Value = client.get(&screen_url).header("cookie", &cookie).send().unwrap().json().unwrap();
    let src = screen["src"].as_str().expect("screen address");
    assert!(src.starts_with("/module-ui/connectors/"), "{screen}");
    assert_eq!(client.get(format!("{origin}{src}")).header("origin", "null").header("sec-fetch-site", "cross-site").send().unwrap().status(), 200);
    println!("PASS Connections screen address and files served over HTTPS");
    {
        let script = std::env::var("MOSS_CONNECTORS_BROWSER_SCRIPT").expect("the gate must supply the browser script");
        let out = std::env::var("MOSS_CONNECTORS_BROWSER_OUT").unwrap_or_else(|_| root.display().to_string());
        let status = Command::new("pnpm")
            .args(["exec", "tsx", &script])
            .env("ORIGIN", &origin)
            .env("EMAIL", "connectors-owner@example.test")
            .env("PASSWORD", "temporary-connectors-password-224-not-a-real-secret")
            .env("OUT", out)
            .status()
            .unwrap();
        assert!(status.success(), "browser check failed\n{}", log());
    }
    if let Ok(seconds) = std::env::var("MOSS_CONNECTORS_HOLD_SECONDS") {
        println!("HOLD {origin} for {seconds}s");
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }
    println!("NOT PROVEN: a second person over HTTP (setup allows one owner; proven in the database test), a second physical device");
}
const MARKER: &str = "SENTINEL-PASSWORD-7f3a";
const MARKER_TOKEN: &str = "SENTINEL-ACCESS-TOKEN-91bc";
const MARKER_REFRESH: &str = "SENTINEL-REFRESH-TOKEN-02de";
