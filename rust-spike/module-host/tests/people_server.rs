//! Installed People package served by the real HTTPS executable. Not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
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
#[ignore = "Only through verify-gate and the People server gate"]
fn installed_people_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js177-people-{}", std::process::id())])
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
    // MOSS_PEOPLE_HOST names the address another device uses. When set, the listener binds
    // every interface, trusts that origin and turns on sharing. The test itself stays on
    // the loopback origin.
    let remote = std::env::var("MOSS_PEOPLE_HOST")
        .ok()
        .map(|host| format!("https://{host}:{}", port.0));
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .args(&remote)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    fs::create_dir(root.join("web")).unwrap();
    if let Ok(shared) = std::env::var("MOSS_MODULE_SHARED_DIR") {
        // Generated shared styles and fonts for a manual browser check.
        let status = Command::new("cp")
            .args(["-r", &shared])
            .arg(root.join("web/module-shared"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>People HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-people-signing-secret-177","connector_key":connector_key}),
    );
    let origins: Vec<String> = [Some(origin.clone()), remote.clone()]
        .into_iter()
        .flatten()
        .collect();
    private(
        &root.join("network.json"),
        &json!({"listen":format!("{}:{}",if remote.is_some() {"0.0.0.0"} else {"127.0.0.1"},port.0),"origins":origins,"sharing":remote.is_some(),"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
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
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-people-password-177-not-a-real-secret"})).send().unwrap();
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("people-owner@example.test", "People owner");
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
                "SELECT id FROM app.users WHERE email='people-owner@example.test'",
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
    let access = AccessContext::new(owner, "people-install");
    installed::install(
        &root.join("data"),
        &root.join("registry"),
        app,
        &access,
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    );
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
    );
    let _server = start(true);
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/people{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let began = Instant::now();
        let response = request.send().unwrap_or_else(|e| {
            panic!(
                "{path}: {e}\n{}",
                fs::read_to_string(root.join("server.log")).unwrap_or_default()
            )
        });
        println!("{path} answered in {:?}", began.elapsed());
        let status = response.status().as_u16();
        (status, response.json::<Value>().unwrap_or(Value::Null))
    };
    use reqwest::Method;
    // The module host opens in the background; wait until it answers.
    let ready = Instant::now() + Duration::from_secs(90);
    while call(Method::GET, "/people", Some(&cookie), None).0 == 503 {
        assert!(Instant::now() < ready, "module host never became ready");
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(call(Method::GET, "/people", None, None).0, 401);
    let (status, list) = call(Method::GET, "/people", Some(&cookie), None);
    assert_eq!(status, 200, "{list}");
    let folder = root.join("notes").join(owner.to_string());
    let saved = call(
        Method::PUT,
        "/people/notes-settings",
        Some(&cookie),
        Some(json!({"folder": folder})),
    );
    assert_eq!(
        saved.0,
        200,
        "{}\n{}",
        saved.1,
        fs::read_to_string(root.join("server.log")).unwrap_or_default()
    );
    let created = call(
        Method::POST,
        "/people",
        Some(&cookie),
        Some(json!({"displayName":"Ada Lovelace"})),
    );
    assert_eq!(
        created.0,
        200,
        "{}\n{}",
        created.1,
        fs::read_to_string(root.join("server.log")).unwrap_or_default()
    );
    assert!(
        folder
            .join(created.1["notePath"].as_str().unwrap())
            .is_file(),
        "the person note must land in the account folder"
    );
    let (_, mine) = call(Method::GET, "/people", Some(&cookie), None);
    assert!(mine.to_string().contains("Ada Lovelace"), "{mine}");
    let (status, settings) = call(Method::GET, "/people/notes-settings", Some(&cookie), None);
    assert_eq!(status, 200, "{settings}");
    println!("PASS installed People package served over HTTPS: sign-in required, create writes a note in the account folder, list, notes settings reachable");

    // The signed-in account gets the verified screen address. The screen's own files are
    // public, carry the module policy and never need the session cookie.
    let screen_url = format!("{origin}/api/modules/people/screen?path=/settings/memory/people");
    assert_eq!(client.get(&screen_url).send().unwrap().status(), 401);
    let screen: Value = client
        .get(&screen_url)
        .header("cookie", &cookie)
        .send()
        .unwrap()
        .json()
        .unwrap();
    let src = screen["src"].as_str().expect("screen address");
    assert!(src.starts_with("/module-ui/people/"), "{screen}");
    let asset = client
        .get(format!("{origin}{src}"))
        .header("origin", "null")
        .header("sec-fetch-site", "cross-site")
        .send()
        .unwrap();
    assert_eq!(asset.status(), 200, "screen file without a session");
    // The opaque-origin exemption covers module files only. Account routes still refuse it,
    // and a foreign Host never reaches the asset handler.
    let cross_site_api = client
        .get(format!("{origin}/api/m/people/people?limit=1"))
        .header("cookie", &cookie)
        .header("origin", "null")
        .header("sec-fetch-site", "cross-site")
        .send()
        .unwrap();
    assert!(
        cross_site_api.status() == 403 || cross_site_api.status() == 401,
        "cross-site account route: {}",
        cross_site_api.status()
    );
    let foreign_host = client
        .get(format!("{origin}{src}"))
        .header("host", "evil.example")
        .send()
        .unwrap();
    assert!(
        foreign_host.status().is_client_error(),
        "foreign host: {}",
        foreign_host.status()
    );
    let csp = asset.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        csp.contains("sandbox allow-scripts allow-forms") && csp.contains(&origin),
        "{csp}"
    );
    assert_eq!(
        client
            .get(format!("{origin}/api/modules/people/screen?path=/nope"))
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status(),
        404
    );
    println!("PASS People screen address and files served over HTTPS");
    // Optional manual browser check: keep the server up and print where it is.
    if let Ok(seconds) = std::env::var("MOSS_PEOPLE_HOLD_SECONDS") {
        println!("HOLD {} for {seconds}s", remote.as_ref().unwrap_or(&origin));
        std::thread::sleep(Duration::from_secs(seconds.parse().unwrap_or(0)));
    }

    // Second account. Setup allows one owner over HTTP, so the account is made in the
    // database with the owner's password hash and then signs in through the real route.
    let second: uuid::Uuid = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let id = uuid::Uuid::new_v4();
        db.execute(
            "INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) \
             VALUES ($1, 'People second', 'people-second@example.test', false, now(), now(), false, 'active')",
            &[&id],
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) \
             SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() \
             FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'",
            &[&id, &owner],
        )
        .await
        .unwrap();
        id
    });
    let signed = client
        .post(format!("{origin}/api/auth/sign-in/email"))
        .header("origin", &origin)
        .json(&json!({"email":"people-second@example.test","password":"temporary-people-password-177-not-a-real-secret"}))
        .send()
        .unwrap();
    assert_eq!(signed.status(), 200, "second account sign-in");
    let cookie2 = signed.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let person_id = created.1["person"]["id"].as_str().unwrap().to_owned();
    let safe = json!({"error":"Internal Server Error"});
    let (status, theirs) = call(Method::GET, "/people", Some(&cookie2), None);
    assert_eq!(status, 200, "{theirs}");
    assert!(
        theirs["people"].as_array().is_some_and(|p| p.is_empty()),
        "second account must see none of the owner's people: {theirs}"
    );
    // The second account has its own notes folder before it tries the owner's person,
    // so the edit reaches the canonical-note path and not the projection-only fallback.
    let saved2 = call(
        Method::PUT,
        "/people/notes-settings",
        Some(&cookie2),
        Some(json!({"folder": root.join("notes").join(second.to_string())})),
    );
    assert_eq!(saved2.0, 200, "second account folder: {}", saved2.1);
    let note_path = folder.join(created.1["notePath"].as_str().unwrap());
    let note_before = fs::read(&note_path).unwrap();
    let (status, direct) = call(
        Method::GET,
        &format!("/people/{person_id}"),
        Some(&cookie2),
        None,
    );
    assert_eq!((status, &direct), (500, &safe), "direct read refused");
    let (status, patched) = call(
        Method::PATCH,
        &format!("/people/{person_id}"),
        Some(&cookie2),
        Some(json!({"displayName":"Hijacked"})),
    );
    assert_eq!((status, &patched), (500, &safe), "edit refused");
    assert_eq!(
        fs::read(&note_path).unwrap(),
        note_before,
        "the owner's note file must be unchanged"
    );
    let (status, after) = call(Method::GET, "/people", Some(&cookie), None);
    assert_eq!(status, 200, "{after}");
    assert!(
        after.to_string().contains("Ada Lovelace") && !after.to_string().contains("Hijacked"),
        "{after}"
    );
    let mine2 = call(
        Method::POST,
        "/people",
        Some(&cookie2),
        Some(json!({"displayName":"Grace Hopper"})),
    );
    assert_eq!(mine2.0, 200, "second account create: {}", mine2.1);
    let second_person = mine2.1["person"]["id"].as_str().unwrap().to_owned();
    let (status, owner_list) = call(Method::GET, "/people", Some(&cookie), None);
    assert_eq!(status, 200, "{owner_list}");
    assert!(
        owner_list["people"]
            .as_array()
            .is_some_and(|p| !p.is_empty())
            && !owner_list.to_string().contains(&second_person),
        "owner must not see the second account's person: {owner_list}"
    );
    println!("PASS privacy: second signed-in account sees none of the owner's people, cannot read or edit one by id, and its own person stays hidden from the owner");
    println!("NOT PROVEN: native UI, second physical device, note-folder indexing");
}
