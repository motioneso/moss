//! Installed Sports package served by the real HTTPS executable. Not a native UI proof.
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
fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    if let Ok(read) = fs::read_dir(dir) {
        for e in read.flatten() {
            let p = e.path();
            if p.is_dir() { out.extend(walk(&p)); } else { out.push(p); }
        }
    }
    out
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
#[ignore = "Only through verify-gate and the Sports live gate"]
fn installed_sports_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js273-sports-{}", std::process::id())])
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
        "<!doctype html><title>Sports HTTP fixture</title>",
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
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-sports-signing-secret-273","connector_key":connector_key}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-sports-password-273-not-a-real-secret"})).send().unwrap();
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
    let cookie = signup("sports-owner@example.test", "Sports owner");
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
                "SELECT id FROM app.users WHERE email='sports-owner@example.test'",
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
    let access = AccessContext::new(owner, "sports-install");
    // Publish the Sports package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS235_SPORTS_PACKAGE", "sports")]
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
            publisher_key: "sports-test".into(),
            signature: Keys::sign(&keys.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: "Sports live gate".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    })
    .collect();
    let identity = RegistryIdentity {
        id: "sports-test-registry".into(),
        name: "Sports test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "sports-test".into(),
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
            "sports-test-registry",
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
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Sports other', 'sports-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin)
            .json(&json!({"email":"sports-other@example.test","password":"temporary-sports-password-273-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client.request(method, format!("{origin}/api/m/sports{path}")).header("origin", &origin);
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
    const MARK: &str = "PLANTED-LIVE-MARKER-7d2e";
    assert_eq!(call(Method::GET, "/follows", None, None).0, 401);
    // The server answers 503 until its module host has finished starting.
    let started = std::time::Instant::now();
    while call(Method::GET, "/follows", Some(&cookie), None).0 == 503 && started.elapsed() < std::time::Duration::from_secs(60) {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for who in [&cookie, &other] {
        let (status, text) = call(Method::GET, "/follows", Some(who), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text), json!({"follows":[]}));
    }
    // The owner follows a league twice and gets the same row back.
    let (status, text) = call(Method::POST, "/follows", Some(&cookie), Some(json!({"competitionKey":"nfl"})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let id = json_of(&text)["follow"]["id"].as_str().unwrap().to_owned();
    let (_, again) = call(Method::POST, "/follows", Some(&cookie), Some(json!({"competitionKey":"nfl"})));
    assert_eq!(json_of(&again)["follow"]["id"], json!(id));
    let (_, list) = call(Method::GET, "/follows", Some(&cookie), None);
    assert_eq!(json_of(&list)["follows"].as_array().unwrap().len(), 1, "{list}");
    // Bad input gets the old words, and the typed text is never kept.
    let (status, text) = call(Method::POST, "/follows", Some(&cookie), Some(json!({"competitionKey": MARK})));
    assert_eq!((status, json_of(&text)["error"].clone()), (400, json!(format!("Unknown competition: {MARK}"))), "{text}");
    let (status, text) = call(Method::POST, "/follows", Some(&cookie), Some(json!({"competitionKey":"nba","teamKey":"LAL"})));
    assert_eq!((status, json_of(&text)["error"].clone()), (400, json!("Unknown team: LAL")), "{text}");
    let (status, text) = call(Method::POST, &format!("/follows/{id}/team"), Some(&cookie), Some(json!({"sourceTeamId":"lal"})));
    assert_eq!((status, json_of(&text)["error"].clone()), (400, json!("That follow is a whole competition, not a team.")), "{text}");
    // Standings choices are kept in catalog order and read back.
    let (status, text) = call(Method::PUT, "/standings-preferences", Some(&cookie), Some(json!({"selectedCompetitionKeys":["nhl","nba"]})));
    assert_eq!((status, json_of(&text)["selectedCompetitionKeys"].clone()), (200, json!(["nba","nhl"])), "{text}");
    let (status, text) = call(Method::PUT, "/standings-preferences", Some(&cookie), Some(json!({"lastViewed":{"competitionKey":"nhl"}})));
    assert_eq!(status, 200, "{text}");
    let (_, text) = call(Method::GET, "/standings-preferences", Some(&cookie), None);
    assert_eq!(json_of(&text), json!({"selectedCompetitionKeys":["nba","nhl"],"lastViewed":{"competitionKey":"nhl","viewKey":null,"viewLabel":null}}));
    let (status, text) = call(Method::PUT, "/standings-preferences", Some(&cookie), Some(json!({"selectedCompetitionKeys":["zzz"]})));
    assert_eq!(status, 400, "{text}");
    // The other person sees none of it and cannot change it.
    let (_, text) = call(Method::GET, "/follows", Some(&other), None);
    assert_eq!(json_of(&text), json!({"follows":[]}));
    let (_, text) = call(Method::GET, "/standings-preferences", Some(&other), None);
    assert_eq!(json_of(&text), json!({"selectedCompetitionKeys":null,"lastViewed":null}));
    let (status, text) = call(Method::DELETE, &format!("/follows/{id}"), Some(&other), None);
    assert_eq!((status, json_of(&text)), (200, json!({"ok":false})));
    assert_eq!(call(Method::POST, &format!("/follows/{id}/team"), Some(&other), Some(json!({"sourceTeamId":"lal"}))).0, 404);
    let (_, list) = call(Method::GET, "/follows", Some(&cookie), None);
    assert_eq!(json_of(&list)["follows"].as_array().unwrap().len(), 1, "B's delete must not remove A's follow");
    // Public data comes from real ESPN through the real fetch path, for both people alike.
    let (status, text) = call(Method::GET, "/catalog", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["competitions"].as_array().unwrap().len(), 64);
    let started = std::time::Instant::now();
    let (status, text) = call(Method::GET, "/leagues/nfl/teams", Some(&cookie), None);
    println!("live ESPN nfl roster took {:?}", started.elapsed());
    assert_eq!(status, 200, "{text}\n{}", log());
    let roster = json_of(&text);
    assert_eq!(roster["degraded"], json!(false), "{text}");
    assert!(roster["teams"].as_array().unwrap().len() >= 30, "{text}");
    let (_, again) = call(Method::GET, "/leagues/nfl/teams", Some(&other), None);
    assert_eq!(json_of(&again), roster, "the second person reads the same public roster");
    let keys: Vec<String> = json_of(&call(Method::GET, "/catalog", Some(&cookie), None).1)["competitions"]
        .as_array().unwrap().iter().map(|c| c["competitionKey"].as_str().unwrap().to_owned()).collect();
    for key in &keys {
        let t = std::time::Instant::now();
        let (status, text) = call(Method::GET, &format!("/leagues/{key}/teams"), Some(&cookie), None);
        let v = json_of(&text);
        println!("ROSTER {key} status={status} degraded={} teams={} in {:?}", v["degraded"], v["teams"].as_array().map_or(0, Vec::len), t.elapsed());
    }
    let started = std::time::Instant::now();
    let (status, text) = call(Method::GET, "/teams/search?q=dallas", Some(&other), None);
    println!("live ESPN search took {:?}", started.elapsed());
    assert_eq!(status, 200, "{text}\n{}", log());
    let found = json_of(&text);
    assert!(found["teams"].as_array().unwrap().iter().any(|t| t["name"] == "Dallas Cowboys"), "{text}");
    let (status, text) = call(Method::GET, &format!("/teams/search?q={MARK}"), Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert_eq!(json_of(&text)["teams"], json!([]));
    // A team follow checks the live roster.
    let (status, text) = call(Method::POST, "/follows", Some(&other), Some(json!({"competitionKey":"nfl","teamKey":"dal"})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let (_, mine) = call(Method::GET, "/follows", Some(&cookie), None);
    assert_eq!(json_of(&mine)["follows"].as_array().unwrap().len(), 1, "A sees none of B's team follow");
    // The overview reads real ESPN through the real fetch path, one person at a time.
    let started = std::time::Instant::now();
    let (status, text) = call(Method::GET, "/overview", Some(&other), None);
    println!("live ESPN overview took {:?}", started.elapsed());
    assert_eq!(status, 200, "{text}\n{}", log());
    let theirs = json_of(&text);
    let cards = theirs["followed"].as_array().unwrap();
    assert_eq!(cards.len(), 1, "{text}");
    assert_eq!(cards[0]["name"], "Dallas Cowboys", "{text}");
    assert_eq!(theirs["degraded"], json!(false), "{text}");
    assert!(theirs["standings"].as_array().is_some_and(|s| !s.is_empty()), "{text}");
    let (status, text) = call(Method::GET, "/overview", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    let mine = json_of(&text);
    assert_eq!(mine["followed"], json!([]), "A follows no club, so A has no card");
    assert_eq!(mine["followedLeagues"][0]["competitionKey"], "nfl", "{text}");
    let (status, text) = call(Method::GET, "/standings?competitionKey=nfl", Some(&cookie), None);
    assert_eq!(status, 200, "{text}");
    assert!(json_of(&text)["group"]["sections"].as_array().is_some_and(|s| !s.is_empty()), "{text}");
    let (status, text) = call(Method::GET, "/results/latest?competitionKey=nfl&teamName=dallas", Some(&other), None);
    assert_eq!(status, 200, "{text}");
    println!("live results status {}", json_of(&text)["status"]);
    for entry in walk(&root.join("data")) {
        if entry.file_name().is_some_and(|n| n == "kv.json") {
            let kv = fs::read_to_string(&entry).unwrap_or_default();
            assert!(!kv.contains(MARK) && !kv.contains(&owner.to_string()), "cache file {entry:?} holds a query or a person");
        }
    }
    // The owner removes the follow.
    let (status, text) = call(Method::DELETE, &format!("/follows/{id}"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"ok":true})));
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("sports live: follows and standings choices for two people worked over HTTPS");
}
