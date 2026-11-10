//! Creating, starting, stopping and recovering the private cluster.

use std::fs::{File, OpenOptions};
#[allow(unused_imports)]
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Child;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

#[cfg(unix)]
use crate::layout::private_file;
use crate::layout::Layout;
use crate::secrets::{self, Secret};
use crate::{procs, SUPERUSER};

/// The database process the supervisor owns. On Windows it sits in a kill-on-close job, so the
/// whole database tree ends if the supervisor does.
#[cfg(unix)]
pub type DbChild = Child;
#[cfg(windows)]
pub type DbChild = portability::windows_child::Child;

/// A path as the database programs should see it: Windows tools do not take `\\?\` paths.
fn tool_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest);
            }
        }
    }
    path.to_path_buf()
}

/// The Postgres build that ships with the app: `bin/`, `lib/` and `share/` side by side.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub root: PathBuf,
}

impl Bundle {
    pub fn new(root: &Path) -> Result<Bundle, String> {
        let root = tool_path(&root.canonicalize().map_err(|e| format!("Postgres bundle {}: {e}", root.display()))?);
        let bundle = Bundle { root };
        for tool in ["postgres", "initdb"] {
            if !bundle.bin(tool).is_file() {
                return Err(format!("Postgres bundle has no bin/{tool}"));
            }
        }
        Ok(bundle)
    }

    pub fn bin(&self, name: &str) -> PathBuf {
        self.root.join("bin").join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
    }

