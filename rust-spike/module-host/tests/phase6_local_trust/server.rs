use super::{bytes, setup};
use access_context::AccessContext;
use base64::{engine::general_purpose::STANDARD, Engine};
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
fn private(path: &Path, value: Value) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}
#[test]
#[ignore = "Requires test:rust-phase6-local-trust through verify-gate"]
fn authenticated_commands_record_local_trust() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let (_dir, paths) = setup();
    let root = _dir.path();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            conn.await.unwrap();
        });
        db
    });
    assert!(
        rt.block_on(db.query_one(
            "SELECT to_regclass('moss_modules.local_packages') IS NULL",
            &[]
        ))
        .unwrap()
        .get::<_, bool>(0),
        "start without the local catalog so the real host must bootstrap it"
    );
    let output = Command::new("devports")
        .args(["claim", &format!("js408-{}", std::process::id())])
        .output()
        .unwrap();
    assert!(output.status.success());
    let port = Port(String::from_utf8(output.stdout).unwrap().trim().into());
    let origin = format!("https://localhost:{}", port.0);
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .arg("local-certificate")
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
        "<!doctype html><title>Local trust proof</title>",
    )
    .unwrap();
    // All fixture secrets are generated for this disposable run.
    let connector_key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    private(
        &root.join("credentials.json"),
        json!({"app_url":std::env::var("JS43_APP_URL").unwrap(),"auth_url":std::env::var("JS170_AUTH_URL").unwrap(),"auth_secret":uuid::Uuid::new_v4().to_string(),"connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":root.join("tls/certificate.pem"),"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let supervisor = root.join("supervisor.py");
    fs::write(&supervisor, "#!/usr/bin/env python3\nimport os,json\nprint(json.dumps({'install_url':os.environ['JS43_BOOTSTRAP_URL']}))\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&supervisor, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let _server = Server(
        Command::new(std::env::var("JS170_SERVER").unwrap())
            .arg("serve")
            .arg("--instance")
            .arg(root)
            .arg("--web")
            .arg(root.join("web"))
            .env("MOSS_DB_PROGRAM", &supervisor)
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_DATA_HOME", root.join("data"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("server.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .add_root_certificate(
            reqwest::Certificate::from_pem(&fs::read(root.join("tls/certificate.pem")).unwrap())
                .unwrap(),
        )
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    while !client
        .get(format!("{origin}/api/hello"))
        .send()
        .is_ok_and(|r| r.status().is_success())
    {
        assert!(Instant::now() < deadline, "server startup deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
    let password = uuid::Uuid::new_v4().to_string();
    let signup = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":"Local builder","email":"local-builder@example.test","password":password})).send().unwrap();
    assert_eq!(signup.status(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let actor: uuid::Uuid = rt
        .block_on(db.query_one(
            "SELECT id FROM app.users WHERE email='local-builder@example.test'",
            &[],
        ))
        .unwrap()
        .get(0);
    // Make the builder a regular account: local signing must not require admin power.
    rt.block_on(db.execute(
        "UPDATE app.users SET is_instance_admin=false WHERE id=$1",
        &[&actor],
    ))
    .unwrap();
    let access = AccessContext::new(actor, "real-session-proof");
    let original = bytes(&access);
    let mut unpacked = moss_module_host::archive::Package::read_for_review(
        &original,
        &moss_module_host::trust::digest(&original),
    )
    .unwrap();
    // Exercise a real package above the server's ordinary two-megabyte JSON limit.
    use ring::rand::SecureRandom;
    let mut notice = vec![0; 2 * 1024 * 1024];
    ring::rand::SystemRandom::new().fill(&mut notice).unwrap();
    unpacked.files.insert("NOTICE".into(), notice);
    let package = moss_module_host::archive::pack(&unpacked.files).unwrap();
    let package_path = root.join("local.mosspkg");
    fs::write(&package_path, &package).unwrap();
    let post = |body: Value, authenticated: bool| {
        let mut request = client
            .post(format!("{origin}/api/modules/local/sign"))
            .header("origin", &origin)
            .json(&body);
        if authenticated {
            request = request.header("cookie", &cookie);
        }
        request.send().unwrap()
    };
    assert_eq!(
        post(json!({"package":STANDARD.encode(&original)}), false).status(),
        401
    );
    assert_eq!(
        post(
            json!({"package":STANDARD.encode(&package),"ownerAccountId":uuid::Uuid::new_v4()}),
            true
        )
        .status(),
        422
    );
    let accepted = post(json!({"package": STANDARD.encode(&package)}), true);
    let status = accepted.status();
    assert_eq!(status, 200, "local signing: {}", accepted.text().unwrap());
    let out = root.join("signature.json");
    let result = Command::new(std::env::var("JS408_MOSS").unwrap())
        .args(["local", "sign", &origin])
        .arg(&package_path)
        .arg(&out)
        .env("MOSS_LOCAL_SESSION", &cookie)
        .env("MOSS_LOCAL_CA", root.join("tls/certificate.pem"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let reply: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(reply["record"]["ownerAccountId"], actor.to_string());
    assert_eq!(reply["record"]["provenance"], "local");
    assert_eq!(reply["record"]["registryReviewed"], false);
    assert!(!String::from_utf8(result.stdout).unwrap().contains("pkcs8"));
    let verify = Command::new(std::env::var("JS408_MOSS").unwrap())
        .args(["local", "verify", &origin])
        .arg(&package_path)
        .arg(&out)
        .arg(root.join("verified.json"))
        .env("MOSS_LOCAL_SESSION", &cookie)
        .env("MOSS_LOCAL_CA", root.join("tls/certificate.pem"))
        .output()
        .unwrap();
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
    let row = rt.block_on(db.query_one("SELECT owner_account_id,digest,provenance,registry_reviewed FROM moss_modules.local_packages", &[])).unwrap();
    assert_eq!(row.get::<_, uuid::Uuid>(0), actor);
    assert_eq!(
        row.get::<_, String>(1),
        moss_module_host::trust::digest(&package)
    );
    assert_eq!(row.get::<_, String>(2), "local");
    assert!(!row.get::<_, bool>(3));
    let state: Value = rt
        .block_on(db.query_one("SELECT count(*) FROM moss_modules.catalog", &[]))
        .unwrap()
        .get::<_, i64>(0)
        .into();
    assert_eq!(state, json!(0), "trust records do not activate packages");
    // A newly generated key after loss must not replace the catalog's pinned key.
    fs::remove_file(paths.bundle.with_file_name("install-local-key.json")).unwrap();
    assert_eq!(
        post(json!({"package":STANDARD.encode(&package)}), true).status(),
        422
    );
    println!("Real HTTPS session + CLI: non-admin sign/verify accepted; anonymous, payload owner and replacement key refused; local provenance persisted; no activation");
}
