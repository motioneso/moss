//! One login registration per canonical instance folder; independent of the desktop app.
use moss_network::config::private_write;
use moss_network::instance::{Running, RUNNING_FILE};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
#[cfg(windows)]
mod windows;

pub const STOPPED: &str = "service-stopped";
const REMEDY: &str =
    "Moss could not use its background service. Check your sign-in services, then press Start.";

pub fn name(folder: &Path) -> String {
    // Explicit stable hash: registrations must keep their identity across program versions.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in folder.to_string_lossy().as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    format!("moss-server-{hash:016x}")
}
fn checked(command: &mut Command) -> Result<(), String> {
    checked_remedy(command, REMEDY)
}
fn checked_remedy(command: &mut Command, remedy: &str) -> Result<(), String> {
    let output = command.stdin(Stdio::null()).output().map_err(|_| remedy)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(remedy.into())
    }
}
fn canonical(folder: &Path) -> Result<PathBuf, String> {
    folder.canonicalize().map_err(|_| REMEDY.into())
}
#[cfg(not(windows))]
fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| REMEDY.into())
}
fn registration(folder: &Path) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    let id = name(folder);
    #[cfg(target_os = "linux")]
    return Ok(std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".config"))
        .join("systemd/user")
        .join(format!("{id}.service")));
    #[cfg(target_os = "macos")]
    return Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{id}.plist")));
    #[cfg(windows)]
    return Ok(folder.join("login-task.xml"));
}
#[cfg(any(target_os = "macos", windows))]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(target_os = "linux")]
fn unit_arg(value: &Path) -> String {
    format!(
        "\"{}\"",
        value
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
#[cfg(target_os = "macos")]
fn domain() -> Result<String, String> {
    let output = Command::new("id").arg("-u").output().map_err(|_| REMEDY)?;
    if !output.status.success() {
        return Err(REMEDY.into());
    }
    Ok(format!(
        "gui/{}",
        String::from_utf8_lossy(&output.stdout).trim()
    ))
}
fn register(install: &Path, folder: &Path) -> Result<(), String> {
    let path = registration(folder)?;
    std::fs::create_dir_all(path.parent().ok_or(REMEDY)?).map_err(|_| REMEDY)?;
    let launcher = crate::launcher(install)
        .canonicalize()
        .map_err(|_| REMEDY)?;
    #[cfg(target_os = "linux")]
    let contents = format!("[Unit]\nDescription=Moss server\nStartLimitIntervalSec=infinity\nStartLimitBurst=3\n[Service]\nType=simple\nExecStart={} service-run {}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=200\n[Install]\nWantedBy=default.target\n", unit_arg(&launcher), unit_arg(folder));
    #[cfg(target_os = "macos")]
    let contents = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{}</string><string>service-run</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>200</integer></dict></plist>", name(folder), xml(&launcher.to_string_lossy()), xml(&folder.to_string_lossy()));
    #[cfg(windows)]
    let contents = windows::definition(&launcher, folder)?;
    #[cfg(not(windows))]
    private_write(&path, contents.as_bytes())?;
    #[cfg(windows)]
    private_write(&path, &contents)?;
    #[cfg(target_os = "linux")]
    {
        checked(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
        checked(Command::new("systemctl").args([
            "--user",
            "enable",
            "--now",
            &format!("{}.service", name(folder)),
        ]))
    }
    #[cfg(target_os = "macos")]
    {
        let target = format!("{}/{}", domain()?, name(folder));
        if Command::new("launchctl")
            .args(["print", &target])
            .output()
            .is_ok_and(|o| o.status.success())
        {
            checked(Command::new("launchctl").args(["kickstart", &target]))
        } else {
            checked(
                Command::new("launchctl")
                    .arg("bootstrap")
                    .arg(domain()?)
                    .arg(path),
            )
        }
    }
    #[cfg(windows)]
    {
        checked(
            Command::new("schtasks.exe")
                .args(["/Create", "/TN", &name(folder), "/XML"])
                .arg(path)
                .arg("/F"),
        )?;
        // Start now even outside an interactive session. Future logons use the saved task.
        let mut command = Command::new(launcher);
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
        command
            .arg("service-run")
            .arg(folder)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| REMEDY)?;
        Ok(())
    }
}
#[cfg(windows)]
fn windows_arg(path: &Path) -> String {
    let text = path.to_string_lossy();
    // Canonical Windows names contain no double quote. Double terminal backslashes before
    // the closing quote, as required by the Windows process argv convention.
    let trailing = text.len() - text.trim_end_matches('\\').len();
    format!("\"{}{}\"", text, "\\".repeat(trailing))
}

pub fn start(install: &Path, folder: &Path) -> Result<(), String> {
    let folder = canonical(folder)?;
    match std::fs::remove_file(folder.join(STOPPED)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(REMEDY.into()),
    }
    register(install, &folder)
}

/// Disable future login starts before requesting graceful shutdown. The marker also prevents
/// app autostart, reconnect and an already queued service restart from undoing Stop.
pub fn stop(_install: &Path, folder: &Path) -> Result<(), String> {
    let folder = canonical(folder).map_err(|_| {
        "Moss cannot find this server's folder. Restore the folder, then press Stop."
    })?;
    private_write(&folder.join(STOPPED), b"Stopped by the owner\n")
        .map_err(|_| "Moss could not save Stop. Check write permission for this server's folder, then press Stop again.")?;
    #[cfg(target_os = "linux")]
    checked_remedy(Command::new("systemctl").args([
        "--user", "disable", &format!("{}.service", name(&folder)),
    ]), "Moss could not disable this server's sign-in service. Check your sign-in services, then press Stop again.")?;
    #[cfg(windows)]
    {
        let query = Command::new("schtasks.exe").args(["/Query", "/TN", &name(&folder)])
            .output().map_err(|_| "Moss could not check its sign-in task. Open Task Scheduler, check your account's Moss task, then press Stop again.")?;
        if query.status.success() {
            checked_remedy(Command::new("schtasks.exe").args(["/Change", "/TN", &name(&folder), "/Disable"]),
                "Moss could not disable its sign-in task. Disable this server's task in Task Scheduler, then press Stop again.")?;
        } else {
            // A failed query is not proof that the task is absent. Listing all tasks must
            // succeed and confirm absence before Stop may continue.
            let listing = Command::new("schtasks.exe").args(["/Query", "/FO", "CSV", "/NH"])
                .output().map_err(|_| "Moss could not check its sign-in task. Open Task Scheduler and disable this server's task, then press Stop again.")?;
            if !listing.status.success()
                || String::from_utf8_lossy(&listing.stdout).contains(&name(&folder))
            {
                return Err("Moss could not check its sign-in task. Open Task Scheduler and disable this server's task, then press Stop again.".into());
            }
        }
    }
    if folder.join(RUNNING_FILE).exists() {
        let running = Running::read(&folder).map_err(|_| "Moss cannot read this server's running record. Check read permission for its folder, then press Stop again.")?;
        private_write(&folder.join(moss_network::tls::STOP_FILE), running.pid.to_string().as_bytes())
            .map_err(|_| "Moss could not send the stop request. Check write permission for this server's folder, then press Stop again.")?;
    }
    let deadline = Instant::now() + Duration::from_secs(200);
    loop {
        let file = service_lock(&folder).map_err(|_| "Moss cannot open its shutdown lock. Check write permission for this server's folder, then press Stop again.")?;
        if portability::file_lock::try_exclusive(&file)
            .map_err(|_| "Moss cannot check its shutdown lock. Check file locking support for this server's folder, then press Stop again.")? {
            // Hold the lock until login registration cleanup is complete.
            return unload(&folder);
        }
        if Instant::now() > deadline {
            return Err("Moss is still finishing work or stopping its database. Wait a moment, then press Stop again. If it keeps waiting, check server.log and database.log in this server's folder.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn unload(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return checked_remedy(Command::new("systemctl").args([
        "--user", "stop", &format!("{}.service", name(folder)),
    ]), "Moss could not stop its sign-in service. Check your sign-in services, then press Stop again.");
    #[cfg(target_os = "macos")]
    {
        let domain = domain().map_err(|_| {
            "Moss cannot find your login session. Sign out and back in, then press Stop again."
        })?;
        let target = format!("{}/{}", domain, name(folder));
        let output = Command::new("launchctl").args(["bootout", &target]).output()
            .map_err(|_| "Moss could not unload its sign-in service. Sign out and back in, then press Stop again.")?;
        // launchctl returns ESRCH (3) for an already unloaded service. Other errors
        // must remain visible; never discard the saved registration after a refusal.
        if !output.status.success() && output.status.code() != Some(3) {
            return Err("Moss could not unload its sign-in service. Sign out and back in, then press Stop again.".into());
        }
        remove_registration(&registration(folder).map_err(|_| {
            "Moss cannot find its login file. Check your home folder, then press Stop again."
        })?)
    }
    #[cfg(windows)]
    {
        let _ = folder;
        Ok(())
    }
}
fn remove_registration(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Moss could not remove its login file. Check write permission for your LaunchAgents folder, then press Stop again.".into()),
    }
}

/// Each explicit Start gets a fresh Linux crash budget, even after a clean stop.
/// Reconnects must not reset the crash budget and create another endless restart loop.
pub fn reset_failure(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if state(folder)? != State::Unregistered {
        let reset = checked(Command::new("systemctl").args([
            "--user",
            "reset-failed",
            &format!("{}.service", name(&canonical(folder)?)),
        ]));
        // systemd can unload an inactive unit between show and reset-failed. Such
        // a unit has no retained retry counter; failed or running units still
        // require a successful reset before an explicit Start may proceed.
        if reset.is_err() && !matches!(state(folder)?, State::Unregistered | State::Inactive) {
            return reset;
        }
    }
    let _ = folder;
    Ok(())
}
#[derive(Debug, PartialEq, Eq)]
pub enum State {
    Unregistered,
    Starting,
    Inactive,
    Failed,
}

/// Native service activity includes database startup, before running.json exists.
pub fn state(folder: &Path) -> Result<State, String> {
    #[cfg(target_os = "linux")]
    {
        let output = Command::new("systemctl")
            .args([
                "--user",
                "show",
                &format!("{}.service", name(&canonical(folder)?)),
                "--property=LoadState,ActiveState",
            ])
            .output()
            .map_err(|_| REMEDY)?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.lines().any(|line| line == "LoadState=not-found") {
            return Ok(State::Unregistered);
        }
        if !output.status.success() {
            return Err(REMEDY.into());
        }
        match text
            .lines()
            .find_map(|line| line.strip_prefix("ActiveState="))
        {
            Some("active" | "activating" | "reloading") => Ok(State::Starting),
            Some("failed") => Ok(State::Failed),
            Some("inactive" | "deactivating") => Ok(State::Inactive),
            _ => Err(REMEDY.into()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let file = service_lock(folder)?;
        if portability::file_lock::try_exclusive(&file).map_err(|_| REMEDY)? {
            Ok(State::Inactive)
        } else {
            Ok(State::Starting)
        }
    }
}
pub fn remove(install: &Path, folder: &Path) -> Result<(), String> {
    stop(install, folder)?;
    let folder = canonical(folder)?;
    // A sharing rule left open would outlive the instance, so removal fails if it stays.
    checked(crate::runtime::command(install, "moss-server").args([
        "firewall-close".as_ref(),
        "--instance".as_ref(),
        folder.as_os_str(),
    ]))?;
    #[cfg(windows)]
    checked(Command::new("schtasks.exe").args(["/Delete", "/TN", &name(&folder), "/F"]))?;
    remove_registration(&registration(&folder)?)?;
    #[cfg(target_os = "linux")]
    checked(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
    Ok(())
}
fn service_lock(folder: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(folder.join("service.lock"))
        .map_err(|_| REMEDY.into())
}

struct DatabaseGuard<'a> {
    install: &'a Path,
    folder: &'a Path,
}
impl Drop for DatabaseGuard<'_> {
    fn drop(&mut self) {
        let _ = crate::database::stop_database(self.install, self.folder);
    }
}

/// Login action. The service, never the desktop app, brings the database back first.
pub fn run(install: &Path, folder: &Path) -> Result<(), String> {
    let folder = canonical(folder)?;
    let lock = service_lock(&folder)?;
    if !portability::file_lock::try_exclusive(&lock).map_err(|_| REMEDY)? {
        return Err(REMEDY.into());
    }
    if folder.join(STOPPED).exists() {
        return Ok(());
    }
    private_write(
        &folder.join("service.pid"),
        std::process::id().to_string().as_bytes(),
    )?;
    let _database = DatabaseGuard {
        install,
        folder: &folder,
    };
    crate::database::ensure_database(install, &folder, false).map_err(|_| REMEDY)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let log = options
        .open(folder.join("server.log"))
        .map_err(|_| REMEDY)?;
    if folder.join(STOPPED).exists() {
        return crate::database::stop_database(install, &folder).map_err(|_| REMEDY.into());
    }
    let mut command = crate::runtime::command(install, "moss-server");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .arg("--instance")
        .arg(&folder)
        .arg("--web")
        .arg(install.join("web"))
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|_| REMEDY)?)
        .stderr(log)
        .spawn()
        .map_err(|_| REMEDY)?;
    let result = loop {
        if folder.join(STOPPED).exists() {
            if let Ok(running) = Running::read(&folder) {
                private_write(
                    &folder.join(moss_network::tls::STOP_FILE),
                    running.pid.to_string().as_bytes(),
                )?;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    crate::database::stop_database(install, &folder).map_err(|_| REMEDY)?;
    if result.is_ok_and(|s| s.success()) {
        Ok(())
    } else {
        Err(REMEDY.into())
    }
}
