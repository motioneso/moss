//! Making a local server's instance folder, and keeping its private database up.
//!
//! An instance folder holds the server's configuration, certificate, credentials and, when the
//! app made it, a private database run by `moss-db` (rust-spike/bundled-db). The app reuses that
//! program and the network crate's certificate maker. It adds only the glue between them.
//!
//! Layout the installer must provide next to the app (Phase 7):
//!
//! ```text
//! <install>/moss-db       the database supervisor
//! <install>/postgres/     bin, lib and share of the bundled Postgres
//! <install>/schema/       the migrations the supervisor applies
//! ```
//!
//! An instance without a `database` folder is left alone, so a hand-prepared instance that points
//! at its own database still works.

use crate::store::{private_dir, valid_instance, Store};
use moss_network::config::{private_write, Config};
use moss_network::instance::NETWORK_FILE;
use moss_network::tls::local_certificate_with_command;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

pub const DATABASE_FOLDER: &str = "database";
const FIRST_PORT: u16 = 7420;
const READY_TIMEOUT: Duration = Duration::from_secs(180);

/// Why a setup step failed, in words a person can act on.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    BadName,
    Exists,
    NoDatabaseProgram,
    NeedsOpenssl,
    DatabaseFailed,
    Unsupported,
    Other,
}

impl Failure {
    pub fn reason(&self) -> &'static str {
        match self {
            Failure::BadName => "Use letters, numbers, dashes and underscores for the name.",
            Failure::Exists => "A server with that name already exists on this computer.",
            Failure::NoDatabaseProgram => {
                "This copy of Moss came without its database, so it cannot set up a server here."
            }
            Failure::NeedsOpenssl => {
                "Setting up a secure address needs the OpenSSL program, which was not found."
            }
            Failure::DatabaseFailed => {
                "The database did not start. Its log is in the server's folder."
            }
            Failure::Unsupported => {
                "Setting up a server on this computer is not available on this system yet."
            }
            Failure::Other => "Moss could not set up the server.",
        }
    }
}

fn program(install: &Path) -> PathBuf {
    install.join(if cfg!(windows) {
        "moss-db.exe"
    } else {
        "moss-db"
    })
}

/// Creates instance `name`, starts its database and writes everything the server needs. The
/// configuration file is written last, so a folder without it is an unfinished setup that this
/// function removes on failure.
pub fn create_instance(store: &Store, install: &Path, name: &str) -> Result<(), Failure> {
    if !valid_instance(name) {
        return Err(Failure::BadName);
    }
    if !cfg!(unix) {
        return Err(Failure::Unsupported);
    }
    if !program(install).is_file() || !install.join("postgres").is_dir() {
        return Err(Failure::NoDatabaseProgram);
    }
    let folder = store.instance_folder(name);
    private_dir(&store.data).map_err(|_| Failure::Other)?;
    private_dir(&store.servers_dir()).map_err(|_| Failure::Other)?;
    // Keep cleanup and setup exclusive across app processes, including different names.
    // Otherwise one setup can delete another's unfinished folder.
    let _setup = setup_lock(&store.servers_dir())?;
    // A folder with no network file is a setup that was interrupted. Clear it and start over.
    if folder.exists() {
        if folder.join(NETWORK_FILE).exists() {
            return Err(Failure::Exists);
        }
        stop_database(install, &folder).map_err(|_| Failure::DatabaseFailed)?;
        std::fs::remove_dir_all(&folder).map_err(|_| Failure::Other)?;
    }
    // An exclusive create, so two setups of one name cannot both proceed.
    make_private_folder(&folder)?;
    let made = prepare(store, install, &folder);
    if made.is_err() && stop_database(install, &folder).is_ok() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    made
}

fn setup_lock(servers: &Path) -> Result<std::fs::File, Failure> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(servers.join("setup.lock"))
        .map_err(|_| Failure::Other)?;
    portability::file_lock::exclusive(&file).map_err(|_| Failure::Other)?;
    Ok(file)
}