    /// Whether the bundle carries `pg-module/moss_nodump`, which makes Postgres non-dumpable.
    /// Only Linux needs it.
    pub fn has_nodump(&self) -> bool {
        cfg!(target_os = "linux") && self.root.join("lib/postgresql/moss_nodump.so").is_file()
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
            #[cfg(unix)]
            Some(dir) => config.host_path(dir),
            #[cfg(not(unix))]
            Some(_) => return Err("Unix sockets are not available on this system".into()),
            None => config.host("127.0.0.1"),
        };
        config.connect(postgres::NoTls).map_err(|e| format!("connect as {role}: {}", db_error(&e)))
    }

    pub fn to_json(&self) -> Value {
        json!({ "socket_dir": self.socket_dir, "port": self.port })
    }

    /// The endpoint a state file names. A socket endpoint is always this install's own socket
    /// folder `run`, whatever folder the file names.
    pub fn from_json(value: &Value, run: &Path) -> Option<Endpoint> {
        Some(Endpoint {
            socket_dir: value["socket_dir"].is_string().then(|| run.to_path_buf()),
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

// Keep the canonical supervisor entry point while sharing its lock with Windows.
pub use crate::supervisor_lock::{lock, InstallLock};

/// How long `holder` waits for a new supervisor to write its pid.
const HOLDER_WAIT: Duration = Duration::from_secs(1);

/// The pid of the supervisor running this install, if one is. Takes a shared lock for a
/// moment and writes nothing.
///
/// A new supervisor writes its pid just after it takes the lock, so for a moment the file can
/// be empty or still name the previous supervisor, whose pid may now belong to another program.
/// A pid counts only when it runs `moss-db up` or `init`.
pub fn holder(layout: &Layout) -> Result<Option<i32>, String> {
    let clock = Instant::now();
    loop {
        #[cfg(unix)]
        let opened = File::open(&layout.lock);
        #[cfg(windows)]
        let opened = layout.open_supervisor_lock();
        let mut file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("lock file: {error}")),
        };
        if portability::file_lock::try_shared(&file).map_err(|e| format!("lock file: {e}"))? {
            return Ok(None);
        }
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|e| format!("lock file: {e}"))?;
        let text = text.trim();
        match text.parse::<i32>() {
            Ok(pid) if procs::is_supervisor(pid) => return Ok(Some(pid)),
            _ if clock.elapsed() > HOLDER_WAIT => {
                return Err(format!("the install is locked, but the lock file names no running supervisor ({text:?})"));
            }
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

const HBA: &str = "\
# Written by the Moss database supervisor. Every connection needs a password (SCRAM).
local   all   all                  scram-sha-256
host    all   all   127.0.0.1/32   scram-sha-256
host    all   all   ::1/128        scram-sha-256
";

/// Windows clients always arrive over loopback TCP, and a `local` line can stop a build without
/// Unix sockets from loading the file.
fn hba() -> String {
    if cfg!(windows) {
        HBA.lines().filter(|line| !line.starts_with("local")).collect::<Vec<_>>().join("\n") + "\n"
    } else {
        HBA.to_string()
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates the cluster on first run. Returns whether it was created.
///
/// `initdb` writes into a side folder that is renamed into place only once it is complete,
/// so a crash or power cut during the first run leaves nothing half made.
pub fn initialize(layout: &Layout, bundle: &Bundle) -> Result<bool, String> {
    // An unfinished first run can leave PG_VERSION behind, so the marker is checked first.
    #[cfg(windows)]
    let interrupted = layout.root.join("initdb-unfinished").exists();
    #[cfg(not(windows))]
    let interrupted = false;
    if !interrupted && layout.data.join("PG_VERSION").is_file() {
        return Ok(false);
    }
    // Windows keeps the data folder open as a pinned handle, so it cannot be replaced by a
    // rename. initdb writes into it directly, and a marker file shows an unfinished first run.
    #[cfg(windows)]
    let marker = layout.root.join("initdb-unfinished");
    #[cfg(windows)]
    let unfinished = marker.exists();
    #[cfg(not(windows))]
    let unfinished = false;
    if !unfinished && std::fs::read_dir(&layout.data).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(format!("{} holds files but no database; refusing to overwrite it", layout.data.display()));
    }
    #[cfg(windows)]
    {
        if unfinished {
            for entry in std::fs::read_dir(&layout.data).map_err(|e| format!("unfinished first run: {e}"))? {
                let path = entry.map_err(|e| format!("unfinished first run: {e}"))?.path();
                let gone = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                gone.map_err(|e| format!("unfinished first run: {e}"))?;
            }
        }
        std::fs::write(&marker, b"initdb running").map_err(|e| format!("first-run marker: {e}"))?;
    }
    #[cfg(windows)]
    let partial = layout.data.clone();
    #[cfg(not(windows))]
    let partial = layout.root.join("db.partial");
    #[cfg(not(windows))]
    if partial.exists() {
        std::fs::remove_dir_all(&partial).map_err(|e| format!("unfinished first run: {e}"))?;
    }
    let password = secrets::password(layout, SUPERUSER).map_err(|e| format!("superuser password: {e}"))?;
    // Windows reads the superuser's own private secret file, so no second copy of it exists.
    #[cfg(windows)]
    let pwfile = layout.secrets.join(SUPERUSER);
    #[cfg(unix)]
    let pwfile = layout.secrets.join("initdb-password");
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&pwfile);
        private_file(&pwfile)
            .and_then(|mut file| file.write_all(password.expose().as_bytes()))
            .map_err(|e| format!("password file: {e}"))?;
    }
    #[cfg(windows)]
    let _ = &password;

    let log = log_file(layout, "initdb.log")?;
    let mut initdb = Command::new(bundle.bin("initdb"));
    initdb
        .arg("-D")
        .arg(tool_path(&partial))
        .args(["-U", SUPERUSER, "--encoding=UTF8", "--no-instructions", "--data-checksums"])
        .arg(format!("--pwfile={}", tool_path(&pwfile).display()))
        .args(["--auth-local=scram-sha-256", "--auth-host=scram-sha-256"])
        // Sorting and case rules come from ICU, not from the OS's C library. Sorting matches
        // across OSes only when each bundle ships the same ICU version. The spike used each
        // machine's own ICU. The libc ctype stays UTF-8 because Postgres 17 text search still
        // asks libc what a letter is.
        .args(["--locale-provider=icu", "--icu-locale=und", "--lc-collate=C"])
        .arg(if cfg!(windows) { "--lc-ctype=C" } else { "--lc-ctype=C.UTF-8" })
        .args(["--lc-messages=C", "--lc-monetary=C", "--lc-numeric=C", "--lc-time=C"])
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    clean_env(&mut initdb);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        initdb.creation_flags(CREATE_NO_WINDOW);
    }
    // Linux: initdb dies with the supervisor. The server initdb starts gets no such signal. It
    // reads its commands from initdb through a pipe, so it should stop soon after initdb, but
    // nothing checks that it has stopped before a later supervisor clears the side folder.
    #[cfg(target_os = "linux")]
    unsafe {
        initdb.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong);
            Ok(())
        });
    }
    let status = initdb.status();
    #[cfg(unix)]
    let _ = std::fs::remove_file(&pwfile);
    let status = status.map_err(|e| format!("initdb: {e}"))?;
    if !status.success() {
        return Err(format!("initdb failed ({status}); see logs/initdb.log"));
    }
    std::fs::write(partial.join("pg_hba.conf"), hba()).map_err(|e| format!("pg_hba.conf: {e}"))?;
    #[cfg(windows)]
    std::fs::remove_file(&marker).map_err(|e| format!("first-run marker: {e}"))?;
    #[cfg(not(windows))]
    {
        if layout.data.exists() {
            std::fs::remove_dir(&layout.data).map_err(|e| format!("{}: {e}", layout.data.display()))?;
        }
        std::fs::rename(&partial, &layout.data).map_err(|e| format!("move the new database into place: {e}"))?;
    }
    Ok(true)
}

