//! Creating, starting, stopping and recovering the private cluster (Unix).

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::layout::{private_file, write_private, Layout};
use crate::secrets::{self, Secret};
use crate::{procs, SUPERUSER};

/// The Postgres build that ships with the app: `bin/`, `lib/` and `share/` side by side.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub root: PathBuf,
}

impl Bundle {
    pub fn new(root: &Path) -> Result<Bundle, String> {
        let root = root.canonicalize().map_err(|e| format!("Postgres bundle {}: {e}", root.display()))?;
        let bundle = Bundle { root };
        for tool in ["postgres", "initdb"] {
            if !bundle.bin(tool).is_file() {
                return Err(format!("Postgres bundle has no bin/{tool}"));
            }
        }
        Ok(bundle)
    }

    pub fn bin(&self, name: &str) -> PathBuf {
        self.root.join("bin").join(name)
    }
}

/// How clients reach the cluster.
#[derive(Debug, Clone)]
pub enum Listen {
    /// Only a Unix socket in the install's owner-only run folder. No TCP listener at all, so
    /// no port can clash and nothing else on the network can try to connect.
    SocketOnly,
    /// 127.0.0.1 on the first free port in the range, or on any free port when `None`.
    Loopback(Option<(u16, u16)>),
}

/// Where a running cluster accepts connections.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub socket_dir: Option<PathBuf>,
    pub port: u16,
}

impl Endpoint {
    pub fn connect(&self, role: &str, password: &Secret, database: &str) -> Result<postgres::Client, String> {
        let mut config = postgres::Config::new();
        config
            .user(role)
            .password(password.expose())
            .dbname(database)
            .application_name("moss-db")
            .connect_timeout(Duration::from_secs(10))
            .port(self.port);
        match &self.socket_dir {
            Some(dir) => config.host_path(dir),
            None => config.host("127.0.0.1"),
        };
        config.connect(postgres::NoTls).map_err(|e| format!("connect as {role}: {}", db_error(&e)))
    }

    pub fn to_json(&self) -> Value {
        json!({ "socket_dir": self.socket_dir, "port": self.port })
    }

    pub fn from_json(value: &Value) -> Option<Endpoint> {
        Some(Endpoint {
            socket_dir: value["socket_dir"].as_str().map(PathBuf::from),
            port: u16::try_from(value["port"].as_u64()?).ok()?,
        })
    }
}

/// The server's own words, without the connection details `postgres::Error` can carry.
pub fn db_error(error: &postgres::Error) -> String {
    match error.as_db_error() {
        Some(db) => format!("{}: {}", db.severity(), db.message()),
        None => error.to_string(),
    }
}

/// Proof that this process is the one supervisor for the install. Dropping it, or the
/// process dying in any way, releases it.
pub struct InstallLock {
    _file: File,
}

pub fn lock(layout: &Layout) -> Result<InstallLock, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&layout.lock)
        .map_err(|e| format!("lock file: {e}"))?;
    if !try_flock(&file, libc::LOCK_EX)? {
        let mut holder = String::new();
        let _ = file.read_to_string(&mut holder);
        return Err(format!(
            "another supervisor (pid {}) is already running this install",
            holder.trim()
        ));
    }
    file.set_len(0).and_then(|_| file.write_all(std::process::id().to_string().as_bytes())).map_err(|e| e.to_string())?;
    Ok(InstallLock { _file: file })
}

/// The pid of the supervisor running this install, if one is. Takes a shared lock for a
/// moment and writes nothing.
pub fn holder(layout: &Layout) -> Result<Option<i32>, String> {
    let file = match File::open(&layout.lock) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("lock file: {error}")),
    };
    if try_flock(&file, libc::LOCK_SH)? {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&layout.lock).map_err(|e| format!("lock file: {e}"))?;
    Ok(text.trim().parse().ok())
}

/// `Ok(false)` when another process holds a conflicting lock.
fn try_flock(file: &File, kind: i32) -> Result<bool, String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), kind | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(format!("lock file: {error}"))
    }
}

const HBA: &str = "\
# Written by the Moss database supervisor. Every connection needs a password (SCRAM).
local   all   all                  scram-sha-256
host    all   all   127.0.0.1/32   scram-sha-256
host    all   all   ::1/128        scram-sha-256
";

