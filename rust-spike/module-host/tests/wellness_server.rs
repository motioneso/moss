//! Installed Wellness package served by the real HTTPS executable. Not a native UI proof.
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
#[ignore = "Only through verify-gate and the Wellness live gate"]
fn installed_wellness_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js290-wellness-{}", std::process::id())])
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
        "<!doctype html><title>Wellness HTTP fixture</title>",
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-wellness-password-287-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("wellness-owner@example.test", "Wellness owner");
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
                "SELECT id FROM app.users WHERE email='wellness-owner@example.test'",
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
    let access = AccessContext::new(owner, "wellness-install");
    // Publish the Wellness package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS287_WELLNESS_PACKAGE", "wellness")]
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
                publisher_key: "wellness-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Wellness live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "wellness-test-registry".into(),
        name: "Wellness test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "wellness-test".into(),
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
            "wellness-test-registry",
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Wellness other', 'wellness-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{remote_origin}/api/auth/sign-in/email")).header("origin", &remote_origin)
            .json(&json!({"email":"wellness-other@example.test","password":"temporary-wellness-password-287-not-a-real-secret"})).send().unwrap();
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
            .request(method, format!("{remote_origin}/api/m/wellness{path}"))
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
            .get(format!(
                "{remote_origin}/api/m/wellness/wellness/ai-consent"
            ))
            .header("origin", "https://untrusted.example")
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    println!("PASS live network: real non-loopback HTTPS with certificate verification; untrusted origin refused");
    assert_eq!(call(Method::GET, "/wellness/checkins", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/wellness/wellness/checkins"))
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
        let (status, text) = call(Method::GET, "/wellness/checkins", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text), json!({"checkins":[],"nextCursor":null}));
    }
    // The owner saves two check-ins, reads them back and changes one.
    let (status, text) = call(
        Method::POST,
        "/wellness/checkins",
        Some(&cookie),
        Some(
            json!({"feelingCore":"happy","feelingSecondary":"Joy","note":MARK,"intensity":4,"energy":3}),
        ),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let made = json_of(&text);
    let id = made["checkin"]["id"].as_str().unwrap().to_owned();
    assert_eq!(made["checkin"]["ownerUserId"], owner.to_string());
    assert!(made["checkin"]["localDate"].is_null() || made["checkin"]["localDate"].is_string());
    let (status, _) = call(
        Method::POST,
        "/wellness/checkins",
        Some(&cookie),
        Some(json!({"feelingCore":"sad"})),
    );
    assert_eq!(status, 201);
    let (_, text) = call(
        Method::GET,
        "/wellness/checkins?limit=1",
        Some(&cookie),
        None,
    );
    let page = json_of(&text);
    assert_eq!(page["checkins"].as_array().unwrap().len(), 1, "{text}");
    let cursor = page["nextCursor"].as_str().unwrap().to_owned();
    let (_, text) = call(
        Method::GET,
        &format!("/wellness/checkins?limit=1&cursor={cursor}"),
        Some(&cookie),
        None,
    );
    assert_eq!(json_of(&text)["checkins"][0]["id"], id, "{text}");
    let (status, text) = call(
        Method::PATCH,
        &format!("/wellness/checkins/{id}"),
        Some(&cookie),
        Some(json!({"feelingCore":"happy","intensity":5})),
    );
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["checkin"]["intensity"], 5);
    assert_eq!(json_of(&text)["checkin"]["note"], MARK);
    // The other person sees none of it and cannot change it.
    let (_, text) = call(Method::GET, "/wellness/checkins", Some(&other), None);
    assert_eq!(
        json_of(&text),
        json!({"checkins":[],"nextCursor":null}),
        "{text}"
    );
    assert!(!text.to_lowercase().contains(&MARK.to_lowercase()));
    assert_eq!(
        call(
            Method::PATCH,
            &format!("/wellness/checkins/{id}"),
            Some(&other),
            Some(json!({"feelingCore":"happy","note":"stolen"}))
        )
        .0,
        404
    );
    // The assistant-access choice is saved per person through the real preference store.
    let (_, text) = call(Method::GET, "/wellness/ai-consent", Some(&cookie), None);
    assert_eq!(json_of(&text), json!({"effective":true,"explicit":null}));
    let (_, text) = call(
        Method::PUT,
        "/wellness/ai-consent",
        Some(&cookie),
        Some(json!({"granted":false})),
    );
    assert_eq!(
        json_of(&text),
        json!({"effective":false,"explicit":false}),
        "{text}"
    );
    let (_, text) = call(Method::GET, "/wellness/ai-consent", Some(&other), None);
    assert_eq!(json_of(&text), json!({"effective":true,"explicit":null}));
    // Medicines: the owner adds two, takes a dose, reads the day and the summary. The other person
    // sees none of it and cannot change it. Every call goes through the real server.
    const MED_MARK: &str = "PLANTED-LIVE-MEDICINE-4b9c";
    let (status, text) = call(
        Method::POST,
        "/wellness/medications",
        Some(&cookie),
        Some(
            json!({"name":MED_MARK,"dosage":MED_MARK,"notes":MED_MARK,"frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00","20:00"]}),
        ),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let med = json_of(&text)["medication"].clone();
    let med_id = med["id"].as_str().unwrap().to_owned();
    assert_eq!(med["ownerUserId"], owner.to_string());
    let (status, text) = call(
        Method::POST,
        "/wellness/medications",
        Some(&cookie),
        Some(json!({"name":"Live as needed","frequencyType":"as_needed"})),
    );
    assert_eq!(status, 201, "{text}");
    let prn_id = json_of(&text)["medication"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, text) = call(
        Method::POST,
        &format!("/wellness/medications/{med_id}/logs"),
        Some(&cookie),
        Some(json!({"status":"taken","scheduledFor":"2026-03-15T08:00:00.000Z","dose":MED_MARK})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let (status, _) = call(
        Method::POST,
        &format!("/wellness/medications/{prn_id}/logs"),
        Some(&cookie),
        Some(json!({"status":"prn","prnReason":MED_MARK})),
    );
    assert_eq!(status, 201);
    let (status, text) = call(
        Method::GET,
        "/wellness/medications/schedule?date=2026-03-15",
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{text}");
    let slots = json_of(&text)["slots"].clone();
    let statuses: Vec<(String, String)> = slots
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_owned(),
                s["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert!(
        statuses.contains(&(MED_MARK.into(), "taken".into())),
        "{text}"
    );
    assert!(
        statuses.contains(&(MED_MARK.into(), "pending".into())),
        "{text}"
    );
    let (status, text) = call(
        Method::GET,
        "/wellness/medications/logs",
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["days"].as_array().unwrap().len(), 30);
    let (_, text) = call(Method::GET, "/wellness/medications", Some(&other), None);
    assert_eq!(json_of(&text), json!({"medications":[]}), "{text}");
    let (_, text) = call(
        Method::GET,
        "/wellness/medications/schedule?date=2026-03-15",
        Some(&other),
        None,
    );
    assert_eq!(json_of(&text)["slots"], json!([]), "{text}");
    assert_eq!(
        call(
            Method::PATCH,
            &format!("/wellness/medications/{med_id}"),
            Some(&other),
            Some(json!({"name":"stolen"}))
        )
        .0,
        404
    );
    assert_eq!(
        call(
            Method::POST,
            &format!("/wellness/medications/{med_id}/logs"),
            Some(&other),
            Some(json!({"status":"taken","scheduledFor":"2026-03-16T08:00:00.000Z"}))
        )
        .0,
        404
    );
    assert_eq!(
        call(Method::GET, "/wellness/medications", None, None).0,
        401
    );
    println!("PASS live medications: two medicines, a dose, the day and the summary worked over HTTPS, and the second person saw none of it");
    // Therapy notes and export on the real server. The worker runs inside the server process, so
    // the export is polled until it is ready.
    const NOTE: &str = "PLANTED-THERAPY-MARKER-91c3";
    let (status, text) = call(
        Method::POST,
        "/wellness/therapy-notes",
        Some(&cookie),
        Some(json!({"body":NOTE,"linkedCheckinId":id})),
    );
    assert_eq!(status, 201, "{text}\n{}", log());
    let note_id = json_of(&text)["note"]["id"].as_str().unwrap().to_owned();
    let (_, text) = call(Method::GET, "/wellness/therapy-notes", Some(&other), None);
    assert_eq!(json_of(&text), json!({"notes":[]}), "{text}");
    assert_eq!(
        call(
            Method::DELETE,
            &format!("/wellness/therapy-notes/{note_id}"),
            Some(&other),
            None
        )
        .0,
        404
    );
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let (status, text) = call(
        Method::POST,
        "/wellness/export",
        Some(&cookie),
        Some(json!({"from":today,"to":today,"categories":["therapyNotes"]})),
    );
    assert_eq!(status, 202, "{text}\n{}", log());
    let job = json_of(&text)["jobId"].as_str().unwrap().to_owned();
    let waited = std::time::Instant::now();
    loop {
        let (_, text) = call(
            Method::GET,
            &format!("/wellness/export/{job}"),
            Some(&cookie),
            None,
        );
        let state = json_of(&text)["status"].as_str().unwrap_or("").to_owned();
        if state == "ready" {
            break;
        }
        assert!(
            state != "failed" && waited.elapsed() < std::time::Duration::from_secs(120),
            "export did not finish: {text}\n{}",
            log()
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let (status, text) = call(
        Method::GET,
        &format!("/wellness/export/{job}/download"),
        Some(&cookie),
        None,
    );
    assert_eq!(status, 200, "{text}");
    let file = json_of(&text);
    assert!(file["html"].as_str().unwrap().contains(NOTE));
    assert!(
        !file["html"].as_str().unwrap().contains("Mood check-ins"),
        "unchosen category present"
    );
    for who in [&other] {
        assert_eq!(
            call(
                Method::GET,
                &format!("/wellness/export/{job}/download"),
                Some(who),
                None
            )
            .0,
            404
        );
        assert_eq!(
            call(
                Method::GET,
                &format!("/wellness/export/{job}"),
                Some(who),
                None
            )
            .0,
            404
        );
    }
    assert_eq!(
        call(
            Method::GET,
            &format!("/wellness/export/{job}/download"),
            None,
            None
        )
        .0,
        401
    );
    assert_eq!(
        call(
            Method::DELETE,
            &format!("/wellness/therapy-notes/{note_id}"),
            Some(&cookie),
            None
        )
        .0,
        200
    );
    println!("PASS live: therapy notes and a selective export worked over HTTPS for two people; the other person got 404");
    // Real activity rows hold no check-in text, and nothing the test sent reached the server log.
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(
            safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap(),
        ),
        std::sync::Arc::new(NoModel),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    // Chat tools over the real server. The owner's assistant access is still off from above.
    let tool = |name: &str, who: &str| {
        if who == cookie {
            services
                .approve_tool(&access, "wellness", name, &json!({}))
                .unwrap();
        }
        call(
            Method::POST,
            "/wellness/tools/run",
            Some(who),
            Some(json!({"tool":name,"parameters":{}})),
        )
    };
    let refusal =
        json!({"data":{"error":"Consent not granted","code":"WELLNESS_CONSENT_REQUIRED"}});
    for name in ["wellness.recentCheckIns", "wellness.medicationAdherence"] {
        let (status, text) = tool(name, &cookie);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(
            json_of(&text),
            refusal,
            "{name} must refuse with consent off"
        );
        assert!(!text.contains(MARK) && !text.contains(MED_MARK));
    }
    assert_eq!(
        call(
            Method::POST,
            "/wellness/tools/run",
            None,
            Some(json!({"tool":"wellness.recentCheckIns","parameters":{}}))
        )
        .0,
        401
    );
    assert_eq!(
        call(
            Method::POST,
            "/wellness/tools/run",
            Some(&cookie),
            Some(json!({"tool":"wellness.recentCheckIns","parameters":{"limit":3}}))
        )
        .0,
        400
    );
    let (_, text) = call(
        Method::PUT,
        "/wellness/ai-consent",
        Some(&cookie),
        Some(json!({"granted":true})),
    );
    assert_eq!(
        json_of(&text),
        json!({"effective":true,"explicit":true}),
        "{text}"
    );
    let (status, text) = tool("wellness.recentCheckIns", &cookie);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert!(
        !json_of(&text)["data"]["items"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{text}"
    );
    let (status, text) = tool("wellness.medicationAdherence", &cookie);
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["data"]["windowDays"], 7);
    assert!(
        !text.contains(MED_MARK),
        "adherence counts must hold no medicine text"
    );
    let (status, text) = call(Method::GET, "/wellness/insights", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert!(json_of(&text)["insights"].is_array());
    let (_, text) = call(Method::GET, "/wellness/insights", Some(&other), None);
    assert_eq!(json_of(&text), json!({"insights":[]}), "{text}");
    println!("PASS live tools: both chat tools refused with consent off, answered with it on, and insights worked over HTTPS for two people");
    // Hold the server open so the screens can be used in a browser.
    if let Ok(hold) = std::env::var("WELLNESS_LIVE_HOLD") {
        fs::write(
            format!("{hold}/ready.txt"),
            format!("{origin}\nhttps://{address}:{}\n", port.0),
        )
        .unwrap();
        while !std::path::Path::new(&format!("{hold}/stop")).exists() {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let activity = serde_json::to_string(&services.activity("wellness", &access).unwrap()).unwrap();
    assert!(!activity.contains(MARK) && !activity.contains(MED_MARK) && !activity.contains(NOTE));
    assert!(!log().to_lowercase().contains(&MARK.to_lowercase()));
    assert!(!log().to_lowercase().contains(&MED_MARK.to_lowercase()));
    assert!(
        !log().to_lowercase().contains(&NOTE.to_lowercase()),
        "therapy-note text reached the server log"
    );
    println!("wellness live: check-ins, history paging, change, consent, medicines and therapy notes for two people worked over HTTPS");
}