/// A started cluster, owned by this process.
pub struct Running {
    pub child: DbChild,
    /// `pg_ctl` asks a Windows database to stop in order, since Windows has no signals for it.
    #[cfg(windows)]
    pub pg_ctl: PathBuf,
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
                return Ok(Running {
                    child,
                    #[cfg(windows)]
                    pg_ctl: bundle.bin("pg_ctl"),
                    pid,
                    endpoint,
                    recovered,
                    skipped_ports,
                });
            }
            // Another program took the port between the check and Postgres binding it.
            Err(StartError::PortInUse) => skipped_ports.push(port),
            Err(StartError::Other(error)) => return Err(error),
        }
    }
    Err(format!("no free port; ports in use: {skipped_ports:?}"))
}

fn launch(layout: &Layout, bundle: &Bundle, listen: &Listen, port: u16, timeout: Duration) -> Result<DbChild, StartError> {
    let other = StartError::Other;
    let mut log = log_file(layout, "postgres.log").map_err(other)?;
    let from = log.seek(SeekFrom::End(0)).map_err(|e| other(e.to_string()))?;
    let listen_addresses = match listen {
        Listen::SocketOnly => "",
        Listen::Loopback(_) => "127.0.0.1",
    };
    let mut settings = vec![
        ("listen_addresses", listen_addresses.to_string()),
        ("port", port.to_string()),
        ("ssl", "off".into()),
        ("password_encryption", "scram-sha-256".into()),
        ("max_connections", "50".into()),
        ("cluster_name", layout.cluster_name()),
        ("logging_collector", "off".into()),
        ("lc_messages", "C".into()),
    ];
    #[cfg(unix)]
    {
        settings.push(("unix_socket_directories", layout.run.display().to_string()));
        settings.push(("unix_socket_permissions", "0700".into()));
    }
    // Windows serves loopback TCP only, so no socket folder is named.
    #[cfg(windows)]
    settings.push(("unix_socket_directories", String::new()));
    if bundle.has_nodump() {
        settings.push(("shared_preload_libraries", "moss_nodump".into()));
    }
    #[cfg(unix)]
    let mut child = {
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
        postgres.spawn().map_err(|e| other(format!("start postgres: {e}")))?
    };
    #[cfg(windows)]
    let mut child = {
        let mut args: Vec<std::ffi::OsString> = vec!["-D".into(), tool_path(&layout.data).into()];
        for (name, value) in settings {
            args.push("-c".into());
            args.push(format!("{name}={value}").into());
        }
        portability::windows_child::spawn(
            &bundle.bin("postgres"),
            &args,
            &tool_path(&layout.root),
            &log,
            &log,
        )
        .map_err(|e| other(format!("start postgres: {e}")))?
    };
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
            #[cfg(unix)]
            {
                let pid = child.id() as i32;
                procs::signal(pid, libc::SIGQUIT);
                let _ = wait_exit(&mut child, Duration::from_secs(5)).or_else(|| {
                    procs::signal(pid, libc::SIGKILL);
                    child.wait().ok()
                });
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
                let _ = child.wait();
            }
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

/// One step of an orderly stop, from gentle to forceful.
#[derive(Clone, Copy)]
enum Ask {
    Fast,
    Immediate,
    Kill,
}

fn ask(running: &mut Running, step: Ask) {
    #[cfg(unix)]
    {
        let signal = match step {
            Ask::Fast => libc::SIGINT,
            Ask::Immediate => libc::SIGQUIT,
            Ask::Kill => libc::SIGKILL,
        };
        procs::signal(running.pid, signal);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let name = match step {
            Ask::Fast => "INT",
            Ask::Immediate => "QUIT",
            Ask::Kill => return drop(running.child.kill()),
        };
        // pg_ctl sends Postgres its signal over the pipe the postmaster listens on.
        let _ = Command::new(&running.pg_ctl)
            .args(["kill", name, &running.pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

pub fn stop(layout: &Layout, running: &mut Running, timeout: Duration) -> Result<(StopMode, ExitStatus), String> {
    let steps = [
        (Ask::Fast, timeout, StopMode::Clean),
        (Ask::Immediate, Duration::from_secs(10), StopMode::Immediate),
        (Ask::Kill, Duration::from_secs(10), StopMode::Killed),
    ];
    if let Some(status) = running.child.try_wait().map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(layout.state_file());
        return Ok((StopMode::AlreadyExited, status));
    }
    for (step, wait, mode) in steps {
        ask(running, step);
        if let Some(status) = wait_exit(&mut running.child, wait) {
            let _ = std::fs::remove_file(layout.state_file());
            return Ok((mode, status));
        }
    }
    Err("postgres did not exit".into())
}

fn wait_exit(child: &mut DbChild, timeout: Duration) -> Option<ExitStatus> {
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
    #[cfg(unix)]
    let pidfile = read_postmaster_pid(layout);
    #[cfg(unix)]
    let ours = procs::database_processes(&layout.data, &layout.cluster_name());
    #[cfg(unix)]
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
            procs::database_processes(&layout.data, &layout.cluster_name()).iter().for_each(|&pid| procs::signal(pid, libc::SIGKILL));
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

#[cfg(unix)]
fn wait_gone(layout: &Layout, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if procs::database_processes(&layout.data, &layout.cluster_name()).is_empty() {
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
    layout.write_state(state.to_string().as_bytes()).map_err(|e| format!("state file: {e}"))
}

/// The running install's state file. The socket folder is checked first, because whoever
/// controls it chooses the server that the caller then sends a password to.
pub fn read_state(layout: &Layout) -> Result<Value, String> {
    match layout.check_run() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err("the database is not running".into()),
        Err(error) => return Err(error.to_string()),
        Ok(()) => {}
    }
    let text = layout.read_state().map_err(|_| "the database is not running".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn log_file(layout: &Layout, name: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(layout.logs.join(name)).map_err(|e| format!("{name}: {e}"))
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
        // Windows names are not case sensitive.
        if name.to_string_lossy().to_ascii_uppercase().starts_with("PG") {
            command.env_remove(name);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// An install whose socket folder is `run`, as when it falls back to a shared folder.
    fn layout_with_run(root: &Path, run: PathBuf) -> Layout {
        Layout {
            data: root.join("db"),
            run,
            secrets: root.join("secrets"),
            logs: root.join("logs"),
            lock: root.join("moss-db.lock"),
            root: root.to_path_buf(),
        }
    }

    /// A temporary folder closed to others. Ubuntu's umask would leave it group-writable.
    fn private_tempdir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn supervisor_lock_keeps_its_pid_readable_and_releases_on_drop() {
        let dir = private_tempdir();
        let layout = Layout::create(&dir.path().join("install")).unwrap();
        let first = lock(&layout).unwrap();
        assert_eq!(std::fs::read_to_string(&layout.lock).unwrap(), std::process::id().to_string());
        assert!(lock(&layout).is_err());
        drop(first);
        assert_eq!(holder(&layout).unwrap(), None);
        assert!(lock(&layout).is_ok());
    }

    const PLANTED: &str = r#"{"endpoint":{"socket_dir":"/someone/else","port":5432}}"#;

    #[test]
    fn a_planted_state_file_is_never_read() {
        let dir = private_tempdir();
        let theirs = dir.path().join("theirs");
        std::fs::create_dir(&theirs).unwrap();
        std::fs::write(theirs.join("state.json"), PLANTED).unwrap();

        let link = dir.path().join("moss-db-link");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        let error = read_state(&layout_with_run(dir.path(), link)).unwrap_err();
        assert!(error.ends_with("is not a real folder"), "{error}");

        std::fs::set_permissions(&theirs, std::fs::Permissions::from_mode(0o777)).unwrap();
        let error = read_state(&layout_with_run(dir.path(), theirs)).unwrap_err();
        assert!(error.ends_with("can be opened by other users"), "{error}");
    }

    #[test]
    fn a_missing_socket_folder_means_not_running() {
        let dir = private_tempdir();
        let error = read_state(&layout_with_run(dir.path(), dir.path().join("gone"))).unwrap_err();
        assert_eq!(error, "the database is not running");
    }

    #[test]
    fn the_socket_is_always_in_this_installs_folder() {
        let dir = private_tempdir();
        let run = dir.path().join("run");
        std::fs::create_dir(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(run.join("state.json"), PLANTED).unwrap();
        let layout = layout_with_run(dir.path(), run.clone());

        let state = read_state(&layout).unwrap();
        let socket = Endpoint::from_json(&state["endpoint"], &layout.run).unwrap();
        assert_eq!(socket.socket_dir.as_deref(), Some(run.as_path()));
        assert_eq!(socket.port, 5432);

        let tcp = Endpoint::from_json(&json!({ "socket_dir": null, "port": 5194 }), &layout.run).unwrap();
        assert_eq!(tcp.socket_dir, None);
    }
}