/// Creates the cluster on first run. Returns whether it was created.
///
/// `initdb` writes into a side folder that is renamed into place only once it is complete,
/// so a crash or power cut during the first run leaves nothing half made.
pub fn initialize(layout: &Layout, bundle: &Bundle) -> Result<bool, String> {
    if layout.data.join("PG_VERSION").is_file() {
        return Ok(false);
    }
    if std::fs::read_dir(&layout.data).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(format!("{} holds files but no database; refusing to overwrite it", layout.data.display()));
    }
    let partial = layout.root.join("db.partial");
    if partial.exists() {
        std::fs::remove_dir_all(&partial).map_err(|e| format!("unfinished first run: {e}"))?;
    }
    let password = secrets::password(layout, SUPERUSER).map_err(|e| format!("superuser password: {e}"))?;
    let pwfile = layout.secrets.join("initdb-password");
    let _ = std::fs::remove_file(&pwfile);
    private_file(&pwfile)
        .and_then(|mut file| file.write_all(password.expose().as_bytes()))
        .map_err(|e| format!("password file: {e}"))?;

    let log = log_file(layout, "initdb.log")?;
    let mut initdb = Command::new(bundle.bin("initdb"));
    initdb
        .arg("-D")
        .arg(&partial)
        .args(["-U", SUPERUSER, "--encoding=UTF8", "--no-instructions", "--data-checksums"])
        .arg(format!("--pwfile={}", pwfile.display()))
        .args(["--auth-local=scram-sha-256", "--auth-host=scram-sha-256"])
        // Sorting and case rules come from the bundled ICU, the same on every OS. The libc
        // ctype stays UTF-8 because Postgres 17 text search still asks libc what a letter is.
        .args(["--locale-provider=icu", "--icu-locale=und", "--lc-collate=C", "--lc-ctype=C.UTF-8"])
        .args(["--lc-messages=C", "--lc-monetary=C", "--lc-numeric=C", "--lc-time=C"])
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    clean_env(&mut initdb);
    let status = initdb.status();
    let _ = std::fs::remove_file(&pwfile);
    let status = status.map_err(|e| format!("initdb: {e}"))?;
    if !status.success() {
        return Err(format!("initdb failed ({status}); see logs/initdb.log"));
    }
    std::fs::write(partial.join("pg_hba.conf"), HBA).map_err(|e| format!("pg_hba.conf: {e}"))?;
    if layout.data.exists() {
        std::fs::remove_dir(&layout.data).map_err(|e| format!("{}: {e}", layout.data.display()))?;
    }
    std::fs::rename(&partial, &layout.data).map_err(|e| format!("move the new database into place: {e}"))?;
    Ok(true)
}

/// A started cluster, owned by this process.
pub struct Running {
    pub child: Child,
    pub pid: i32,
    pub endpoint: Endpoint,
    /// What the start had to clean up first, in plain words.
    pub recovered: Vec<String>,
    /// Ports that were taken by another program and skipped.
    pub skipped_ports: Vec<u16>,
}

enum StartError {
    PortInUse,
    Other(String),
}

/// Clears leftovers from an earlier crash, then starts Postgres and waits until it accepts
/// connections.
pub fn start(layout: &Layout, bundle: &Bundle, listen: &Listen, timeout: Duration) -> Result<Running, String> {
    let recovered = clear_leftovers(layout)?;
    let candidates: Vec<u16> = match listen {
        // The port only names the socket file inside the private run folder.
        Listen::SocketOnly => vec![5432],
        Listen::Loopback(Some((from, to))) => (*from..=*to).collect(),
        // 0 asks the OS for a free port on each try.
        Listen::Loopback(None) => vec![0; 5],
    };
    let mut skipped_ports = Vec::new();
    for candidate in candidates {
        let port = match (listen, candidate) {
            (Listen::SocketOnly, port) => port,
            (_, 0) => free_port().map_err(|e| format!("free port: {e}"))?,
            (_, port) if !port_is_free(port) => {
                skipped_ports.push(port);
                continue;
            }
            (_, port) => port,
        };
        match launch(layout, bundle, listen, port, timeout) {
            Ok(child) => {
                let pid = child.id() as i32;
                let socket_dir = matches!(listen, Listen::SocketOnly).then(|| layout.run.clone());
                let endpoint = Endpoint { socket_dir, port };
                write_state(layout, pid, &endpoint)?;
                return Ok(Running { child, pid, endpoint, recovered, skipped_ports });
            }
            // Another program took the port between the check and Postgres binding it.
            Err(StartError::PortInUse) => skipped_ports.push(port),
            Err(StartError::Other(error)) => return Err(error),
        }
    }
    Err(format!("no free port; ports in use: {skipped_ports:?}"))
}

