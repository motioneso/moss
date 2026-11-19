//! Fresh supported Rust install, not a schema assembled by a fixture or Node migrations.
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Supervisor {
    child: Child,
    binary: String,
    root: std::path::PathBuf,
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = Command::new(&self.binary)
            .args(["stop", "--root"])
            .arg(&self.root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.wait();
    }
}

fn start(binary: &str, bundle: &str, repo: &Path, root: &Path, log: &Path) -> Supervisor {
    let child = Command::new(binary)
        .args(["up", "--root"])
        .arg(root)
        .args(["--pg", bundle, "--repo"])
        .arg(repo)
        .stdin(Stdio::null())
        .stdout(fs::File::create(log).unwrap())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut supervisor = Supervisor {
        child,
        binary: binary.into(),
        root: root.into(),
    };
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let output = fs::read_to_string(log).unwrap();
        if output
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .any(|v| v["event"] == "ready")
        {
            break;
        }
        assert!(
            supervisor.child.try_wait().unwrap().is_none(),
            "moss-db exited before ready: {output}; initdb: {}",
            fs::read_to_string(root.join("logs/initdb.log")).unwrap_or_default()
        );
        assert!(
            Instant::now() < deadline,
            "moss-db ready deadline: {output}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    supervisor
}

#[test]
#[ignore = "Needs MOSS_DB_PROGRAM and MOSS_COMPANION_PG; run through verify-gate"]
fn fresh_moss_db_up_has_four_core_tables_and_upgrade_keeps_the_same_tables() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let binary = std::env::var("MOSS_DB_PROGRAM").unwrap();
    let bundle = std::env::var("MOSS_COMPANION_PG").unwrap();
    let repo = std::env::var_os("MOSS_COMPANION_REPO")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("install");
    let log = scratch.path().join("supervisor.jsonl");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let check = || {
        // Generated throwaway credentials go directly to the client and are never logged.
        let output = Command::new(&binary)
            .args(["credentials", "--module-install", "--root"])
            .arg(&root)
            .output()
            .unwrap();
        assert!(output.status.success());
        let credentials: Value = serde_json::from_slice(&output.stdout).unwrap();
        rt.block_on(async {
            let (db, connection) = tokio_postgres::connect(credentials["install_url"].as_str().unwrap(), tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            let mut oids = Vec::new();
            for table in ["companion_devices", "companion_pair_attempts", "companion_recording_capabilities", "companion_recording_attempts"] {
                let rows = db.query("SELECT oid::bigint FROM pg_class WHERE relnamespace='app'::regnamespace AND relname=$1 AND relkind='r'", &[&table]).await.unwrap();
                assert_eq!(rows.len(), 1, "one core table: {table}");
                oids.push(rows[0].get::<_,i64>(0));
            }
            let count: i64 = db.query_one("SELECT count(*) FROM app.schema_migrations WHERE version IN ('0238','0239','0287','0330')", &[]).await.unwrap().get(0);
            assert_eq!(count, 4, "all four core ledger entries");
            oids
        })
    };
    let supervisor = start(&binary, &bundle, &repo, &root, &log);
    let before = check();
    drop(supervisor);
    let _supervisor = start(&binary, &bundle, &repo, &root, &log);
    assert_eq!(
        before,
        check(),
        "repeat up skips the applied files and preserves every table identity"
    );
    println!("fresh moss-db up: four core tables, four ledger entries; repeated up: same four table identities");
}
