//! Real bank pass for Finance (JS-325). Real server, real routes, real Plaid sandbox through a loopback relay.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
use access_context::AccessContext;
use common::Keys;
use moss_module_host::{
    archive::Package,
    registry::{Artifact, Channel, Index, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
// The live fixture grants approval through the real trusted host API, never through HTTP
// parameters. It shares the server's private service store and disk locks.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("No model")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("No model")
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

#[test]
#[ignore = "Only through verify-gate and the Finance Plaid live gate"]
fn finance_links_and_syncs_a_real_plaid_sandbox_bank() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js325-finance-{}", std::process::id())])
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
    let address: std::net::IpAddr = std::env::var("JS290_PROOF_ADDRESS")
        .unwrap()
        .parse()
        .unwrap();
    assert!(!address.is_loopback() && address.is_ipv4());
    let remote_origin = format!("https://{address}:{}", port.0);
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .arg(&remote_origin)
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
        "<!doctype html><title>Finance HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-news-signing-secret-276","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("0.0.0.0:{}",port.0),"sharing":true,"origins":[origin,remote_origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-finance-password-287-not-a-real-secret"})).send().unwrap();
        let status = response.status();
        if status != 200 {
            panic!(
                "sign-up answered {status}: {}",
                response.text().unwrap_or_default()
            );
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
    let cookie = signup("finance-owner@example.test", "Finance owner");
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
                "SELECT id FROM app.users WHERE email='finance-owner@example.test'",
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
    let access = AccessContext::new(owner, "finance-install");
    // Publish the Finance package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS302_FINANCE_PACKAGE", "finance")]
        .iter()
        .map(|(variable, id)| {
            let bytes = fs::read(std::env::var(variable).unwrap()).unwrap();
            let digest = trust::digest(&bytes);
            let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
            let manifest = &package.manifest;
            assert_eq!(manifest.id, *id);
            fs::write(
                root.join(format!("registry/packages/{digest}.mosspkg")),
                &bytes,
            )
            .unwrap();
            Artifact {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: "finance-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Finance live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "finance-test-registry".into(),
        name: "Finance test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "finance-test".into(),
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
        (
            "registry.json",
            serde_json::to_vec(&identity).unwrap(),
            &keys.root,
        ),
        (
            "index.json",
            serde_json::to_vec(&index).unwrap(),
            &keys.index,
        ),
    ] {
        fs::write(root.join("registry").join(name), &data).unwrap();
        fs::write(
            root.join("registry").join(format!("{name}.sig")),
            Keys::sign(key, &data),
        )
        .unwrap();
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
            "finance-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    // Real sandbox keys. The values stay in memory and are only used as leak-scan markers.
    let keys = fs::read_to_string(std::env::var("JS325_PLAID_KEYS").unwrap()).unwrap();
    let mut key_lines = keys.lines();
    let bank_client = key_lines.next().unwrap().trim().to_owned();
    let bank_secret = key_lines.next().unwrap().trim().to_owned();
    assert!(!bank_client.is_empty() && !bank_secret.is_empty());
    let mut relay = Command::new("python3")
        .arg(std::env::var("JS325_RELAY").unwrap())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(relay.stdout.take().unwrap()), &mut first).unwrap();
    let _relay = Server(relay);
    let bank_url = first.trim().strip_prefix("endpoint ").unwrap().to_owned();
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(
            safety_core::secret::SecretCipher::connectors(&[("JARVIS_CONNECTOR_SECRET_KEY".into(), connector_key.clone())].into()).unwrap(),
        ),
        std::sync::Arc::new(NoModel),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    services
        .set_credential(
            &AccessContext::new(uuid::Uuid::nil(), "configure"),
            "finance",
            "plaid-keys",
            &safety_core::secret::SecretFields::new()
                .with("clientId", safety_core::secret::Secret::new(&bank_client))
                .with("clientSecret", safety_core::secret::Secret::new(&bank_secret)),
        )
        .unwrap();
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key,"test_only_plaid_url":bank_url}),
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Finance other', 'finance-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{remote_origin}/api/auth/sign-in/email")).header("origin", &remote_origin)
            .json(&json!({"email":"finance-other@example.test","password":"temporary-finance-password-287-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{remote_origin}/api/m/finance{path}"))
            .header("origin", &remote_origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{method_path} -> {status}", method_path = path);
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    assert_eq!(call(Method::GET, "/finance/accounts", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/finance/finance/accounts"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .is_ok_and(|r| r.status().as_u16() != 503);
        if ready {
            break;
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(240), "module host start deadline\n{}", log());
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let marks = [bank_client.as_str(), bank_secret.as_str(), "access-sandbox", "public-sandbox"];
    let clean = |label: &str, text: &str| {
        for m in marks {
            assert!(!text.contains(m), "{label} reply holds a key or bank token");
        }
    };
    let dir = std::path::PathBuf::from(std::env::var("JS325_DIR").unwrap());
    let accounts_of = |who: &str| -> Vec<Value> {
        let (status, text) = call(Method::GET, "/finance/accounts", Some(who), None);
        assert_eq!(status, 200, "{text}");
        clean("accounts", &text);
        json_of(&text)["accounts"].as_array().unwrap().clone()
    };
    let now = chrono::Utc::now();
    let months = [
        now.format("%Y-%m").to_string(),
        (now - chrono::Duration::days(31)).format("%Y-%m").to_string(),
    ];
    let transactions_of = |who: &str| -> usize {
        let mut count = 0;
        for month in &months {
            let (status, text) = call(Method::GET, &format!("/finance/transactions?month={month}"), Some(who), None);
            assert_eq!(status, 200, "{text}");
            clean("transactions", &text);
            count += json_of(&text)["transactions"].as_array().map_or(0, |t| t.len());
        }
        count
    };
    assert_eq!(accounts_of(&cookie).len(), 0);
    let (status, text) = call(Method::POST, "/finance/connect/start", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}\n{}", log());
    clean("connect start", &text.replace(&json_of(&text)["hostedLinkUrl"].as_str().unwrap_or_default().to_owned(), ""));
    let url = json_of(&text)["hostedLinkUrl"].as_str().expect("a hosted bank page address").to_owned();
    assert!(url.starts_with("https://"), "hosted page is not https");
    println!("PASS real Plaid sandbox issued a hosted bank page address");
    fs::write(dir.join("hosted-url.txt"), &url).unwrap();
    println!("WAITING for the bank page to be finished (file {})", dir.join("done").display());
    let wait = Instant::now();
    while !dir.join("done").exists() {
        assert!(wait.elapsed() < Duration::from_secs(1800), "bank page never finished");
        std::thread::sleep(Duration::from_secs(2));
    }
    let mut completed = 0;
    for _ in 0..20 {
        let (status, text) = call(Method::POST, "/finance/connect/poll", Some(&cookie), Some(json!({})));
        clean("connect poll", &text);
        assert_eq!(status, 200, "{text}\n{}", log());
        completed = json_of(&text)["completed"].as_i64().unwrap_or(0);
        if completed == 1 {
            break;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    assert_eq!(completed, 1, "the bank link did not finish\n{}", log());
    println!("PASS real link finished through the poll route");
    let mut owned = accounts_of(&cookie);
    let mut tx = 0;
    for _ in 0..12 {
        let (status, text) = call(Method::POST, "/finance/sync/run-now", Some(&cookie), Some(json!({})));
        clean("sync", &text);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text)["items"][0]["status"], "connected", "{text}");
        owned = accounts_of(&cookie);
        tx = transactions_of(&cookie);
        if tx > 0 {
            break;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
    assert!(!owned.is_empty(), "no accounts after the sync");
    assert!(tx > 0, "no transactions after the sync");
    let names: Vec<&str> = owned.iter().filter_map(|a| a["name"].as_str()).collect();
    println!("PASS real accounts appear for the owner: {} ({names:?}); real transactions: {tx}", owned.len());
    assert_eq!(accounts_of(&other).len(), 0);
    assert_eq!(transactions_of(&other), 0);
    let (_, text) = call(Method::POST, "/finance/sync/run-now", Some(&other), Some(json!({})));
    assert_eq!(json_of(&text)["items"], json!([]), "{text}");
    println!("PASS second person sees no accounts or transactions and has nothing to sync");
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let tables: Vec<String> = db
            .query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema='moss_queue' OR table_name LIKE 'finance\\_%'", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        for table in &tables {
            for marker in marks {
                let hits: i64 = db.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&marker]).await.unwrap().get(0);
                assert_eq!(hits, 0, "{table} holds a key or bank token");
            }
        }
        println!("scanned {} tables for keys and tokens", tables.len());
    });
    let activity = serde_json::to_string(&services.activity("finance", &access).unwrap()).unwrap();
    for m in marks {
        assert!(!activity.contains(m), "activity holds a key or token");
        assert!(!log().contains(m), "the server log holds a key or token");
    }
    println!("PASS no key or bank token in any reply, table, job, activity row or the server log");
}

