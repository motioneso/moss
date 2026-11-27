//! Real HTTPS server and signed registry fixtures for the Phase 6 management boundary.
#[path = "common/mod.rs"]
mod common;
#[path = "phase6_catalog_screens/fixtures.rs"]
mod fixtures;
#[path = "phase6_install_screens/fixtures.rs"]
mod install_fixtures;
#[path = "phase6_lifecycle_screens/fixtures.rs"]
mod lifecycle_fixtures;
#[path = "phase6_trust_screens/fixtures.rs"]
mod trust_fixtures;
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
// Even a panicking browser fixture removes only its own token-marked rule, through
// the same cleanup command as instance uninstall. The temp directory outlives this guard.
struct SharingCleanup<'a>(&'a Path);
impl Drop for SharingCleanup<'_> {
    fn drop(&mut self) {
        let result = Command::new(std::env::var("JS170_SERVER").unwrap())
            .args(["firewall-close", "--instance"])
            .arg(self.0)
            .status();
        let removed = result.is_ok_and(|status| status.success());
        if std::thread::panicking() {
            if !removed {
                eprintln!("sharing fixture firewall cleanup failed");
            }
        } else {
            assert!(removed, "sharing fixture firewall cleanup");
        }
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
#[ignore = "Only through verify-gate and the module bootstrap gate"]
fn phase6_catalog_screens() {
    serve_catalog();
}

pub fn serve_catalog() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js418-catalog-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!port.0.is_empty());
    let host = std::env::var("CATALOG_LAN_HOST").unwrap_or_else(|_| "localhost".into());
    if host != "localhost" {
        let ip: std::net::Ipv4Addr = host.parse().expect("LAN IPv4 address");
        assert!(
            !ip.is_loopback() && !ip.is_unspecified(),
            "real LAN address required"
        );
    }
    let origin = format!("https://{host}:{}", port.0);
    let listen_host = if host == "localhost" {
        "127.0.0.1"
    } else {
        "0.0.0.0"
    };
    let local_origin = format!("https://localhost:{}", port.0);
    let mut origins = vec![origin.clone()];
    if host != "localhost" {
        origins.push(local_origin.clone());
    }
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .args(&origins)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let web = std::env::var("CATALOG_WEB").expect("real web build required");
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    // The stored login is the real migration owner. Only the install run gets the stronger one.
    let migration_url = std::env::var("JS43_MIGRATION_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-bootstrap-signing-secret-179","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("{listen_host}:{}",port.0),"origins":origins,"sharing":false,"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    // What the app writes at setup. There is no owner account and there are no module tables yet.
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("modules"),"migrations_url":migration_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
    );
    let registry = root.join("registry");
    let keys = common::Keys::new();
    let _first = fixtures::publish(&keys, &registry, true, None);
    let community = root.join("community");
    let other_keys = common::Keys::new();
    fixtures::publish(&other_keys, &community, false, None);
    private(
        &root.join("registry.json"),
        &json!({"registries":[{"id":"moss-fixture","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)},{"id":"community-fixture","folder":community,"rootKey":common::Keys::public(&other_keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}]}),
    );
    // Stands in for the database supervisor's credentials command.
    let supervisor = root.join("supervisor.sh");
    fs::write(
        &supervisor,
        format!(
            "#!/bin/sh\nwhile [ -e '{}' ]; do touch '{}'; sleep 0.1; done\necho '{}'\n",
            root.join("hold-installer").display(),
            root.join("installer-waiting").display(),
            json!({"install_url": bootstrap_url})
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&supervisor, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
    command
        .env("MOSS_DB_PROGRAM", &supervisor)
        .arg("serve")
        .arg("--instance")
        .arg(root)
        .arg("--web")
        .arg(&web);
    if std::env::var_os("TRUST_SCREENS").is_some() {
        trust_fixtures::key_storage(root);
        command
            .env("XDG_CONFIG_HOME", root.join("key-config"))
            .env("XDG_DATA_HOME", root.join("key-data"));
    }
    let _sharing_cleanup = (host != "localhost").then(|| SharingCleanup(root));
    let mut server = Server(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("server.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while !client
        .get(format!("{local_origin}/api/hello"))
        .send()
        .is_ok_and(|r| r.status().is_success())
    {
        assert!(Instant::now() < deadline, "server startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let signup = client
        .post(format!("{local_origin}/api/auth/sign-up/email"))
        .header("origin", &local_origin)
        .json(&json!({"name":"Bootstrap owner","email":"bootstrap-owner@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"}))
        .send()
        .unwrap();
    assert_eq!(signup.status(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    if host != "localhost" {
        // Raw sharing=true no longer authorizes LAN startup. Turn it on as the owner,
        // through the real listener/firewall control, after loopback-only setup.
        assert!(client.get(format!("{origin}/api/hello")).send().is_err());
        let response = client
            .put(format!("{local_origin}/api/network"))
            .header("origin", &local_origin)
            .header("cookie", &cookie)
            .json(&json!({"sharing":true}))
            .send()
            .unwrap();
        assert_eq!(response.status(), 200, "owner authorizes sharing");
        let state: Value = response.json().unwrap();
        assert_eq!(state["sharing"], true, "sharing is really on: {state}");
        assert_eq!(
            state["firewall"], "allowed",
            "live firewall marker: {state}"
        );
        assert!(client
            .get(format!("{origin}/api/hello"))
            .send()
            .unwrap()
            .status()
            .is_success());
    }
    use reqwest::Method;
    let api = |method: reqwest::Method, path: &str, body: Option<Value>, cookie: Option<&str>| {
        let mut request = client
            .request(method, format!("{origin}{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let Ok(response) = request.send() else {
            return (0, Value::Null);
        };
        (
            response.status().as_u16(),
            response.json::<Value>().unwrap_or(Value::Null),
        )
    };
    assert_eq!(
        api(Method::GET, "/api/modules/policy", None, Some(&cookie)).0,
        503,
        "module policy endpoint exists before modules are ready"
    );
    // A second account signs in through the same real authentication boundary.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (db, connection) = rt
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    rt.spawn(async move {
        let _ = connection.await;
    });
    let member = uuid::Uuid::new_v4();
    rt.block_on(async {
        db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Policy member','policy-member@example.test',false,false,'active')", &[&member]).await.unwrap();
        db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'", &[&member]).await.unwrap();
    });
    let login = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin).json(&json!({"email":"policy-member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(login.status(), 200);
    let _member_cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let review = api(
        Method::POST,
        "/api/modules/review",
        Some(json!({"module":"catalog-notes","source":"moss-fixture"})),
        Some(&cookie),
    );
    assert_eq!(review.0, 200, "{review:?}");
    let id = review.1["id"].as_str().unwrap();
    assert_eq!(
        api(
            Method::POST,
            &format!("/api/modules/operations/{id}/execute"),
            Some(json!({"approve":true})),
            Some(&cookie)
        )
        .0,
        202
    );
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let operation = api(
            Method::GET,
            &format!("/api/modules/operations/{id}"),
            None,
            Some(&cookie),
        )
        .1;
        if operation["stage"] == "succeeded" {
            break;
        }
        assert_ne!(operation["stage"], "failed", "{operation}");
        assert!(Instant::now() < deadline, "installation deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    // The installer journal can finish before the serving host's separate startup retry.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let policy = api(Method::GET, "/api/modules/policy", None, Some(&cookie));
        if policy.0 == 200 {
            break;
        }
        assert_eq!(policy.0, 503, "waiting for the module host: {policy:?}");
        assert!(Instant::now() < deadline, "module host startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    // Freeze automatic updates so the newer signed offer remains a visible update badge.
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/policy",
            Some(json!({"automatic":false,"quietTime":false})),
            Some(&cookie)
        )
        .0,
        200
    );
    let hold = std::path::PathBuf::from(std::env::var("CATALOG_HOLD").expect("browser handshake"));
    if std::env::var_os("TRUST_SCREENS").is_some() {
        trust_fixtures::serve(
            root,
            &registry,
            &keys,
            &other_keys,
            &hold,
            &origin,
            &db,
            &rt,
            member,
        );
        return;
    }
    if std::env::var_os("LIFECYCLE_SCREENS").is_some() {
        lifecycle_fixtures::serve(root, &registry, &keys, &hold, &origin, &db, &rt);
        return;
    }
    if std::env::var_os("INSTALL_SCREENS").is_some() {
        install_fixtures::serve(root, &registry, &keys, &hold, &origin, &db, &rt);
        return;
    }
    fs::create_dir_all(&hold).unwrap();
    fs::write(
        hold.join("ready.json"),
        json!({"origin":origin,"instance":root}).to_string(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(600);
    while !hold.join("media-ready").exists() {
        assert!(Instant::now() < deadline, "browser media deadline");
        std::thread::sleep(Duration::from_millis(150));
    }
    fixtures::publish(&keys, &registry, true, Some(&hold));
    fs::write(hold.join("published"), "ready").unwrap();
    while !hold.join("release").exists() {
        assert!(Instant::now() < deadline, "browser completion deadline");
        std::thread::sleep(Duration::from_millis(150));
    }
    assert!(server.0.try_wait().unwrap().is_none());
    println!("PASS phase6_catalog_screens: signed registry and real installed screens held for browser proof");
}
