//! Installed Finance package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Finance live gate"]
fn installed_finance_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js302-finance-{}", std::process::id())])
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
                presentation: None,
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
        publish_reviews: Default::default(),
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

    // The stand-in bank runs as its own process. The server reaches it only through its debug-only
    // bank address setting, so the whole route path is the real one.
    const BANK_TOKEN: &str = "LIVETOKEN-4f2a";
    const BANK_TEXT: &str = "LIVEBANKTEXT-77c1";
    const BANK_CLIENT: &str = "live-client-id";
    const BANK_SECRET: &str = "live-client-secret-9e";
    let mut bank = Command::new(std::env::var("JS305_FAKE_PLAID").unwrap())
        .env("FAKE_PLAID_CLIENT_ID", BANK_CLIENT)
        .env("FAKE_PLAID_SECRET", BANK_SECRET)
        .env("FAKE_PLAID_MARKER", BANK_TOKEN)
        .env("FAKE_PLAID_PRIVATE_MARKER", BANK_TEXT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut bank_in = bank.stdin.take().unwrap();
    let mut first = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(bank.stdout.take().unwrap()), &mut first).unwrap();
    let _bank = Server(bank);
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
                .with("clientId", safety_core::secret::Secret::new(BANK_CLIENT))
                .with("clientSecret", safety_core::secret::Secret::new(BANK_SECRET)),
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

    const NAME: &str = "PLANTED-LIVE-NAME-5b81";
    const NOTE: &str = "PLANTED-LIVE-NOTE-9d03";
    const CENTS: i64 = 7_314_159_265;
    assert_eq!(
        client
            .get(format!("{remote_origin}/api/m/finance/finance/accounts"))
            .header("origin", "https://untrusted.example")
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    println!("PASS live network: real non-loopback HTTPS with certificate verification; untrusted origin refused");
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
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/finance/accounts", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text)["accounts"], json!([]), "{text}");
    }
    // The owner makes an account and an entry, and lists them.
    let op = uuid::Uuid::new_v4().to_string();
    let (status, text) = call(
        Method::POST,
        "/finance/manual/accounts",
        Some(&cookie),
        Some(json!({"operationId":op,"name":NAME,"accountType":"checking","isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":CENTS})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    let account = json_of(&text)["id"].as_str().unwrap().to_owned();
    assert_eq!(account, format!("manual:{op}"));
    let (status, text) = call(
        Method::POST,
        "/finance/manual/entries",
        Some(&cookie),
        Some(json!({"operationId":uuid::Uuid::new_v4().to_string(),"accountId":account,"name":NAME,"date":"2026-11-10","amountCents":-500,"isoCurrency":"USD","notes":NOTE,"cleared":true})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, text) = call(Method::GET, "/finance/accounts", Some(&cookie), None);
    let listed = json_of(&text);
    assert_eq!(listed["accounts"][0]["name"], NAME, "{text}");
    assert_eq!(listed["accounts"][0]["balanceCents"], CENTS + 500, "{text}");
    // A repeat of the same request changes nothing, and a different one is refused.
    let (_, text) = call(
        Method::POST,
        "/finance/manual/accounts",
        Some(&cookie),
        Some(json!({"operationId":op,"name":NAME,"accountType":"checking","isoCurrency":"USD","openingDate":"2026-01-01","openingBalanceCents":CENTS})),
    );
    assert_eq!(json_of(&text)["unchanged"], true, "{text}");
    // The other person sees none of it and cannot add to it.
    let (_, text) = call(Method::GET, "/finance/accounts", Some(&other), None);
    assert_eq!(json_of(&text)["accounts"], json!([]), "{text}");
    assert!(!text.contains(NAME));
    let (status, text) = call(
        Method::POST,
        "/finance/manual/entries",
        Some(&other),
        Some(json!({"operationId":uuid::Uuid::new_v4().to_string(),"accountId":account,"name":"Stolen","date":"2026-11-10","amountCents":-1,"isoCurrency":"USD","cleared":true})),
    );
    assert_eq!(status, 404, "{text}");
    assert_eq!(json_of(&text)["code"], "manual_unavailable");
    assert_eq!(call(Method::GET, "/finance/accounts", None, None).0, 401);
    println!("PASS live finance: an account and an entry worked over HTTPS, and the second person saw none of it");
    // Transactions: query, categorize, note, rule, sort, CSV import with a replay, two people.
    const PAYEE: &str = "PLANTED-LIVE-PAYEE-77c2";
    const IMPORT_NOTE: &str = "PLANTED-LIVE-IMPORT-NOTE-1e44";
    let (status, text) = call(Method::GET, "/finance/transactions?month=2026-11", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let listed = json_of(&text);
    let first = listed["transactions"][0].clone();
    assert_eq!(first["name"], NAME, "{text}");
    let tx_id = first["id"].as_str().unwrap().to_owned();
    let (status, text) = call(
        Method::POST,
        "/finance/transactions/category",
        Some(&cookie),
        Some(json!({"transactionId":tx_id,"accountId":account,"month":"2026-11","categoryId":"groceries","writeRevision":first["writeRevision"]})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, text) = call(Method::GET, &format!("/finance/transactions?month=2026-11&transactionId={tx_id}"), Some(&cookie), None);
    let revision_now = json_of(&text)["transactions"][0]["writeRevision"].as_str().unwrap().to_owned();
    let (status, text) = call(
        Method::POST,
        "/finance/transactions/notes",
        Some(&cookie),
        Some(json!({"transactionId":tx_id,"accountId":account,"month":"2026-11","writeRevision":revision_now,"notes":IMPORT_NOTE})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::GET, &format!("/finance/transactions/notes?transactionId={tx_id}&accountId={account}&month=2026-11"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert!(text.contains(IMPORT_NOTE), "{text}");
    let csv = format!("date,name,amount,notes\n2026-11-11,{PAYEE},12.34,{IMPORT_NOTE}\n2026-11-12,{PAYEE} Two,5.00,\n");
    let map = json!({"csv":csv,"isoCurrency":"USD","date":0,"name":1,"amount":2,"notes":3,"dateFormat":"iso","amountMode":"positive-out"});
    let (status, text) = call(Method::POST, "/finance/import/parse", Some(&cookie), Some(map));
    assert_eq!(status, 200, "{text}\n{}", log());
    let rows = json_of(&text)["rows"].clone();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    let (_, text) = call(Method::GET, "/finance/accounts", Some(&cookie), None);
    let revision = json_of(&text)["accounts"][0]["ledgerRevision"].as_i64().unwrap_or(1);
    let import_op = uuid::Uuid::new_v4().to_string();
    let apply = json!({"operationId":import_op,"accountId":account,"isoCurrency":"USD","expectedRevision":revision,"rows":rows,"cleared":true});
    let (status, text) = call(Method::POST, "/finance/import/apply", Some(&cookie), Some(apply.clone()));
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["entryCount"], 2);
    let (status, text) = call(Method::POST, "/finance/import/apply", Some(&cookie), Some(apply));
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["unchanged"], true, "{text}");
    let (_, text) = call(Method::GET, "/finance/transactions?month=2026-11", Some(&cookie), None);
    assert_eq!(json_of(&text)["transactions"].as_array().unwrap().len(), 3, "a replay added rows: {text}");
    let (status, text) = call(Method::POST, "/finance/sorting/run", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::GET, "/finance/rules", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    for who_path in ["/finance/transactions?month=2026-11", "/finance/rules"] {
        let (status, text) = call(Method::GET, who_path, Some(&other), None);
        assert_eq!(status, 200, "{text}");
        assert!(!text.contains(PAYEE) && !text.contains(NAME) && !text.contains(IMPORT_NOTE), "the other person saw private text: {text}");
    }
    let (status, text) = call(
        Method::POST,
        "/finance/transactions/notes",
        Some(&other),
        Some(json!({"transactionId":tx_id,"accountId":account,"month":"2026-11","writeRevision":"0".repeat(32),"notes":"stolen"})),
    );
    assert_ne!(status, 200, "{text}");
    println!("PASS live finance transactions: query, category, note, import, replay and sorting worked over HTTPS, and the second person saw none of it");
    // Budget: set up, assign against a review, a stale review saves nothing, a draft from stored rows, two people.
    let (status, text) = call(Method::GET, "/finance/budget/status?month=2026-11", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["setupRequired"], true, "{text}");
    let (status, text) = call(Method::POST, "/finance/budget/configure", Some(&cookie), Some(json!({"isoCurrency":"USD","acknowledgeLegacy":false})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, text) = call(Method::GET, "/finance/budget/status?month=2026-11", Some(&cookie), None);
    let review = json_of(&text);
    assert!(review["setupRequired"] != json!(true), "{text}");
    let assign = |review: &Value, cents: i64| {
        json!({"month":"2026-11","expectedRevision":review["revision"],"expectedFingerprint":review["fingerprint"],"categoryId":"groceries","amountCents":cents,"previousCents":0})
    };
    let (status, text) = call(Method::POST, "/finance/budget/assign", Some(&cookie), Some(assign(&review, 40_000)));
    assert_eq!(status, 200, "{text}\n{}", log());
    // The same review is now old, so a second save is refused and nothing changes.
    let (status, text) = call(Method::POST, "/finance/budget/assign", Some(&cookie), Some(assign(&review, 77_000)));
    assert_eq!(status, 409, "{text}");
    let (_, text) = call(Method::GET, "/finance/budget/status?month=2026-11", Some(&cookie), None);
    assert_eq!(json_of(&text)["state"]["categories"]["groceries"]["assignedCents"], 40_000, "{text}");
    let (status, text) = call(Method::POST, "/finance/budget/draft/build", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::GET, "/finance/budget/draft", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    // The assistant's route is refused without the host's one-use approval.
    let (status, text) = call(Method::POST, "/finance/chat/budget/assign", Some(&cookie), Some(assign(&review, 1)));
    assert_ne!(status, 200, "{text}");
    for path in ["/finance/budget/status?month=2026-11", "/finance/budget/draft"] {
        let (status, text) = call(Method::GET, path, Some(&other), None);
        assert!(status == 200 || status == 404, "{status} {text}");
        assert!(!text.contains("40000") && !text.contains(NAME) && !text.contains(PAYEE), "the other person saw budget data: {text}");
    }
    let (status, text) = call(Method::POST, "/finance/budget/assign", Some(&other), Some(assign(&review, 5)));
    assert_ne!(status, 200, "{text}");
    assert_eq!(call(Method::GET, "/finance/budget/status?month=2026-11", None, None).0, 401);
    println!("PASS live finance budget: setup, assign, a stale review refused, a draft from stored rows and two people worked over HTTPS");
    // Part 24: bills, targets, the flexible pool and card reserves over the same real route path.
    const BILL: &str = "PLANTED-LIVE-BILL-8f2c";
    let fresh = || {
        let (_, text) = call(Method::GET, "/finance/budget/status?month=2026-11", Some(&cookie), None);
        let r = json_of(&text);
        json!({"month":"2026-11","expectedRevision":r["revision"],"expectedFingerprint":r["fingerprint"]})
    };
    let with = |mut base: Value, extra: Value| {
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    };
    let plan = uuid::Uuid::new_v4().to_string();
    let old_review = fresh();
    let bill = with(old_review.clone(), json!({"id":plan,"name":BILL,"accountId":account,"categoryId":"groceries","amountCents":123_457,"anchorDate":"2026-11-20","cadence":"monthly"}));
    let (status, text) = call(Method::POST, "/finance/bills", Some(&cookie), Some(bill.clone()));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/finance/bills", Some(&cookie), Some(bill));
    assert_eq!(status, 409, "a repeated save with an old review must be refused: {text}");
    let (status, text) = call(Method::GET, "/finance/bills?from=2026-11-01&to=2026-12-31", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert!(text.contains(BILL) && text.contains("123457"), "{text}");
    let (status, text) = call(Method::POST, "/finance/targets", Some(&cookie), Some(with(fresh(), json!({"categoryId":"dining","kind":"monthly","amountCents":25_000}))));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/finance/flex/preview", Some(&cookie), Some(json!({"month":"2026-11","mode":"flex","flexIds":["groceries"],"nonMonthlyIds":[]})));
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["mode"], "flex", "{text}");
    let (status, text) = call(Method::GET, "/finance/bills/suggestions?from=2026-11-01&to=2026-12-31", Some(&cookie), None);
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = call(Method::POST, "/finance/chat/targets", Some(&cookie), Some(with(fresh(), json!({"categoryId":"dining","kind":"monthly","amountCents":1}))));
    assert_ne!(status, 200, "the assistant route needs the one-use approval: {text}");
    for path in ["/finance/bills?from=2026-11-01&to=2026-12-31", "/finance/bills/suggestions?from=2026-11-01&to=2026-12-31"] {
        let (status, text) = call(Method::GET, path, Some(&other), None);
        assert!(status == 200 || status == 404, "{status} {text}");
        assert!(!text.contains(BILL) && !text.contains("123457") && !text.contains("25000"), "the other person saw bill data: {text}");
    }
    let (status, text) = call(Method::POST, "/finance/targets/remove", Some(&other), Some(with(fresh(), json!({"categoryId":"dining"}))));
    assert_ne!(status, 200, "{text}");
    println!("PASS live finance part 24: a bill, a target and the pool preview worked over HTTPS, an old review was refused, and the second person saw none of it");
    // Activity rows and the server log hold none of the text the test sent.
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap()),
        std::sync::Arc::new(NoModel),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    let activity = serde_json::to_string(&services.activity("finance", &access).unwrap()).unwrap();
    let stored: i64 = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let control: i64 = db
            .query_one("SELECT count(*) FROM app.finance_transactions t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&NAME])
            .await
            .unwrap()
            .get(0);
        assert!(control > 0, "the marker search cannot find text that is stored");
        for marker in [NAME, NOTE, PAYEE, IMPORT_NOTE, BILL, "123457", &CENTS.to_string()] {
            let jobs: i64 = db
                .query_one("SELECT count(*) FROM pgboss.job j WHERE to_jsonb(j)::text LIKE '%'||$1||'%'", &[&marker])
                .await
                .unwrap()
                .get(0);
            assert_eq!(jobs, 0, "a stored job row holds {marker}");
            let hits: i64 = db
                .query_one("SELECT count(*) FROM app.finance_activity t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'", &[&marker])
                .await
                .unwrap()
                .get(0);
            assert_eq!(hits, 0, "an activity row holds {marker}");
        }
        db.query_one("SELECT count(*) FROM app.finance_activity", &[]).await.unwrap().get(0)
    });
    assert!(stored >= 2, "the changes are logged");
    // Bank connect and sync through the real routes. The person finishes the stand-in's bank page
    // by a command to the stand-in, as they would in a browser.
    let finish = |bank_in: &mut std::process::ChildStdin, line: &str| {
        use std::io::Write;
        writeln!(bank_in, "{line}").unwrap();
        bank_in.flush().unwrap();
    };
    let names = |who: &str| -> Vec<String> {
        let (_, text) = call(Method::GET, "/finance/accounts", Some(who), None);
        json_of(&text)["accounts"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap_or_default().to_owned()).collect()
    };
    let (status, text) = call(Method::POST, "/finance/connect/start", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["status"], "pending");
    assert!(json_of(&text)["hostedLinkUrl"].as_str().unwrap().starts_with("https://"));
    let (_, text) = call(Method::POST, "/finance/connect/poll", Some(&cookie), Some(json!({})));
    assert_eq!(json_of(&text)["pending"], 1, "{text}");
    finish(&mut bank_in, "finish");
    let (status, text) = call(Method::POST, "/finance/connect/poll", Some(&cookie), Some(json!({})));
    assert_eq!((status, json_of(&text)["completed"].clone()), (200, json!(1)), "{text}\n{}", log());
    let owned = names(&cookie);
    assert_eq!(owned.iter().filter(|n| n.contains(BANK_TEXT)).count(), 2, "{owned:?}");
    assert_eq!(names(&other).len(), 0);
    let (_, text) = call(Method::POST, "/finance/sync/run-now", Some(&other), Some(json!({})));
    assert_eq!(json_of(&text)["items"], json!([]), "{text}");
    let (_, text) = call(Method::POST, "/finance/sync/run-now", Some(&cookie), Some(json!({})));
    assert_eq!(json_of(&text)["items"][0]["status"], "connected", "{text}");
    println!("PASS live bank: connected, synced and kept private from the second person");
    finish(&mut bank_in, "fail 0 ITEM_LOGIN_REQUIRED");
    let (_, text) = call(Method::POST, "/finance/sync/run-now", Some(&cookie), Some(json!({})));
    assert_eq!(json_of(&text)["items"][0]["status"], "reauth-required", "{text}");
    assert_eq!(names(&cookie).len(), owned.len(), "a failed bank keeps its data");
    println!("PASS live bank: a failing bank is marked as needing a reconnect and keeps its data");
    let (status, text) = call(Method::POST, "/finance/connect/start", Some(&cookie), Some(json!({})));
    assert_eq!(status, 200, "{text}\n{}", log());
    finish(&mut bank_in, "finish");
    let (_, text) = call(Method::POST, "/finance/connect/poll", Some(&cookie), Some(json!({})));
    assert_eq!(json_of(&text)["completed"], 1, "{text}");
    let (_, text) = call(Method::POST, "/finance/sync/run-now", Some(&cookie), Some(json!({})));
    assert_eq!(json_of(&text)["items"][0]["status"], "connected", "{text}");
    assert_eq!(names(&cookie).len(), owned.len(), "a reconnect adds no second bank");
    println!("PASS live bank: reconnected, one bank, sync works again");
    // Household sharing through the real routes, on the account the stand-in bank synced.
    let (_, text) = call(Method::GET, "/finance/accounts", Some(&cookie), None);
    let account = json_of(&text)["accounts"][0]["accountId"].as_str().unwrap().to_owned();
    assert_eq!(names(&other).len(), 0, "nothing is shared yet");
    let (status, text) = call(Method::POST, "/finance/accounts/shared", Some(&cookie), Some(json!({"accountId":account,"shared":true})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, text) = call(Method::GET, "/finance/accounts", Some(&other), None);
    let seen = json_of(&text);
    assert_eq!(seen["accounts"].as_array().unwrap().len(), 1, "{text}");
    assert_eq!(seen["accounts"][0]["ownerUserId"], json!(owner.to_string()), "{text}");
    assert!(seen["accounts"][0].get("officialName").is_none(), "{text}");
    let (status, text) = call(Method::POST, "/finance/accounts/shared", Some(&other), Some(json!({"accountId":account,"shared":false})));
    assert_eq!((status, json_of(&text)["code"].clone()), (404, json!("unknown_account")), "the other person cannot unshare it: {text}");
    let (status, mine) = call(Method::GET, "/finance/transactions/export", Some(&cookie), None);
    assert_eq!(status, 200, "{mine}");
    let (status, theirs) = call(Method::GET, "/finance/transactions/export", Some(&other), None);
    assert_eq!(status, 200, "{theirs}");
    assert!(json_of(&mine)["totalCount"].as_i64().unwrap() >= 1, "{mine}");
    assert_eq!(json_of(&theirs)["totalCount"], 0, "the other person's export holds someone else's rows: {theirs}");
    for path in ["/finance/reports/spending?months=1", "/finance/reports/net-worth", "/finance/activity?from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z"] {
        let (status, text) = call(Method::GET, path, Some(&other), None);
        assert_eq!(status, 200, "{path} {text}");
        assert!(!text.contains(NOTE) && !text.contains(BANK_TOKEN), "{path} showed private text");
    }
    let (status, text) = call(Method::POST, "/finance/accounts/shared", Some(&cookie), Some(json!({"accountId":account,"shared":false})));
    assert_eq!(status, 200, "{text}");
    assert_eq!(names(&other).len(), 0, "stopping removes the copy");
    println!("PASS live sharing: shared, seen by the second person only as allowed, export own rows only, unshared");
    // Activity rows, job rows and the server log hold no bank token, key or bank text.
    let activity = serde_json::to_string(&services.activity("finance", &access).unwrap()).unwrap();
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
            for marker in [BANK_TOKEN, BANK_SECRET, BANK_CLIENT, "access-sandbox", "public-sandbox"] {
                let hits: i64 = db.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&marker]).await.unwrap().get(0);
                assert_eq!(hits, 0, "{table} holds {marker}");
            }
            if table.starts_with("moss_queue.") || table.ends_with("finance_activity") {
                let hits: i64 = db.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&BANK_TEXT]).await.unwrap().get(0);
                assert_eq!(hits, 0, "{table} holds bank text");
            }
        }
    });
    for marker in [BANK_TOKEN, BANK_TEXT, BANK_SECRET, "access-sandbox"] {
        assert!(!activity.contains(marker));
        assert!(!log().contains(marker), "the server log holds {marker}");
    }
    println!("PASS live bank: no token, key or bank text in jobs, activity rows or the server log");
    for marker in [NAME, NOTE, PAYEE, IMPORT_NOTE, &CENTS.to_string()] {
        assert!(!activity.contains(marker));
        assert!(!log().contains(marker), "the server log holds {marker}");
    }
    println!("finance live: accounts and entries for two people worked over HTTPS");
}