fn make_private_folder(path: &Path) -> Result<(), Failure> {
    #[allow(unused_mut)]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => Failure::Exists,
        _ => Failure::Other,
    })
}

fn prepare(store: &Store, install: &Path, folder: &Path) -> Result<(), Failure> {
    // Keep the listener alive until network.json commits the port to this instance.
    let (port, _reservation) = free_port(store).ok_or(Failure::Other)?;
    let origins = vec![
        format!("https://localhost:{port}"),
        format!("https://127.0.0.1:{port}"),
    ];
    let tls = folder.join("tls");
    local_certificate_with_command(&tls, &origins, crate::launch::command(install, "openssl"))
        .map_err(|e| {
            if e.contains("OpenSSL") {
                Failure::NeedsOpenssl
            } else {
                Failure::Other
            }
        })?;
    ensure_database(install, folder, true)?;
    let credentials = run_credentials(install, folder)?;
    let credentials_path = folder.join("credentials.json");
    private_write(&credentials_path, credentials.as_bytes()).map_err(|_| Failure::Other)?;
    Config {
        listen: std::net::SocketAddr::from(([0, 0, 0, 0], port)),
        origins,
        sharing: false,
        certificate: tls.join("certificate.pem"),
        private_key: tls.join("key.pem"),
        credentials: credentials_path,
    }
    .write(&folder.join(NETWORK_FILE))
    .map_err(|_| Failure::Other)
}

/// The first port at or above `FIRST_PORT` that no instance uses and nothing is listening on.
fn free_port(store: &Store) -> Option<(u16, std::net::TcpListener)> {
    let taken: Vec<u16> = std::fs::read_dir(store.servers_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| Config::read(&e.path().join(NETWORK_FILE)).ok())
        .map(|c| c.listen.port())
        .collect();
    (FIRST_PORT..FIRST_PORT + 400)
        .filter(|port| !taken.contains(port))
        .find_map(|port| {
            std::net::TcpListener::bind(("0.0.0.0", port))
                .ok()
                .map(|listener| (port, listener))
        })
}

/// Database supervisors this app started, kept so they are reaped when they exit.
static STARTED: std::sync::Mutex<Vec<Child>> = std::sync::Mutex::new(Vec::new());

fn supervisor_running(install: &Path, root: &Path) -> bool {
    crate::launch::command(install, "moss-db")
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
    let root = folder.join(DATABASE_FOLDER);
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
    let mut command = crate::launch::command(install, "moss-db");
    command
        .args(["up", "--root"])
        .arg(&root)
        .arg("--pg")
        .arg(install.join("postgres"))
        .arg("--repo")
        .arg(install.join("schema"))
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|_| Failure::Other)?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
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

fn run_credentials(install: &Path, folder: &Path) -> Result<String, Failure> {
    let output = crate::launch::command(install, "moss-db")
        .args(["credentials", "--root"])
        .arg(folder.join(DATABASE_FOLDER))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| Failure::DatabaseFailed)?;
    let text = String::from_utf8(output.stdout).map_err(|_| Failure::DatabaseFailed)?;
    // Four fields or nothing; the text is written to an owner-only file and never logged.
    let value: Value = serde_json::from_str(&text).map_err(|_| Failure::DatabaseFailed)?;
    let complete = ["app_url", "auth_url", "auth_secret", "connector_key"]
        .iter()
        .all(|key| value[key].as_str().is_some_and(|v| !v.is_empty()));
    if !output.status.success() || !complete {
        return Err(Failure::DatabaseFailed);
    }
    Ok(text)
}

/// Asks the instance's database supervisor to stop and waits for it. Quietly does nothing when
/// the instance has no database folder or it is not running.
pub fn stop_database(install: &Path, folder: &Path) -> Result<(), Failure> {
    let root = folder.join(DATABASE_FOLDER);
    if !root.is_dir() || !program(install).is_file() {
        return Ok(());
    }
    let status = crate::launch::command(install, "moss-db")
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

#[cfg(test)]
mod tests;
