//! One window app per data folder, and the hand-off to it.
//!
//! A clicked desktop alert, or a second launch, writes an open request into the data folder.
//! The running window picks it up, switches to the saved server named in it and opens the page.
//! When no window is running, the program that took the click starts one.

use moss_network::config::{private_read, private_write};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::path::Path;

const LOCK: &str = "app.lock";
const REQUEST: &str = "open-request.json";
const STALE: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// The saved server to show. `None` only brings the window forward.
    pub server: Option<String>,
    /// A page inside that server, such as `/tasks`.
    pub path: Option<String>,
}

/// The same rule the server applies when it accepts a notification link. A page path stays on
/// the server's own origin, so no scheme, host or backslash is allowed.
pub fn valid_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains([':', '\\'])
        && !value.chars().any(char::is_control)
        && value.len() <= 2048
}

/// Takes the one-window lock. `None` means another window app holds it.
pub fn window_lock(data: &Path) -> Option<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join(LOCK))
        .ok()?;
    portability::file_lock::try_exclusive(&file).ok()?.then_some(file)
}

/// Whether a window app is running for this data folder.
pub fn window_running(data: &Path) -> bool {
    let Ok(file) = OpenOptions::new().create(true).truncate(false).write(true).open(data.join(LOCK))
    else {
        return false;
    };
    // Holding the lock here means nobody else does; it drops again on return.
    !portability::file_lock::try_exclusive(&file).unwrap_or(false)
}

pub fn write_request(data: &Path, request: &Request) -> Result<(), String> {
    if request.path.as_deref().is_some_and(|p| !valid_path(p)) {
        return Err("The link is not a page on the server".into());
    }
    let bytes = serde_json::to_vec(request).map_err(|_| "Cannot write the open request")?;
    private_write(&data.join(REQUEST), &bytes).map_err(|_| "Cannot write the open request".into())
}

/// Reads and removes the waiting request, if any. A damaged or unsafe one is dropped.
pub fn take_request(data: &Path) -> Option<Request> {
    let path = data.join(REQUEST);
    let bytes = private_read(&path).ok()?;
    let age = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| std::time::SystemTime::now().duration_since(t).ok());
    let _ = std::fs::remove_file(&path);
    // A request nobody picked up for a minute is stale; opening it later would surprise.
    if age.is_none_or(|a| a > STALE) {
        return None;
    }
    let request: Request = serde_json::from_slice(&bytes).ok()?;
    if request.path.as_deref().is_some_and(|p| !valid_path(p)) {
        return None;
    }
    Some(request)
}

/// Asks the running window to open a page, or starts a window that will.
pub fn open(data: &Path, request: &Request) -> Result<(), String> {
    write_request(data, request)?;
    if window_running(data) {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|_| "Cannot find the app")?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("--data")
        .arg(data)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ()).map_err(|_| "Cannot start the app".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("moss link {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn paths_must_stay_on_the_server() {
        for bad in ["", "tasks", "//evil.example", "/\\evil", "/a:b", "/a\nb", "https://x"] {
            assert!(!valid_path(bad), "{bad:?}");
        }
        assert!(valid_path("/tasks?open=1"));
        assert!(!valid_path(&format!("/{}", "a".repeat(2048))));
    }

    #[test]
    fn second_window_cannot_take_the_lock() {
        let dir = folder();
        assert!(!window_running(&dir));
        let first = window_lock(&dir).expect("first window");
        assert!(window_lock(&dir).is_none());
        assert!(window_running(&dir));
        drop(first);
        assert!(!window_running(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn request_is_taken_once_and_unsafe_ones_are_refused() {
        let dir = folder();
        let ask = Request { server: Some("s1".into()), path: Some("/tasks".into()) };
        write_request(&dir, &ask).unwrap();
        assert_eq!(take_request(&dir), Some(ask));
        assert_eq!(take_request(&dir), None);
        let evil = Request { server: Some("s1".into()), path: Some("//evil.example".into()) };
        assert!(write_request(&dir, &evil).is_err());
        std::fs::write(dir.join(REQUEST), br#"{"server":"s1","path":"//evil.example"}"#).unwrap();
        assert_eq!(take_request(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
