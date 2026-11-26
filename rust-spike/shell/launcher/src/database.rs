//! Database lifecycle shared by first-run setup and the login service.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
pub const DATABASE_FOLDER: &str = "database";
const READY_TIMEOUT: Duration = Duration::from_secs(180);
#[derive(Debug)]
pub enum Failure {
    Other,
    NoDatabaseProgram,
    DatabaseFailed,
}
/// Database supervisors this app started, kept so they are reaped when they exit.
static STARTED: std::sync::Mutex<Vec<Child>> = std::sync::Mutex::new(Vec::new());

/// The private Windows database boundary accepts ordinary drive paths, never device
/// namespaces. The service canonicalizes its instance folder (adding `\\?\` on Windows),
/// so remove only that canonical drive prefix before handing the path to moss-db. Its
/// strict ancestor, reparse and private-object checks still run on the ordinary path.
fn database_root(folder: &Path) -> PathBuf {
    let root = folder.join(DATABASE_FOLDER);
    #[cfg(windows)]
    if matches!(
        root.components().next(),
        Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
    ) {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let ordinary: Vec<u16> = root.as_os_str().encode_wide().skip(4).collect();
        return PathBuf::from(std::ffi::OsString::from_wide(&ordinary));
    }
    root
}

pub fn supervisor_running(install: &Path, root: &Path) -> bool {
    crate::runtime::command(install, "moss-db")
        .args(["status", "--root"])
        .arg(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .is_some_and(|v| v["supervisor_pid"].is_u64())
}

/// Makes sure the instance's private database is up and migrated. Does nothing for an instance
/// without a database folder, unless `create` says this is the first start.
pub fn ensure_database(install: &Path, folder: &Path, create: bool) -> Result<(), Failure> {
    let root = database_root(folder);
    if !create && !root.is_dir() {
        return Ok(());
    }
    if root.is_dir() && supervisor_running(install, &root) {
        return Ok(());
    }
    let log_path = folder.join("database.log");
    let log = {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&log_path).map_err(|_| Failure::Other)?
    };
    let mut command = crate::runtime::command(install, "moss-db");
    command
        .args(["up", "--root"])
        .arg(&root)
        .arg("--pg")
        .arg(install.join("postgres"))
        .arg("--repo")
        .arg(install.join("schema"));
    // Windows has no database socket, so the port is part of every saved database address.
    // It is chosen once and reused, so a restart finds the same address.
    #[cfg(windows)]
    {
        let port = database_port(folder).ok_or(Failure::Other)?;
        command.arg("--port-range").arg(format!("{port}-{port}"));
    }
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|_| Failure::Other)?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detached, its own group, and no console window, so it outlives the app quietly.
        command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    let child = command.spawn().map_err(|_| Failure::NoDatabaseProgram)?;
    let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    started.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
    started.push(child);
    let last = started.len() - 1;
    let clock = Instant::now();
    loop {
        match read_event(&log_path).as_deref() {
            Some("ready") => return Ok(()),
            Some("error") => return Err(Failure::DatabaseFailed),
            _ => {}
        }
        if matches!(started[last].try_wait(), Ok(Some(_)))
            && read_event(&log_path).as_deref() != Some("ready")
        {
            return Err(Failure::DatabaseFailed);
        }
        if clock.elapsed() > READY_TIMEOUT {
            return Err(Failure::DatabaseFailed);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The instance's fixed database port: read from its folder, or chosen free and saved there.
#[cfg(windows)]
fn database_port(folder: &Path) -> Option<u16> {
    let file = folder.join("database.port");
    if let Some(port) = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| t.trim().parse::<u16>().ok())
    {
        return Some(port);
    }
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()?
        .port();
    std::fs::write(&file, port.to_string()).ok()?;
    Some(port)
}

/// The most decisive event in the supervisor's log: "ready" or "error", else the last one.
fn read_event(log: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    let mut last = None;
    for line in text.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(event) = value["event"].as_str() {
                if event == "ready" || event == "error" {
                    return Some(event.to_owned());
                }
                last = Some(event.to_owned());
            }
        }
    }
    last
}

/// Asks the instance's database supervisor to stop and waits for it. Quietly does nothing when
/// the instance has no database folder or it is not running.
pub fn stop_database(install: &Path, folder: &Path) -> Result<(), Failure> {
    let root = database_root(folder);
    if !root.is_dir()
        || !install
            .join(format!("moss-db{}", std::env::consts::EXE_SUFFIX))
            .is_file()
    {
        return Ok(());
    }
    let status = crate::runtime::command(install, "moss-db")
        .args(["stop", "--root"])
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| Failure::DatabaseFailed)?;
    status
        .success()
        .then_some(())
        .ok_or(Failure::DatabaseFailed)
}

#[cfg(all(test, windows))]
mod path_tests {
    use super::*;

    #[test]
    fn canonical_drive_folder_uses_the_database_boundarys_ordinary_namespace() {
        let plain = Path::new(r"C:\Moss data\instance");
        let canonical = Path::new(r"\\?\C:\Moss data\instance");
        assert_eq!(database_root(canonical), database_root(plain));
        // UNC/device namespaces stay rejected by the private database's own boundary.
        let unc = Path::new(r"\\?\UNC\host\share\instance");
        assert_eq!(database_root(unc), unc.join(DATABASE_FOLDER));
    }
}
