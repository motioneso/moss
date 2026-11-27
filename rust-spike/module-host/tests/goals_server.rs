//! Installed Goals package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Goals live gate"]
fn installed_goals_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js290-goals-{}", std::process::id())])
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
        "<!doctype html><title>Goals HTTP fixture</title>",
    )
    .unwrap();
    if let Ok(web) = std::env::var("GOALS_WEB_DIR") {
        assert!(Command::new("cp").args(["-r", &format!("{web}/.")])
            .arg(root.join("web")).status().unwrap().success());
    }
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
        &json!({"listen":format!("0.0.0.0:{}",port.0),"sharing":false,"origins":[origin,remote_origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-goals-password-287-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("goals-owner@example.test", "Goals owner");
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
                "SELECT id FROM app.users WHERE email='goals-owner@example.test'",
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
    let access = AccessContext::new(owner, "goals-install");
    // Publish the Goals package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS287_GOALS_PACKAGE", "goals")]
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
                publisher_key: "goals-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Goals live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "goals-test-registry".into(),
        name: "Goals test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "goals-test".into(),
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
            "goals-test-registry",
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
    // A saved sharing flag no longer opens the network on its own. The owner turns
    // sharing on through the real route, which opens the firewall rule first.
    let turned_on = client
        .put(format!("{origin}/api/network"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .json(&json!({"sharing":true}))
        .send()
        .unwrap();
    let turned_on_status = turned_on.status().as_u16();
    let turned_on_body: Value = turned_on.json().unwrap_or(Value::Null);
    assert_eq!(
        (turned_on_status, turned_on_body["sharing"].as_bool()),
        (200, Some(true)),
        "owner turns sharing on: {turned_on_body}"
    );
    assert!(
        matches!(
            turned_on_body["firewall"].as_str(),
            Some("allowed" | "disabled")
        ),
        "live firewall rule after turning sharing on: {turned_on_body}"
    );
    // Setup allows one owner over HTTP, so the second person is made in the database with the
    // owner's password hash and then signs in through the real route.
    let other = {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let id = uuid::Uuid::new_v4();
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Goals other', 'goals-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{remote_origin}/api/auth/sign-in/email")).header("origin", &remote_origin)
            .json(&json!({"email":"goals-other@example.test","password":"temporary-goals-password-287-not-a-real-secret"})).send().unwrap();
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
            .request(method, format!("{remote_origin}/api/m/goals{path}"))
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
    const MARK: &str = "PLANTED-LIVE-MARKER-7d2e";
    assert_eq!(
        client
            .post(format!("{remote_origin}/api/m/goals/goals/tools/run"))
            .header("origin", "https://untrusted.example")
            .header("cookie", &cookie)
            .json(&json!({"tool":"goals.list","parameters":{}}))
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    println!("PASS live network: real non-loopback HTTPS with certificate verification; untrusted origin refused");
    assert_eq!(call(Method::GET, "/goals", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/goals/goals"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .is_ok_and(|r| r.status().as_u16() != 503);
        if ready {
            break;
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(240),
            "module host start deadline\n{}",
            log()
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/goals", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text), json!([]));
    }
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(
            safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap(),
        ),
        std::sync::Arc::new(NoModel),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    let policies = BTreeMap::from([("goals.list".into(), false), ("goals.get".into(), false)]);
    services
        .set_action_policy(&access, "goals", &policies)
        .unwrap();
    let tool = |name: &str, parameters: Value, approve: bool| {
        if approve {
            services
                .approve_tool(&access, "goals", name, &parameters)
                .unwrap();
        }
        call(
            Method::POST,
            "/goals/tools/run",
            Some(&cookie),
            Some(json!({"tool":name,"parameters":parameters})),
        )
    };
    assert_eq!(call(Method::GET, "/goals/today", None, None).0, 401);
    let create = json!({"title":MARK,"desiredOutcome":"Tool created"});
    assert_eq!(tool("goals.create", create.clone(), false).0, 403);
    let (status, text) = tool("goals.create", create.clone(), true);
    assert_eq!(status, 200, "{text}");
    let tool_goal = json_of(&text)["data"].clone();
    let tool_id = tool_goal["id"].as_str().unwrap();
    assert_eq!(tool("goals.create", create, false).0, 403);
    let (_, route_goal) = call(
        Method::GET,
        &format!("/goals/{tool_id}"),
        Some(&cookie),
        None,
    );
    assert_eq!(json_of(&route_goal), tool_goal);
    let (_, list) = tool("goals.list", json!({}), false);
    assert_eq!(json_of(&list)["data"]["items"].as_array().unwrap().len(), 1);
    let evidence = json!({"goalId":tool_id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":MARK});
    assert_eq!(tool("goals.addEvidence", evidence, true).0, 200);
    let (status, text) = tool("goals.get", json!({"goalId":tool_id}), false);
    assert_eq!(status, 200);
    assert_eq!(json_of(&text)["data"]["evidence"][0]["summary"], MARK);
    let (_, today) = call(Method::GET, "/goals/today", Some(&cookie), None);
    assert_eq!(json_of(&today).as_array().unwrap().len(), 1);
    assert_eq!(
        call(Method::GET, "/goals/today", Some(&other), None).1,
        "[]"
    );
    let update = json!({"goalId":tool_id,"status":"completed"});
    assert_eq!(tool("goals.update", update, true).0, 200);
    let (_, today) = call(Method::GET, "/goals/today", Some(&cookie), None);
    assert_eq!(json_of(&today), json!([]));
    let evidence = json!({"goalId":tool_id,"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Late"});
    let (_, refused) = tool("goals.addEvidence", evidence, true);
    assert_eq!(json_of(&refused)["data"]["error"], "Goal is closed");
    let activity = serde_json::to_string(&services.activity("goals", &access).unwrap()).unwrap();
    assert!(!activity.contains(MARK));
    println!("PASS part5 live HTTPS: all five tools, exact-input one-use approval, shared route writes, Today active filter, second account and metadata-only activity");
    // The owner creates a goal and adds evidence.
    let (status, text) = call(
        Method::POST,
        "/goals",
        Some(&cookie),
        Some(json!({"title":MARK,"desiredOutcome":"Ship it"})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let goal = json_of(&text);
    let id = goal["id"].as_str().unwrap().to_owned();
    assert_eq!(goal["status"], "active");
    let (status, text) = call(
        Method::POST,
        &format!("/goals/{id}/evidence"),
        Some(&cookie),
        Some(
            json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":MARK}),
        ),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let (_, list) = call(Method::GET, "/goals", Some(&cookie), None);
    assert_eq!(json_of(&list).as_array().unwrap().len(), 2, "{list}");
    // The other person sees none of it.
    let (_, text) = call(Method::GET, "/goals", Some(&other), None);
    assert_eq!(json_of(&text), json!([]), "{text}");
    assert!(!text.to_lowercase().contains(&MARK.to_lowercase()));
    assert_eq!(
        call(Method::GET, &format!("/goals/{id}"), Some(&other), None).0,
        404
    );
    // The owner closes the goal, and further evidence is refused.
    let (status, text) = call(
        Method::PATCH,
        &format!("/goals/{id}"),
        Some(&cookie),
        Some(json!({"status":"completed"})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["status"], "completed");
    let (status, text) = call(
        Method::POST,
        &format!("/goals/{id}/evidence"),
        Some(&cookie),
        Some(
            json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Late"}),
        ),
    );
    assert_eq!(status, 409, "{text}");
    // Nothing the test sent reached the server log.
    assert!(!log().to_lowercase().contains(&MARK.to_lowercase()));
    println!("goals live: create, evidence, close and refusal for two people worked over HTTPS");
    if let Ok(hold) = std::env::var("GOALS_HOLD_OPEN") {
        // Browser proof signs in independently. This receipt contains no session credentials.
        fs::write(&hold, json!({"origin":remote_origin}).to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1800);
        while !Path::new(&format!("{hold}.stop")).exists() {
            assert!(Instant::now() < deadline, "browser proof hold deadline");
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
