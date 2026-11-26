//! One login registration per canonical instance folder; independent of the desktop app.
use moss_network::config::private_write;
use moss_network::instance::{Running, RUNNING_FILE};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
    let output = command.stdin(Stdio::null()).output().map_err(|_| REMEDY)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(REMEDY.into())
    }
}
fn canonical(folder: &Path) -> Result<PathBuf, String> {
    folder.canonicalize().map_err(|_| REMEDY.into())
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| REMEDY.into())
}
fn registration(folder: &Path) -> Result<PathBuf, String> {
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
    let contents = format!("[Unit]\nDescription=Moss server\n[Service]\nType=simple\nExecStart={} service-run {}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=200\n[Install]\nWantedBy=default.target\n", unit_arg(&launcher), unit_arg(folder));
    #[cfg(target_os = "macos")]
    let contents = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{}</string><string>service-run</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>200</integer></dict></plist>", name(folder), xml(&launcher.to_string_lossy()), xml(&folder.to_string_lossy()));
    #[cfg(windows)]
    let contents = {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
            ])
            .output()
            .map_err(|_| REMEDY)?;
        if !output.status.success() {
            return Err(REMEDY.into());
        }
        let sid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !sid.starts_with("S-1-")
            || !sid
                .bytes()
                .all(|b| b.is_ascii_digit() || b"S-".contains(&b))
        {
            return Err(REMEDY.into());
        }
        // Windows parses this with CommandLineToArgvW. A canonical folder cannot end in a
        // separator unless it is a drive root; JSON quoting is NOT Windows argv quoting.
        let argument = format!("service-run {}", windows_arg(folder));
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers><Principals><Principal id=\"Owner\"><UserId>{sid}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context=\"Owner\"><Exec><Command>{}</Command><Arguments>{}</Arguments></Exec></Actions></Task>", xml(&launcher.to_string_lossy()), xml(&argument))
    };
    private_write(&path, contents.as_bytes())?;
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
        checked(Command::new("schtasks.exe").args(["/Run", "/TN", &name(folder)]))
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
    let folder = canonical(folder)?;
    private_write(&folder.join(STOPPED), b"Stopped by the owner\n")?;
    #[cfg(target_os = "linux")]
    checked(Command::new("systemctl").args([
        "--user",
        "disable",
        &format!("{}.service", name(&folder)),
    ]))?;
    #[cfg(windows)]
    checked(Command::new("schtasks.exe").args(["/Change", "/TN", &name(&folder), "/Disable"]))?;
    if folder.join(RUNNING_FILE).exists() {
        let running = Running::read(&folder)?;
        private_write(
            &folder.join(moss_network::tls::STOP_FILE),
            running.pid.to_string().as_bytes(),
        )?;
    }
    let deadline = Instant::now() + Duration::from_secs(200);
    // The service owns this lock until the server AND its database have stopped.
    loop {
        let file = service_lock(&folder)?;
        if portability::file_lock::try_exclusive(&file).map_err(|_| REMEDY)? {
            break;
        }
        if Instant::now() > deadline {
            return Err(REMEDY.into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unload(&folder)
}
fn unload(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return checked(Command::new("systemctl").args([
        "--user",
        "stop",
        &format!("{}.service", name(folder)),
    ]));
    #[cfg(target_os = "macos")]
    return checked(
        Command::new("launchctl")
            .arg("bootout")
            .arg(domain()?)
            .arg(registration(folder)?),
    );
    #[cfg(windows)]
    return Ok(()); // A disabled task whose action returned has nothing left to terminate.
}
pub fn remove(install: &Path, folder: &Path) -> Result<(), String> {
    stop(install, folder)?;
    let folder = canonical(folder)?;
    #[cfg(windows)]
    checked(Command::new("schtasks.exe").args(["/Delete", "/TN", &name(&folder), "/F"]))?;
    std::fs::remove_file(registration(&folder)?).map_err(|_| REMEDY)?;
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
    let mut child = crate::runtime::command(install, "moss-server")
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
