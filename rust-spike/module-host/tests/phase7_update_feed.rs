//! Real Moss HTTPS server and account survive refused app updates.
#![cfg(unix)]
mod common;
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
fn phase7_update_feed_server_continuity() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js430-update-{}", std::process::id())])
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
    let feed = root.join("app-feed");
    fs::create_dir(&feed).unwrap();
    let keys = common::Keys::new();
    let public = feed.join("public-key.txt");
    fs::write(&public, common::Keys::public(&keys.index)).unwrap();
    let state = feed.join("seen.json");
    let payload = b"native-artifact";
    fs::write(feed.join("artifact"), payload).unwrap();
    let good = json!({
        "serial":10,"expires":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339(),
        "signingKey":"test-app", "artifacts":[{
            "os":std::env::consts::OS,"arch":std::env::consts::ARCH,"version":"1.0.0",
            "url":"https://github.com/motioneso/moss/releases/download/test/app",
            "digest":moss_module_host::trust::digest(payload),"size":payload.len(),
            "schemaMin":40,"schemaMax":43
        }]
    });
    let run = |index: &Value, unsigned: bool| {
        let bytes = serde_json::to_vec(index).unwrap();
        fs::write(feed.join("index.json"), &bytes).unwrap();
        fs::write(
            feed.join("index.json.sig"),
            if unsigned {
                String::new()
            } else {
                common::Keys::sign(&keys.index, &bytes)
            },
        )
        .unwrap();
        Command::new(std::env::var("JS430_UPDATE_CLIENT").unwrap())
            .arg("check")
            .arg(&feed)
            .arg("test-app")
            .arg(&public)
            .arg(&state)
            .arg("42")
            .arg(feed.join("artifact"))
            .output()
            .unwrap()
    };
    assert!(
        run(&good, false).status.success(),
        "valid feed must pass the actual CLI"
    );
    let saved = fs::read(&state).unwrap();
    for case in [
        "unsigned",
        "older-serial",
        "expired",
        "wrong-hash",
        "wrong-os",
        "wrong-arch",
        "wrong-schema",
    ] {
        let mut index = good.clone();
        index["serial"] = json!(11);
        match case {
            "older-serial" => index["serial"] = json!(9),
            "expired" => {
                index["expires"] =
                    json!((chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339())
            }
            "wrong-hash" => index["artifacts"][0]["digest"] = json!("0".repeat(64)),
            "wrong-os" => index["artifacts"][0]["os"] = json!("windows"),
            "wrong-arch" => index["artifacts"][0]["arch"] = json!("aarch64"),
            "wrong-schema" => index["artifacts"][0]["schemaMin"] = json!(43),
            "unsigned" => {}
            _ => unreachable!(),
        }
        let output = run(&index, case == "unsigned");
        assert!(!output.status.success(), "{case}: accepted invalid update");
        assert_eq!(
            fs::read(&state).unwrap(),
            saved,
            "{case}: changed trusted serial on refusal"
        );
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "{case}: stopped the old server"
        );
        let response = client
            .get(format!("{origin}/api/auth/get-session"))
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(response.status(), 200, "{case}: server unavailable");
        let session: Value = response.json().unwrap();
        assert_eq!(
            session["user"]["name"], "Bootstrap owner",
            "{case}: lost account data"
        );
        println!(
            "phase7_update_feed: {case} refused; same server process still serves saved account"
        );
    }
}
