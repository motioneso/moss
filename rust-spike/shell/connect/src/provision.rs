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
use std::process::Stdio;

pub const DATABASE_FOLDER: &str = "database";
/// The server's module settings, written at setup. The module installer completes it.
pub const MODULES_FILE: &str = "modules.json";
const FIRST_PORT: u16 = 7420;

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
    if !cfg!(any(unix, windows)) {
        return Err(Failure::Unsupported);
    }
    if !program(install).is_file() || !install.join("postgres").is_dir() {
        return Err(Failure::NoDatabaseProgram);
    }
    let folder = store.instance_folder(name);
    private_dir(&store.data).map_err(|e| {
        eprintln!("moss-app setup: data folder: {e}");
        Failure::Other
    })?;
    private_dir(&store.servers_dir()).map_err(|e| {
        eprintln!("moss-app setup: servers folder: {e}");
        Failure::Other
    })?;
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
    let file = options.open(servers.join("setup.lock")).map_err(|e| {
        eprintln!("moss-app setup: lock file: {e}");
        Failure::Other
    })?;
    portability::file_lock::exclusive(&file).map_err(|e| {
        eprintln!("moss-app setup: lock: {e}");
        Failure::Other
    })?;
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
        _ => {
            eprintln!("moss-app setup: instance folder: {e}");
            Failure::Other
        }
    })?;
    owner_only_acl(path)
}

/// Windows folders inherit their parent's access list. Drop the inherited entries and leave only
/// the signed-in user and SYSTEM, so the secrets written below are private. Setup stops if this
/// fails.
#[cfg(windows)]
fn owner_only_acl(path: &Path) -> Result<(), Failure> {
    // The environment can name a different account than the one running, so ask Windows.
    let who = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| Failure::Other)?;
    let text = String::from_utf8_lossy(&who.stdout);
    let sid = text
        .trim()
        .rsplit(',')
        .next()
        .map(|s| s.trim_matches('"').to_string())
        .filter(|s| s.starts_with("S-1-"))
        .ok_or(Failure::Other)?;
    let user = format!("*{sid}");
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:(OI)(CI)F"))
        .arg("/grant:r")
        .arg("SYSTEM:(OI)(CI)F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        _ => {
            eprintln!("moss-app setup: could not restrict the instance folder to its owner");
            Err(Failure::Other)
        }
    }
}

#[cfg(not(windows))]
fn owner_only_acl(_path: &Path) -> Result<(), Failure> {
    Ok(())
}

fn prepare(store: &Store, install: &Path, folder: &Path) -> Result<(), Failure> {
    // Keep the listener alive until network.json commits the port to this instance.
    let (port, _reservation) = free_port(store).ok_or_else(|| {
        eprintln!("moss-app setup: no free port");
        Failure::Other
    })?;
    let origins = vec![
        format!("https://localhost:{port}"),
        format!("https://127.0.0.1:{port}"),
    ];
    let tls = folder.join("tls");
    local_certificate_with_command(&tls, &origins, crate::launch::command(install, "openssl"))
        .map_err(|e| {
            eprintln!("moss-app setup: certificate: {e}");
            if e.contains("OpenSSL") {
                Failure::NeedsOpenssl
            } else {
                Failure::Other
            }
        })?;
    ensure_database(install, folder, true)?;
    let (credentials, modules) = run_credentials(install, folder)?;
    let credentials_path = folder.join("credentials.json");
    private_write(&credentials_path, credentials.as_bytes()).map_err(|e| {
        eprintln!("moss-app setup: credentials file: {e}");
        Failure::Other
    })?;
    private_write(&folder.join(MODULES_FILE), modules.as_bytes()).map_err(|e| {
        eprintln!("moss-app setup: modules file: {e}");
        Failure::Other
    })?;
    Config {
        listen: std::net::SocketAddr::from(([0, 0, 0, 0], port)),
        origins,
        sharing: false,
        certificate: tls.join("certificate.pem"),
        private_key: tls.join("key.pem"),
        credentials: credentials_path,
    }
    .write(&folder.join(NETWORK_FILE))
    .map_err(|e| {
        eprintln!("moss-app setup: network file: {e}");
        Failure::Other
    })
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

#[cfg(test)]
use moss_launcher::database::supervisor_running;

pub fn ensure_database(install: &Path, folder: &Path, create: bool) -> Result<(), Failure> {
    moss_launcher::database::ensure_database(install, folder, create)
        .map_err(|_| Failure::DatabaseFailed)
}

/// The server's credentials file text and the module settings text, both from one call.
fn run_credentials(install: &Path, folder: &Path) -> Result<(String, String), Failure> {
    let output = crate::launch::command(install, "moss-db")
        .args(["credentials", "--module-host", "--root"])
        .arg(folder.join(DATABASE_FOLDER))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| Failure::DatabaseFailed)?;
    let text = String::from_utf8(output.stdout).map_err(|_| Failure::DatabaseFailed)?;
    let value: Value = serde_json::from_str(&text).map_err(|_| Failure::DatabaseFailed)?;
    let field = |key: &str| {
        value[key]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    // Every field or nothing; the texts go to owner-only files and are never logged.
    let (Some(app_url), Some(auth_url), Some(auth_secret), Some(connector_key)) = (
        field("app_url"),
        field("auth_url"),
        field("auth_secret"),
        field("connector_key"),
    ) else {
        return Err(Failure::DatabaseFailed);
    };
    let (Some(migrations_url), Some(worker_url)) = (field("migrations_url"), field("worker_url"))
    else {
        return Err(Failure::DatabaseFailed);
    };
    if !output.status.success() {
        return Err(Failure::DatabaseFailed);
    }
    let credentials = serde_json::json!({
        "app_url": app_url,
        "auth_url": auth_url,
        "auth_secret": auth_secret,
        "connector_key": connector_key,
    });
    // No admin account exists yet. The installer records it when the first module goes in.
    let modules = serde_json::json!({
        "data": folder.join("modules"),
        "migrations_url": migrations_url,
        "producer_url": app_url,
        "worker_url": worker_url,
        "connector_key": connector_key,
        "notes_base": folder.join("notes"),
        "ai_key": field("ai_key"),
    });
    Ok((credentials.to_string(), modules.to_string()))
}

pub use moss_launcher::database::stop_database;

#[cfg(test)]
mod tests;
