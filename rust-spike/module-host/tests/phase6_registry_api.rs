//! Real HTTPS server and signed registry fixtures for the Phase 6 management boundary.
mod common;
#[path = "phase6_lifecycle_api/fixtures.rs"]
mod fixtures;
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
#[ignore = "Only through verify-gate and the module bootstrap gate"]
fn phase6_registry_api() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js414-registry-{}", std::process::id())])
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
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>x</title>",
    )
    .unwrap();
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
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    // What the app writes at setup. There is no owner account and there are no module tables yet.
    private(
        &root.join("modules.json"),
        &json!({"data":root.join("modules"),"migrations_url":migration_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"notes_base":root.join("notes")}),
    );
    let registry = root.join("registry");
    let keys = common::Keys::new();
    let first = fixtures::publish(&keys, &registry, "1.0.0", 1);
    private(
        &root.join("registry.json"),
        &json!({"id":"sample-registry","folder":registry,"rootKey":common::Keys::public(&keys.root),"firstPartyKey":common::Keys::public(&keys.publisher)}),
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
        .arg(root.join("web"));
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
        .get(format!("{origin}/api/hello"))
        .send()
        .is_ok_and(|r| r.status().is_success())
    {
        assert!(Instant::now() < deadline, "server startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let signup = client
        .post(format!("{origin}/api/auth/sign-up/email"))
        .header("origin", &origin)
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
    use base64::{engine::general_purpose::STANDARD, Engine};
    use moss_module_host::{registry::Index, trust};
    for (method, path, body) in [
        (Method::GET, "/api/modules/registries", None),
        (Method::POST, "/api/modules/registries", Some(json!({}))),
        (Method::GET, "/api/modules/list/export", None),
        (
            Method::POST,
            "/api/modules/list/preview",
            Some(json!({"modules":[]})),
        ),
        (
            Method::POST,
            "/api/modules/list/import",
            Some(json!({"preview":"x","approve":true})),
        ),
    ] {
        assert_eq!(
            api(method, path, body, None).0,
            401,
            "session required: {path}"
        );
    }
    assert_eq!(
        api(Method::GET, "/api/modules/registries", None, Some(&cookie)).0,
        200,
        "registry management endpoint must exist"
    );
    // Reuse the existing credential hash to sign in a non-admin through real auth.
    let member_rt = tokio::runtime::Runtime::new().unwrap();
    let (member_db, member_connection) = member_rt
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    member_rt.spawn(async move {
        let _ = member_connection.await;
    });
    let member = uuid::Uuid::new_v4();
    member_rt.block_on(async {
        member_db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Registry member','registry-member@example.test',false,false,'active')", &[&member]).await.unwrap();
        member_db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'", &[&member]).await.unwrap();
    });
    let response = client.post(format!("{origin}/api/auth/sign-in/email")).header("origin", &origin).json(&json!({"email":"registry-member@example.test","password":"temporary-bootstrap-password-179-not-a-real-secret"})).send().unwrap();
    assert_eq!(response.status(), 200);
    let member_cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(
        api(
            Method::GET,
            "/api/modules/registries",
            None,
            Some(&member_cookie)
        )
        .0,
        403,
        "registry configuration is admin-only"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/list/preview",
            Some(json!({"modules":[]})),
            Some(&member_cookie)
        )
        .0,
        403
    );
    let root_key = common::Keys::public(&keys.root);
    let publisher = common::Keys::public(&keys.publisher);
    let fingerprint = trust::digest(&STANDARD.decode(&root_key).unwrap());
    let uploaded = |id: &str, corrupt: &str| {
        let mut identity: Value =
            serde_json::from_slice(&fs::read(registry.join("registry.json")).unwrap()).unwrap();
        identity["id"] = json!(id);
        identity["name"] = json!(fingerprint); // An untrusted label must never confirm a root.
        if corrupt == "publisher" {
            identity["publishers"]["sample"]["prefix"] = json!("foreign");
        }
        let identity = serde_json::to_vec(&identity).unwrap();
        let index: Index =
            serde_json::from_slice(&fs::read(registry.join("index.json")).unwrap()).unwrap();
        let index = serde_json::to_vec(&index).unwrap();
        let signature = if corrupt == "signature" {
            common::Keys::sign(&keys.publisher, &index)
        } else {
            common::Keys::sign(&keys.index, &index)
        };
        let mut files = serde_json::Map::new();
        for (name, bytes) in [
            ("registry.json".to_string(), identity.clone()),
            (
                "registry.json.sig".into(),
                common::Keys::sign(&keys.root, &identity).into_bytes(),
            ),
            ("index.json".into(), index),
            ("index.json.sig".into(), signature.into_bytes()),
            (
                format!("packages/{}.mosspkg", first.digest),
                fs::read(registry.join(format!("packages/{}.mosspkg", first.digest))).unwrap(),
            ),
        ] {
            files.insert(name, json!(STANDARD.encode(bytes)));
        }
        json!({"id":id,"rootKey":root_key,"firstPartyKey":publisher,"files":files})
    };
    for fault in ["signature", "publisher"] {
        if std::env::var("JS414_FAULT").is_ok_and(|only| only != fault) {
            continue;
        }
        assert_eq!(
            api(
                Method::POST,
                "/api/modules/registries/import",
                Some(uploaded(&format!("bad-{fault}"), fault)),
                Some(&cookie)
            )
            .0,
            422,
            "reject {fault}"
        );
    }
    if std::env::var("JS414_FAULT").is_ok() {
        return;
    }
    let (status, pending) = api(
        Method::POST,
        "/api/modules/registries/import",
        Some(uploaded("second-registry", "")),
        Some(&cookie),
    );
    assert_eq!(status, 200, "{pending}");
    assert_eq!(pending["confirmed"], false);
    assert_eq!(pending["fingerprint"], fingerprint);
    let pick = json!({"module":"sample.counter","source":"second-registry"});
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/review",
            Some(pick.clone()),
            Some(&cookie)
        )
        .0,
        400,
        "pending source cannot install"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/registries/second-registry/confirm",
            Some(json!({"fingerprint":"wrong"})),
            Some(&cookie)
        )
        .0,
        422,
        "confirm actual fingerprint"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/registries/second-registry/confirm",
            Some(json!({"fingerprint":fingerprint})),
            Some(&cookie)
        )
        .0,
        200
    );
    let (status, catalog) = api(Method::GET, "/api/modules/catalog", None, Some(&cookie));
    assert_eq!(status, 200, "{catalog}");
    let modules = catalog["modules"].as_array().unwrap();
    assert_eq!(modules.len(), 2, "same module remains two source entries");
    assert_ne!(modules[0]["source"], modules[1]["source"]);
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/list/import",
            Some(json!({"modules":[],"approve":true})),
            Some(&cookie)
        )
        .0,
        422,
        "preview required"
    );
    let list =
        json!({"modules":[{"id":"sample.counter","registry":"sample-registry","version":"1.0.0"}]});
    let (status, preview) = api(
        Method::POST,
        "/api/modules/list/preview",
        Some(list),
        Some(&cookie),
    );
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["operations"].as_array().unwrap().len(), 1);
    assert_eq!(
        api(Method::GET, "/api/modules/list/export", None, Some(&cookie)).1["modules"],
        json!([]),
        "preview installs nothing"
    );
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/list/import",
            Some(json!({"preview":preview["preview"],"approve":false})),
            Some(&cookie)
        )
        .0,
        400
    );
    let decision = json!({"preview":preview["preview"],"approve":true});
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/list/import",
            Some(decision),
            Some(&cookie)
        )
        .0,
        202
    );
    let operation = preview["operations"][0]["id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let (_, result) = api(
            Method::GET,
            &format!("/api/modules/operations/{operation}"),
            None,
            Some(&cookie),
        );
        if result["stage"] == "succeeded" {
            break;
        }
        assert_ne!(result["stage"], "failed", "{result}");
        assert!(Instant::now() < deadline, "operation deadline {result}");
        std::thread::sleep(Duration::from_millis(100));
    }
    let health = || {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let (status, value) = api(
                Method::GET,
                "/api/m/sample.counter/health",
                None,
                Some(&cookie),
            );
            if status == 200 {
                assert_eq!(value["live"], true);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "installed module must serve: {status} {value}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    health();
    let before = api(Method::GET, "/api/modules/list/export", None, Some(&cookie)).1;
    assert_eq!(before["modules"][0]["version"], "1.0.0", "portable pin");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (db, connection) = rt
        .block_on(tokio_postgres::connect(
            &bootstrap_url,
            tokio_postgres::NoTls,
        ))
        .unwrap();
    rt.spawn(async move {
        let _ = connection.await;
    });
    let owner: uuid::Uuid = rt
        .block_on(db.query_one(
            "SELECT id FROM app.users WHERE email='bootstrap-owner@example.test'",
            &[],
        ))
        .unwrap()
        .get(0);
    let marker = "JS414 preserved private module row";
    rt.block_on(db.execute(
        "INSERT INTO app.sample_counter_entries(id,owner_user_id,title) VALUES($1,$2,$3)",
        &[&uuid::Uuid::new_v4(), &owner, &marker],
    ))
    .unwrap();
    let (status, empty) = api(
        Method::POST,
        "/api/modules/list/preview",
        Some(json!({"modules":[]})),
        Some(&cookie),
    );
    assert_eq!(status, 200, "{empty}");
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/list/import",
            Some(json!({"preview":empty["preview"],"approve":true})),
            Some(&cookie)
        )
        .0,
        202
    );
    assert_eq!(
        api(Method::GET, "/api/modules/list/export", None, Some(&cookie)).1,
        before,
        "omission preserves installed modules and pins"
    );
    let preserved: String = rt
        .block_on(db.query_one(
            "SELECT title FROM app.sample_counter_entries WHERE owner_user_id=$1",
            &[&owner],
        ))
        .unwrap()
        .get(0);
    assert_eq!(
        preserved, marker,
        "list omission preserves private module data"
    );
    health();
    let mut index: Index =
        serde_json::from_slice(&fs::read(registry.join("index.json")).unwrap()).unwrap();
    index.serial += 1;
    index.expires = chrono::Utc::now() - chrono::Duration::seconds(1);
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(registry.join("index.json"), &bytes).unwrap();
    fs::write(
        registry.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    assert_eq!(
        api(
            Method::POST,
            "/api/modules/review",
            Some(json!({"module":"sample.counter","source":"sample-registry"})),
            Some(&cookie)
        )
        .0,
        422,
        "expired index stops new installs"
    );
    assert_eq!(api(Method::POST,"/api/modules/install",Some(json!({"module":"sample.counter","source":"sample-registry","approve":true,"version":"1.0.0"})),Some(&cookie)).0,422,"expired index refuses actual installation");
    let (_, health_view) = api(Method::GET, "/api/modules/registries", None, Some(&cookie));
    assert_eq!(health_view["registries"][0]["health"], "expired");
    health();
    assert_eq!(
        api(
            Method::DELETE,
            "/api/modules/registries/sample-registry",
            None,
            Some(&cookie)
        )
        .0,
        200
    );
    assert_eq!(
        api(
            Method::DELETE,
            "/api/modules/registries/second-registry",
            None,
            Some(&cookie)
        )
        .0,
        200
    );
    assert_eq!(
        api(Method::GET, "/api/modules/list/export", None, Some(&cookie)).1,
        before,
        "export works with zero registries"
    );
    health();
    assert!(!health_view.to_string().contains("postgres://"));
    assert!(!health_view
        .to_string()
        .contains(&root.display().to_string()));
    println!("phase6_registry_api: confirmation, signature/publisher refusals, distinct sources, preview/add/pin/export, omission, expiry and running code verified");
}