fn launch(layout: &Layout, bundle: &Bundle, listen: &Listen, port: u16, timeout: Duration) -> Result<Child, StartError> {
    let other = StartError::Other;
    let mut log = log_file(layout, "postgres.log").map_err(other)?;
    let from = log.seek(SeekFrom::End(0)).map_err(|e| other(e.to_string()))?;
    let listen_addresses = match listen {
        Listen::SocketOnly => "",
        Listen::Loopback(_) => "127.0.0.1",
    };
    let settings = [
        ("listen_addresses", listen_addresses.to_string()),
        ("port", port.to_string()),
        ("unix_socket_directories", layout.run.display().to_string()),
        ("unix_socket_permissions", "0700".into()),
        ("ssl", "off".into()),
        ("password_encryption", "scram-sha-256".into()),
        ("max_connections", "50".into()),
        ("cluster_name", "moss".into()),
        ("logging_collector", "off".into()),
        ("lc_messages", "C".into()),
    ];
    let mut postgres = Command::new(bundle.bin("postgres"));
    postgres.arg("-D").arg(&layout.data);
    for (name, value) in settings {
        postgres.arg("-c").arg(format!("{name}={value}"));
    }
    postgres
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| other(e.to_string()))?)
        .stderr(log.try_clone().map_err(|e| other(e.to_string()))?)
        // Its own process group, so a Ctrl-C in the supervisor's terminal reaches only the
        // supervisor, which then stops Postgres in order.
        .process_group(0);
    clean_env(&mut postgres);
    let supervisor = std::process::id();
    unsafe {
        postgres.pre_exec(move || {
            // Postgres memory holds private rows: never write it to a crash dump. The start
            // fails rather than run without this limit.
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            if libc::setrlimit(libc::RLIMIT_CORE, &none) != 0 {
                return Err(io::Error::last_os_error());
            }
            // Linux: if the supervisor dies, Postgres gets a fast shutdown. The signal follows
            // the thread that spawned it, so only the main thread may call `start`.
            #[cfg(target_os = "linux")]
            {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGINT as libc::c_ulong);
                if libc::getppid() as u32 != supervisor {
                    return Err(io::Error::other("supervisor exited during start"));
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = supervisor;
            Ok(())
        });
    }
    let mut child = postgres.spawn().map_err(|e| other(format!("start postgres: {e}")))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| other(e.to_string()))? {
            let tail = log_tail(&mut log, from);
            if tail.contains("Address already in use") || tail.contains("could not create any TCP/IP sockets") {
                return Err(StartError::PortInUse);
            }
            return Err(other(format!("postgres exited during start ({status}):\n{tail}")));
        }
        if let Some(pidfile) = read_postmaster_pid(layout) {
            if pidfile.pid == child.id() as i32 && pidfile.status == "ready" {
                return Ok(child);
            }
        }
        if started.elapsed() > timeout {
            let pid = child.id() as i32;
            procs::signal(pid, libc::SIGQUIT);
            let _ = wait_exit(&mut child, Duration::from_secs(5)).or_else(|| {
                procs::signal(pid, libc::SIGKILL);
                child.wait().ok()
            });
            return Err(other(format!("postgres was not ready after {}s", timeout.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// How a stop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// Postgres had already exited before it was asked to stop.
    AlreadyExited,
    /// Fast shutdown: clients disconnected, a checkpoint written, nothing to recover.
    Clean,
    /// Immediate shutdown after the fast one timed out: the next start replays the log.
    Immediate,
    Killed,
}

pub fn stop(layout: &Layout, running: &mut Running, timeout: Duration) -> Result<(StopMode, ExitStatus), String> {
    let steps = [
        (libc::SIGINT, timeout, StopMode::Clean),
        (libc::SIGQUIT, Duration::from_secs(10), StopMode::Immediate),
        (libc::SIGKILL, Duration::from_secs(10), StopMode::Killed),
    ];
    if let Some(status) = running.child.try_wait().map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(layout.state_file());
        return Ok((StopMode::AlreadyExited, status));
    }
    for (signal, wait, mode) in steps {
        procs::signal(running.pid, signal);
        if let Some(status) = wait_exit(&mut running.child, wait) {
            let _ = std::fs::remove_file(layout.state_file());
            return Ok((mode, status));
        }
    }
    Err("postgres did not exit".into())
}

fn wait_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

/// The parts of `postmaster.pid` the supervisor reads.
#[derive(Debug, Clone)]
pub struct PostmasterPid {
    pub pid: i32,
    pub data: PathBuf,
    pub status: String,
}

pub fn read_postmaster_pid(layout: &Layout) -> Option<PostmasterPid> {
    let text = std::fs::read_to_string(layout.postmaster_pid()).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    Some(PostmasterPid {
        pid: lines.first()?.trim().parse().ok()?,
        data: PathBuf::from(lines.get(1)?.trim()),
        status: lines.get(7).map(|s| s.trim().to_string()).unwrap_or_default(),
    })
}

/// Makes the data folder safe to start after a crash, touching only this install's processes.
///
/// - The supervisor died but Postgres kept running: stop that Postgres cleanly.
/// - Postgres was killed but some of its server processes live on: end them.
/// - The lock file names a pid that is now an unrelated program: leave the program alone and
///   remove the stale lock file, which Postgres would otherwise refuse to start past.
pub fn clear_leftovers(layout: &Layout) -> Result<Vec<String>, String> {
    let mut actions = Vec::new();
    let pidfile = read_postmaster_pid(layout);
    let ours = procs::database_processes(&layout.data);
    if !ours.is_empty() {
        let postmaster = pidfile.as_ref().map(|p| p.pid).filter(|pid| ours.contains(pid));
        match postmaster {
            Some(pid) => {
                actions.push(format!("database still running from an earlier session (pid {pid}); stopped it cleanly"));
                procs::signal(pid, libc::SIGINT);
            }
            None => {
                actions.push(format!("{} server processes outlived a crashed database; ended them", ours.len()));
                ours.iter().for_each(|&pid| procs::signal(pid, libc::SIGQUIT));
            }
        }
        if !wait_gone(layout, Duration::from_secs(30)) {
            actions.push("they did not exit in time; killed them".into());
            procs::database_processes(&layout.data).iter().for_each(|&pid| procs::signal(pid, libc::SIGKILL));
            if !wait_gone(layout, Duration::from_secs(10)) {
                return Err("old database processes would not exit".into());
            }
        }
    }
    if let Some(pidfile) = read_postmaster_pid(layout) {
        if procs::alive(pidfile.pid) {
            std::fs::remove_file(layout.postmaster_pid()).map_err(|e| format!("stale lock file: {e}"))?;
            actions.push(format!(
                "lock file named pid {}, now an unrelated program; left it alone and removed the stale lock file",
                pidfile.pid
            ));
        } else {
            actions.push(format!("stale lock file from a crash (pid {} is gone); Postgres replaces it", pidfile.pid));
        }
    }
    Ok(actions)
}

fn wait_gone(layout: &Layout, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if procs::database_processes(&layout.data).is_empty() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn write_state(layout: &Layout, pid: i32, endpoint: &Endpoint) -> Result<(), String> {
    let started = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let state = json!({
        "supervisor_pid": std::process::id(),
        "postgres_pid": pid,
        "endpoint": endpoint.to_json(),
        "started_unix": started,
    });
    write_private(&layout.state_file(), state.to_string().as_bytes()).map_err(|e| format!("state file: {e}"))
}

pub fn read_state(layout: &Layout) -> Result<Value, String> {
    let text = std::fs::read_to_string(layout.state_file()).map_err(|_| "the database is not running".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn log_file(layout: &Layout, name: &str) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .create(true)
        .append(true)
        .mode(0o600)
        .open(layout.logs.join(name))
        .map_err(|e| format!("{name}: {e}"))
}

/// The last lines Postgres wrote since `from`, for an error message.
fn log_tail(log: &mut File, from: u64) -> String {
    let mut text = String::new();
    let _ = log.seek(SeekFrom::Start(from)).and_then(|_| log.read_to_string(&mut text));
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

/// Postgres and its tools read `PG*` variables; none from the user's shell may steer them.
fn clean_env(command: &mut Command) {
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("PG") {
            command.env_remove(name);
        }
    }
}
