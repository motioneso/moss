//! Native gate fixture creator. No app process or login entry is involved.
use moss_network::config::{private_write, Config};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
use std::process::Stdio;
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let install = PathBuf::from(&args[0]);
    let folder = PathBuf::from(&args[1]);
    let port: u16 = args[2].to_str().unwrap().parse().unwrap();
    assert!(!folder.exists());
    std::fs::create_dir_all(&folder).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(windows)]
    {
        let who = Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .unwrap();
        let text = String::from_utf8(who.stdout).unwrap();
        let sid = text.trim().rsplit(',').next().unwrap().trim_matches('"');
        assert!(Command::new("icacls")
            .arg(&folder)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("*{sid}:(OI)(CI)F"),
                "/grant:r",
                "SYSTEM:(OI)(CI)F"
            ])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    let origins = vec![
        format!("https://127.0.0.1:{port}"),
        format!("https://localhost:{port}"),
    ];
    moss_network::tls::local_certificate_with_command(
        &folder.join("tls"),
        &origins,
        moss_launcher::runtime::command(&install, "openssl"),
    )
    .unwrap();
    moss_launcher::database::ensure_database(&install, &folder, true).unwrap();
    let output = moss_launcher::runtime::command(&install, "moss-db")
        .args(["credentials", "--root"])
        .arg(folder.join("database"))
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    // Supervisor output contains private credentials. Keep them in the private fixture only.
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let credentials = serde_json::json!({"app_url":value["app_url"], "auth_url":value["auth_url"], "auth_secret":value["auth_secret"], "connector_key":value["connector_key"]});
    private_write(
        &folder.join("credentials.json"),
        &serde_json::to_vec(&credentials).unwrap(),
    )
    .unwrap();
    Config {
        listen: ([127, 0, 0, 1], port).into(),
        origins,
        sharing: false,
        certificate: folder.join("tls/certificate.pem"),
        private_key: folder.join("tls/key.pem"),
        credentials: folder.join("credentials.json"),
    }
    .write(&folder.join("network.json"))
    .unwrap();
    moss_launcher::database::stop_database(&install, &folder).unwrap();
    println!("Created private native service fixture");
}
