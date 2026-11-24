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
    if let Ok(shell_web) = std::env::var("SPORTS_LIVE_WEB") {
        // A built shell, so the screen opens inside the real app frame.
        let status = Command::new("cp").args(["-r", "-T", &shell_web]).arg(root.join("web")).status().unwrap();
        assert!(status.success());
    } else {
        fs::write(
            root.join("web/index.html"),
            "<!doctype html><title>Sports HTTP fixture</title>",
        )
        .unwrap();
    }
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
        .timeout(Duration::from_secs(30))
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
            presentation: None,
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
        publish_reviews: Default::default(),
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

    let mut modules = json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key});
    // Part 16. With a browser folder the real server may open the sandboxed browser.
    if let Ok(dir) = std::env::var("MOSS_BROWSER_DIR") {
        modules["browser_dir"] = json!(dir);
    }
    private(&root.join("modules.json"), &modules);
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
        if status >= 400 {
            println!("  body: {}", text.chars().take(400).collect::<String>());
        }
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    const MARK: &str = "PLANTED-LIVE-MARKER-7d2e";
    assert_eq!(call(Method::GET, "/follows", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/sports/follows"))
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
    // Part 12b. The stories come from real ESPN, and the featured story's body from ESPN's real
    // article page, with nothing rewritten on the way.
    let hero_mode = mine["hero"]["mode"].as_str().unwrap_or("").to_owned();
    let band: Vec<&Value> = mine["leagueNews"].as_array().unwrap().iter().flat_map(|g| g["headlines"].as_array().unwrap()).collect();
    let top = mine["topStories"].as_array().unwrap();
    println!("sports live: hero {hero_mode}, {} top stories, {} band stories", top.len(), band.len());
    assert!(!top.is_empty() && !band.is_empty(), "real NFL stories expected: {text}");
    let featured: Vec<&&Value> = band.iter().filter(|h| h["body"].as_str().is_some_and(|b| !b.is_empty())).collect();
    assert_eq!(featured.len(), 1, "exactly one featured story with a real body: {text}\n{}", log());
    let body = featured[0]["body"].as_str().unwrap();
    println!("sports live: featured story {:?} body {} characters: {:?}", featured[0]["title"], body.chars().count(), body.chars().take(160).collect::<String>());
    assert!(body.encode_utf16().count() <= 901 && !body.contains('<') && !body.contains("&amp;"), "{body}");
    assert!(body != featured[0]["summary"].as_str().unwrap_or(""), "the body is the article text, not the summary");
    let (_, again) = call(Method::GET, "/overview", Some(&cookie), None);
    assert_eq!(json_of(&again)["degraded"], json!(false), "a second read is served from the shared copy");
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
    // Hold the server open so the real screen can be opened in a browser with real ESPN data.
    if let Ok(hold) = std::env::var("SPORTS_LIVE_HOLD") {
        for (key, team) in [("nfl", "dal"), ("nba", "lal"), ("nhl", "")] {
            let body = if team.is_empty() { json!({"competitionKey":key}) } else { json!({"competitionKey":key,"teamKey":team}) };
            let (status, text) = call(Method::POST, "/follows", Some(&cookie), Some(body));
            println!("hold: follow {key} {team}: {status} {}", text.chars().take(80).collect::<String>());
        }
        fs::write(format!("{hold}/ready.txt"), format!("{origin}\n{cookie}\n{origin}/module-frame?module=sports&path=/sports\n")).unwrap();
        while !std::path::Path::new(&format!("{hold}/stop")).exists() {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    // The owner removes the follow.
    let (status, text) = call(Method::DELETE, &format!("/follows/{id}"), Some(&cookie), None);
    assert_eq!((status, json_of(&text)), (200, json!({"ok":true})));
    // Adding a real subreddit. The feed is read from the real internet through the server's own
    // public-web fetch, with nothing rewritten on the way. Two spellings that differ only by case
    // are one source.
    // Reddit turns this machine away now and then with a rate limit or a refusal, so a refusal is
    // retried after a pause. Every answer is the real one and is printed.
    let mut shown = Value::Null;
    for attempt in 1..=4 {
        let (status, text) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"url":"r/nfl","assignments":[{"target":{"kind":"sport","sportKey":"football"}}]})));
        assert_eq!(status, 200, "{text}\n{}", log());
        shown = json_of(&text);
        println!("sports live: r/nfl preview attempt {attempt}: {} {}", shown["status"], shown["reason"]);
        let retry = matches!(shown["reason"].as_str(), Some("rate_limited" | "auth_required" | "unreachable"));
        if shown["status"] == "ok" || !retry {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
    if shown["status"] != "ok" {
        println!("sports live: NOT PROVEN: Reddit refused the real server on every try ({}), so no real subreddit was saved", shown["reason"]);
    } else {
        let candidate = &shown["candidate"];
        println!("sports live: real subreddit previewed: {} ({} sample headlines)", candidate["label"], candidate["samples"].as_array().map_or(0, Vec::len));
        let confirm = json!({
            "confirmationId": shown["confirmationId"],
            "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
            "canonicalDomain": candidate["canonicalDomain"],
            "confirmedFetchHosts": candidate["confirmedFetchHosts"],
            "targets": candidate["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
        });
        let (status, text) = call(Method::POST, "/sources", Some(&other), Some(confirm.clone()));
        assert_eq!(status, 409, "another person must not save this preview: {text}");
        let (status, text) = call(Method::POST, "/sources", Some(&cookie), Some(confirm));
        assert_eq!(status, 201, "{text}\n{}", log());
        let saved = json_of(&text);
        let source_id = saved["source"]["id"].as_str().unwrap().to_owned();
        let (_, text) = call(Method::GET, "/sources", Some(&cookie), None);
        assert_eq!(json_of(&text)["sources"].as_array().unwrap().len(), 2, "ESPN plus the subreddit: {text}");
        let (_, text) = call(Method::GET, "/sources", Some(&other), None);
        assert_eq!(json_of(&text)["sources"].as_array().unwrap().len(), 1, "the other person sees only ESPN: {text}");
        let mut again = Value::Null;
        let mut text = String::new();
        for _ in 0..6 {
            let (status, body) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"url":"r/NFL"})));
            assert_eq!(status, 200, "{body}");
            again = json_of(&body);
            text = body;
            if again["status"] == "ok" {
                break;
            }
            println!("sports live: r/NFL preview answered {} {}", again["status"], again["reason"]);
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        assert_eq!(again["duplicateOfSourceId"], json!(source_id), "r/NFL is the same source as r/nfl: {text}");
        let (status, text) = call(Method::POST, "/sources", Some(&cookie), Some(json!({
            "confirmationId": again["confirmationId"],
            "authorizationAcknowledgement": again["authorizationAcknowledgement"],
            "canonicalDomain": again["candidate"]["canonicalDomain"],
            "confirmedFetchHosts": again["candidate"]["confirmedFetchHosts"],
            "targets": [],
        })));
        assert_eq!((status, json_of(&text)["error"].clone()), (409, json!("Source already exists")), "{text}\n{}", log());
        let (_, text) = call(Method::GET, "/sources", Some(&cookie), None);
        assert_eq!(json_of(&text)["sources"].as_array().unwrap().len(), 2, "still one subreddit: {text}");
        let (status, text) = call(Method::DELETE, &format!("/sources/{source_id}"), Some(&other), None);
        assert_eq!((status, json_of(&text)), (200, json!({"deleted":false})), "the other person cannot delete it");
        let (status, text) = call(Method::DELETE, &format!("/sources/{source_id}"), Some(&cookie), None);
        assert_eq!((status, json_of(&text)), (200, json!({"deleted":true})), "{text}");
        println!("sports live: the real subreddit was saved once, hidden from the other person and removed");
    }
    // Part 14a. A real feed source is saved and read again through the real fetch path, with
    // nothing rewritten. A site with no feed asks the person's model for a recipe when one is set
    // up, and the answer is printed either way.
    let (status, text) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"url":"https://www.telegraph.co.uk/sport/rss.xml","assignments":[{"target":{"kind":"sport","sportKey":"football"}}]})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let shown = json_of(&text);
    println!("sports live: real feed preview: {} {}", shown["status"], shown["reason"]);
    if shown["status"] == "ok" {
        let candidate = &shown["candidate"];
        let confirm = json!({
            "confirmationId": shown["confirmationId"],
            "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
            "canonicalDomain": candidate["canonicalDomain"],
            "confirmedFetchHosts": candidate["confirmedFetchHosts"],
            "targets": candidate["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
        });
        let (status, text) = call(Method::POST, "/sources", Some(&cookie), Some(confirm));
        assert_eq!(status, 201, "{text}\n{}", log());
        let feed_id = json_of(&text)["source"]["id"].as_str().unwrap().to_owned();
        let (status, text) = call(Method::POST, &format!("/sources/{feed_id}/retry"), Some(&cookie), None);
        assert_eq!(status, 200, "{text}\n{}", log());
        let source = &json_of(&text)["source"];
        println!("sports live: retry of the real feed: health {} checked {}", source["healthState"], source["lastCheckedAt"]);
        assert_eq!(source["healthState"], "healthy", "{text}");
        // Part 17. The refresh above also looked for story photos, over the real internet, with
        // nothing rewritten. Stored copies are checked on disk, then read back through the route.
        let stored = |dir: &Path| -> Vec<std::path::PathBuf> {
            walk(dir).into_iter().filter(|p| p.extension().is_some_and(|e| e == "jpg")).collect()
        };
        let copies = stored(&root.join("data/modules/files/sports"));
        println!("sports live: photo copies stored by the real refresh: {}", copies.len());
        for copy in &copies {
            let bytes = fs::read(copy).unwrap();
            assert_eq!(&bytes[..3], &[0xff, 0xd8, 0xff], "a JPEG");
            assert!(!bytes.windows(4).any(|w| w == b"Exif"), "no camera data survives");
            assert!(bytes.len() <= 786_432);
        }
        if copies.is_empty() {
            println!("sports live: NOT PROVEN: the real feed gave no photo that passed the checks");
        } else {
            use sha2::{Digest, Sha256};
            let feed = client.get("https://www.telegraph.co.uk/sport/rss.xml").header("user-agent", "Mozilla/5.0").send().unwrap().text().unwrap();
            let between = |text: &str, open: &str, close: &str| -> Option<String> {
                let start = text.find(open)? + open.len();
                let end = text[start..].find(close)? + start;
                Some(text[start..end].replace("<![CDATA[", "").replace("]]>", "").trim().to_owned())
            };
            let mut served = 0;
            for item in feed.split("<item>").skip(1).take(12) {
                let (Some(title), Some(link)) = (between(item, "<title>", "</title>"), between(item, "<link>", "</link>")) else { continue };
                let digest = format!("{:x}", Sha256::digest(format!("{link}\0{title}").as_bytes()));
                let (status, text) = call(Method::GET, &format!("/headlines/{feed_id}:{}/photo", &digest[..24]), Some(&cookie), None);
                if status == 200 {
                    served += 1;
                    assert_eq!(json_of(&text)["contentType"], "image/jpeg");
                    assert_eq!(call(Method::GET, &format!("/headlines/{feed_id}:{}/photo", &digest[..24]), Some(&other), None).0, 404);
                }
            }
            println!("sports live: photos served through the real route: {served}");
            assert!(served > 0, "at least one stored photo is served");
            assert_eq!(call(Method::DELETE, &format!("/sources/{feed_id}/photos"), Some(&other), None).0, 404);
            let (status, _) = call(Method::DELETE, &format!("/sources/{feed_id}/photos"), Some(&cookie), None);
            assert_eq!(status, 200);
            assert!(stored(&root.join("data/modules/files/sports")).is_empty(), "stopping photos removed the files");
            println!("sports live: stopping photos removed every stored copy");
        }
        assert_eq!(call(Method::POST, &format!("/sources/{feed_id}/retry"), Some(&other), None).0, 404);
        let (status, text) = call(Method::POST, &format!("/sources/{feed_id}/rebuild/preview"), Some(&cookie), None);
        println!("sports live: rebuild preview of a feed source: {status} {}", text.chars().take(120).collect::<String>());
        call(Method::DELETE, &format!("/sources/{feed_id}"), Some(&cookie), None);
    } else {
        println!("sports live: NOT PROVEN: the real feed preview answered {} {}", shown["status"], shown["reason"]);
    }
    // A real model through the local test endpoint, with the person's own stored provider. The
    // key is read from its config file and never printed. The cheapest model is used.
    let key_path = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/cliproxyapi/client-key");
    let model_name = std::env::var("SPORTS_LIVE_MODEL").unwrap_or_else(|_| "gpt-6.1-sol".into());
    let has_model = if let Ok(key) = fs::read_to_string(&key_path) {
        let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
            .unwrap()
            .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new(key.trim())));
        let provider: uuid::Uuid = uuid::Uuid::new_v4();
        let model: uuid::Uuid = uuid::Uuid::new_v4();
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            db.execute(
                "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Test endpoint','http://127.0.0.1:5190',$3,true)",
                &[&provider, &owner, &sealed],
            ).await.unwrap();
            db.execute(
                "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,$4,'Test model',ARRAY['chat','json'])",
                &[&model, &provider, &owner, &model_name],
            ).await.unwrap();
        });
        true
    } else {
        false
    };
    let site = std::env::var("SPORTS_LIVE_SITE").unwrap_or_else(|_| "https://www.thefa.com/news".into());
    let (status, text) = call(Method::POST, "/sources/preview", Some(&cookie), Some(json!({"url":site,"assignments":[{"target":{"kind":"sport","sportKey":"football"}}]})));
    assert_eq!(status, 200, "{text}\n{}", log());
    let proposed = json_of(&text);
    println!("sports live: recipe proposal for a site with no feed ({model_name}): {} {}", proposed["status"], proposed["reason"]);
    if has_model && proposed["status"] == "ok" {
        assert_eq!(proposed["candidate"]["retrievalMethod"], "scrape", "{text}");
        println!("sports live: real model recipe replayed through the real fetch: {} sample headlines {}", proposed["candidate"]["sampleHeadlines"].as_array().map_or(0, Vec::len), proposed["candidate"]["sampleHeadlines"]);
        let confirm = json!({
            "confirmationId": proposed["confirmationId"],
            "authorizationAcknowledgement": proposed["authorizationAcknowledgement"],
            "canonicalDomain": proposed["candidate"]["canonicalDomain"],
            "confirmedFetchHosts": proposed["candidate"]["confirmedFetchHosts"],
            "targets": proposed["candidate"]["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
        });
        let (status, text) = call(Method::POST, "/sources", Some(&cookie), Some(confirm));
        assert_eq!(status, 201, "{text}\n{}", log());
        let scrape_id = json_of(&text)["source"]["id"].as_str().unwrap().to_owned();
        let (status, text) = call(Method::POST, &format!("/sources/{scrape_id}/retry"), Some(&cookie), None);
        assert_eq!(status, 200, "{text}");
        let source = json_of(&text)["source"].clone();
        println!("sports live: refresh of the model's recipe: health {} recipe {}", source["healthState"], source["recipeStatus"]);
        assert_eq!(source["healthState"], "healthy", "{text}");
        let (status, text) = call(Method::DELETE, &format!("/sources/{scrape_id}"), Some(&cookie), None);
        assert_eq!(status, 200, "{text}");
    } else {
        assert!(["unavailable", "rejected", "ok"].contains(&proposed["status"].as_str().unwrap_or_default()), "{text}");
        println!("sports live: NOT PROVEN: no usable model answer on this run (key present: {has_model}, answer {})", proposed["status"]);
    }
    // Part 14b. The nine source tools run through the real tool route of the real server. The
    // approval is granted through the trusted host store, as the approval screen does, and nothing
    // the server answers is rewritten.
    {
        struct NoModel;
        impl moss_module_host::ai::Intelligence for NoModel {
            fn generate(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
                anyhow::bail!("No model")
            }
            fn embed(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
                anyhow::bail!("No model")
            }
        }
        let services = moss_module_host::services::ServicePorts::new(
            &root.join("data"),
            std::sync::Arc::new(safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap()),
            std::sync::Arc::new(NoModel),
            std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
        )
        .unwrap();
        let policies = std::collections::BTreeMap::from(["sports.listSources", "sports.previewSource", "sports.previewSourceAssignments", "sports.rebuildSourceRecipe", "sports.followedFactsToday", "sports.heartbeatNextFixtures", "sports.latestResult"].map(|name| (name.to_owned(), false)));
        services.set_action_policy(&access, "sports", &policies).unwrap();
        let tool = |who: &str, name: &str, parameters: Value| call(Method::POST, "/tools/run", Some(who), Some(json!({"tool":name,"parameters":parameters})));
        let (status, text) = tool(&cookie, "sports.listSources", json!({}));
        assert_eq!(status, 200, "{text}\n{}", log());
        println!("sports live: listSources through the tool route answered {}", json_of(&text)["data"]["sources"].as_array().map_or(0, Vec::len));
        // A read-only preview of a real subreddit, then a save that is refused three ways.
        let (status, text) = tool(&cookie, "sports.previewSource", json!({"url":"r/soccer"}));
        assert_eq!(status, 200, "{text}\n{}", log());
        let shown = json_of(&text)["data"].clone();
        println!("sports live: previewSource through the tool route: {} {}", shown["status"], shown["reason"]);
        if shown["status"] == "ok" {
            let confirm = json!({
                "confirmationId": shown["confirmationId"],
                "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
                "canonicalDomain": shown["candidate"]["canonicalDomain"],
                "confirmedFetchHosts": shown["candidate"]["confirmedFetchHosts"],
                "targets": [],
            });
            let (status, text) = tool(&cookie, "sports.confirmSource", confirm.clone());
            assert_eq!(status, 403, "no approval: {text}");
            services.approve_tool(&access, "sports", "sports.confirmSource", &confirm).unwrap();
            let (status, text) = tool(&cookie, "sports.confirmSource", confirm.clone());
            assert_ne!(status, 200, "a plain approval without the displayed version must not save: {text}");
            services.approve_tool_at_version(&access, "sports", "sports.confirmSource", &confirm, "an-old-version").unwrap();
            let (status, text) = tool(&cookie, "sports.confirmSource", confirm.clone());
            assert!(status == 200 && json_of(&text)["data"]["error"].as_str().is_some_and(|e| e.contains("approval no longer matches")), "{status} {text}");
            let (_, text) = call(Method::GET, "/sources", Some(&cookie), None);
            assert_eq!(json_of(&text)["sources"].as_array().unwrap().len(), 1, "nothing was saved: {text}");
            println!("sports live: confirmSource refused with no approval, a plain approval and an old version; nothing saved");
        } else {
            println!("sports live: NOT PROVEN: the real subreddit preview answered {} {}", shown["status"], shown["reason"]);
        }
        let (status, text) = tool(&other, "sports.removeSource", json!({"sourceId":"99999999-9999-4999-8999-999999999999"}));
        assert_eq!(status, 403, "{text}");
        println!("sports live: removeSource asks first: refused without an approval");
        // The follow tools save and remove only the caller's own follows, and the read tools answer.
        // The host asks for a one-use grant on every tool that is not read-only.
        let league = json!({"competitionKey":"nfl"});
        services.approve_tool(&access, "sports", "sports.followTeam", &league).unwrap();
        let (status, text) = tool(&cookie, "sports.followTeam", league.clone());
        assert_eq!(status, 200, "{text}\n{}", log());
        let new_id = json_of(&text)["data"]["follow"]["id"].as_str().expect(&text).to_owned();
        let (_, text) = call(Method::GET, "/follows", Some(&other), None);
        assert!(!text.contains(&new_id), "the other person must not see it: {text}");
        let (status, text) = tool(&cookie, "sports.followedFactsToday", json!({"timeZone":"America/New_York"}));
        assert_eq!(status, 200, "{text}\n{}", log());
        println!("sports live: followedFactsToday answered state {}", json_of(&text)["data"]["evidence"]["state"]);
        let (status, text) = tool(&cookie, "sports.heartbeatNextFixtures", json!({"horizonHours":24,"limit":5}));
        assert_eq!(status, 200, "{text}\n{}", log());
        println!("sports live: heartbeatNextFixtures answered {} items, freshness {}", json_of(&text)["data"]["items"].as_array().map_or(0, Vec::len), json_of(&text)["data"]["freshness"]);
        let (status, text) = tool(&cookie, "sports.latestResult", json!({}));
        assert_eq!(status, 200, "{text}\n{}", log());
        services.approve_tool(&access, "sports", "sports.unfollowTeam", &league).unwrap();
        let (status, text) = tool(&cookie, "sports.unfollowTeam", league);
        assert_eq!(status, 200, "{text}\n{}", log());
        assert_eq!(json_of(&text)["data"]["removed"], true, "{text}");
        println!("sports live: followTeam, followedFactsToday, heartbeatNextFixtures, latestResult and unfollowTeam worked through the tool route");
    }
    // Nothing the test sent reached the server log.
    assert!(!log().contains(MARK));
    println!("sports live: follows and standings choices for two people worked over HTTPS");
}
