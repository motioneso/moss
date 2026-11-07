//! Finds leftover database processes after a crash without touching any other program.
//!
//! Postgres changes into its data folder when it starts, and every server process it forks
//! keeps that working folder. A process of this OS user, running a `postgres` binary, whose
//! working folder is this install's data folder, therefore belongs to this install. A
//! process-group check would not work: each Postgres child calls `setsid` and leaves the
//! postmaster's group.

use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

/// Whether `pid` names a live process (one we may not signal still counts).
pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

pub fn signal(pid: i32, signal: i32) {
    if pid > 0 && pid as u32 != std::process::id() {
        unsafe { libc::kill(pid, signal) };
    }
}

/// Live processes that belong to the cluster in `data`, as described in the module comment.
#[cfg(target_os = "linux")]
pub fn database_processes(data: &Path) -> Vec<i32> {
    let Ok(data) = data.canonicalize() else { return Vec::new() };
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return found };
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok()) else {
            continue;
        };
        if pid as u32 == std::process::id() {
            continue;
        }
        let dir = entry.path();
        // Unreadable for other users' processes and for zombies, which are skipped either way.
        let (Ok(cwd), Ok(exe)) = (std::fs::read_link(dir.join("cwd")), std::fs::read_link(dir.join("exe")))
        else {
            continue;
        };
        if cwd == data && is_postgres(&exe) {
            found.push(pid);
        }
    }
    found.sort_unstable();
    found
}

/// A replaced binary reads back as `<path> (deleted)`.
#[cfg(target_os = "linux")]
fn is_postgres(exe: &Path) -> bool {
    let text = exe.to_string_lossy();
    let path = PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(&text));
    path.file_name().is_some_and(|name| name == "postgres")
}

/// macOS: `ps` lists this user's `postgres` processes, `lsof` gives each one's working
/// folder. Not compiled or run in this spike: the Mac has no Rust toolchain.
#[cfg(target_os = "macos")]
pub fn database_processes(data: &Path) -> Vec<i32> {
    use std::process::Command;
    let Ok(data) = data.canonicalize() else { return Vec::new() };
    let uid = unsafe { libc::getuid() };
    let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,uid=,comm="]).output() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(owner), Some(comm)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(owner)) = (pid.parse::<i32>(), owner.parse::<u32>()) else { continue };
        if owner != uid || !comm.ends_with("/postgres") && comm != "postgres" {
            continue;
        }
        let Ok(cwd) = Command::new("/usr/sbin/lsof").args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).output()
        else {
            continue;
        };
        let cwd = String::from_utf8_lossy(&cwd.stdout);
        if cwd.lines().any(|line| line.strip_prefix('n').is_some_and(|path| Path::new(path) == data)) {
            found.push(pid);
        }
    }
    found
}
