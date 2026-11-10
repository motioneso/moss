//! Finds leftover database processes after a crash without touching any other program.
//!
//! A process belongs to this install when it runs as this OS user, is a `postgres` binary,
//! and its command line names this install. The postmaster keeps the command line the
//! supervisor gave it, which holds `-D <data folder>`. Every other server process rewrites
//! its title to `postgres: <cluster name>: ...`, and the cluster name is unique per install.
//!
//! The command line is used because it stays readable when the server is non-dumpable (see
//! `pg-module/moss_nodump.c`); the working folder and binary links in `/proc` do not. A
//! process-group check would not work either: each Postgres child calls `setsid`.

use std::path::Path;

/// Whether `pid` names a live process (one we may not signal still counts).
pub fn alive(pid: i32) -> bool {
    pid > 0
        && unsafe {
            libc::kill(pid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
}

pub fn signal(pid: i32, signal: i32) {
    if pid > 0 && pid as u32 != std::process::id() {
        unsafe { libc::kill(pid, signal) };
    }
}

/// Keeps this process's memory out of crash dumps, because `moss-db` reads database passwords.
/// The zero core limit stops dumps to a file. Linux also marks the process non-dumpable, so the
/// kernel makes no dump at all, not even for a crash-handler program that ignores the limit.
pub fn protect_from_crash_dumps() -> std::io::Result<()> {
    let none = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Whether `pid` runs `moss-db up` or `moss-db init`, the two commands that hold the install lock.
pub fn is_supervisor(pid: i32) -> bool {
    command_line(pid).is_some_and(|args| supervisor_args(&args))
}

pub fn supervisor_args(args: &[String]) -> bool {
    let program = args
        .first()
        .and_then(|first| Path::new(first).file_name())
        .and_then(|name| name.to_str());
    program == Some("moss-db") && matches!(args.get(1).map(String::as_str), Some("up" | "init"))
}

/// The command line stays readable when the process is non-dumpable.
#[cfg(target_os = "linux")]
fn command_line(pid: i32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let text = String::from_utf8_lossy(&raw);
    Some(
        text.split('\0')
            .filter(|arg| !arg.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// `ps` joins arguments with spaces. A program path holding a space therefore fails the check,
/// which errs towards signalling nothing.
#[cfg(target_os = "macos")]
fn command_line(pid: i32) -> Option<Vec<String>> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let args: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    (!args.is_empty()).then_some(args)
}

/// Whether a `postgres` process with these arguments belongs to the install.
pub fn belongs(args: &[&str], data: &Path, cluster: &str) -> bool {
    let data = data.to_string_lossy();
    let title = format!("postgres: {cluster}: ");
    args.windows(2)
        .any(|pair| pair[0] == "-D" && pair[1] == data)
        || args.first().is_some_and(|first| first.starts_with(&title))
}

/// Live processes of this user that belong to the install, as described in the module comment.
#[cfg(target_os = "linux")]
pub fn database_processes(data: &Path, cluster: &str) -> Vec<i32> {
    let Ok(data) = data.canonicalize() else {
        return Vec::new();
    };
    let uid = unsafe { libc::getuid() };
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if pid as u32 == std::process::id() {
            continue;
        }
        let dir = entry.path();
        let (Ok(status), Ok(cmdline)) = (
            std::fs::read_to_string(dir.join("status")),
            std::fs::read(dir.join("cmdline")),
        ) else {
            continue;
        };
        if !is_users_postgres(&status, uid) {
            continue;
        }
        let text = String::from_utf8_lossy(&cmdline);
        let args: Vec<&str> = text.split('\0').filter(|arg| !arg.is_empty()).collect();
        if belongs(&args, &data, cluster) {
            found.push(pid);
        }
    }
    found.sort_unstable();
    found
}

/// `/proc/<pid>/status`: `Name:` is the binary name and the first `Uid:` field the real user.
pub fn is_users_postgres(status: &str, uid: u32) -> bool {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
    };
    field("Name:") == Some("postgres")
        && field("Uid:")
            .and_then(|ids| ids.split_whitespace().next())
            .and_then(|id| id.parse::<u32>().ok())
            == Some(uid)
}

/// macOS: `ps` gives each process's user, accounting name and current title. Not compiled or
/// run in this spike because the Mac has no Rust toolchain. On the test Mac, `ps` showed every
/// server process with accounting name `postgres` and the `postgres: <cluster name>: ` title.
#[cfg(target_os = "macos")]
pub fn database_processes(data: &Path, cluster: &str) -> Vec<i32> {
    let Ok(data) = data.canonicalize() else {
        return Vec::new();
    };
    let uid = unsafe { libc::getuid() };
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,uid=,ucomm=,command="])
        .output()
    else {
        return Vec::new();
    };
    let data_text = data.to_string_lossy();
    let mut found = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(owner), Some("postgres")) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(owner)) = (pid.parse::<i32>(), owner.parse::<u32>()) else {
            continue;
        };
        // `ps` joins arguments with spaces, so the data folder is matched as a whole phrase.
        let command = parts.collect::<Vec<&str>>().join(" ");
        let names_data = command.contains(&format!(" -D {data_text} "))
            || command.ends_with(&format!(" -D {data_text}"));
        if owner == uid
            && pid as u32 != std::process::id()
            && (names_data || belongs(&[command.as_str()], &data, cluster))
        {
            found.push(pid);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA: &str = "/home/someone/.local/share/moss/db";

    #[test]
    fn postmaster_matches_on_its_data_folder() {
        let args = ["/opt/moss/pg/bin/postgres", "-D", DATA, "-c", "port=5432"];
        assert!(belongs(&args, Path::new(DATA), "moss-0123456789ab"));
        assert!(!belongs(
            &args,
            Path::new("/home/someone/.local/share/moss/db2"),
            "moss-0123456789ab"
        ));
    }

    #[test]
    fn server_processes_match_on_the_cluster_name() {
        let checkpointer = ["postgres: moss-0123456789ab: checkpointer "];
        assert!(belongs(&checkpointer, Path::new(DATA), "moss-0123456789ab"));
        assert!(!belongs(
            &checkpointer,
            Path::new(DATA),
            "moss-ffffffffffff"
        ));
        // Another install, or the machine's own Postgres, has a different title.
        assert!(!belongs(
            &["postgres: 17/main: checkpointer "],
            Path::new(DATA),
            "moss-0123456789ab"
        ));
        assert!(!belongs(
            &["postgres: checkpointer "],
            Path::new(DATA),
            "moss-0123456789ab"
        ));
    }

    #[test]
    fn only_up_and_init_count_as_a_supervisor() {
        let args = |text: &str| text.split(' ').map(str::to_string).collect::<Vec<_>>();
        assert!(supervisor_args(&args(
            "/opt/moss/bin/moss-db up --root /x --pg /y --repo /z"
        )));
        assert!(supervisor_args(&args("moss-db init --root /x --pg /y")));
        assert!(!supervisor_args(&args(
            "/opt/moss/bin/moss-db stop --root /x"
        )));
        assert!(!supervisor_args(&args("/usr/bin/sleep 600")));
        assert!(!supervisor_args(&args("/opt/not-moss-db up")));
        assert!(!supervisor_args(&[]));
    }

    #[test]
    fn this_test_process_is_not_a_supervisor() {
        assert!(!is_supervisor(std::process::id() as i32));
        assert!(!is_supervisor(i32::MAX));
    }

    #[test]
    fn status_must_be_this_users_postgres() {
        let status =
            "Name:\tpostgres\nUmask:\t0077\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n";
        assert!(is_users_postgres(status, 1000));
        assert!(!is_users_postgres(status, 1001));
        assert!(!is_users_postgres(
            &status.replace("postgres", "sleep"),
            1000
        ));
    }
}
