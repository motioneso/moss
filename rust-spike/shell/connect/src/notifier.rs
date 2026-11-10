//! The notifier: a headless copy of the app that keeps showing desktop alerts after the window
//! is closed. It reads `notifier.json` from the app's data folder, polls each enrolled server
//! with its own scoped device token and records acceptance so no alert shows twice.

use crate::reach;
use moss_network::config::{private_read, private_write};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FILE: &str = "notifier.json";
const LOCK: &str = "notifier.lock";
/// The window app touches this while it is open and showing a server's alerts itself.
const ACTIVE: &str = "app-active.json";
const FRESH: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub server: String,
    pub origin: String,
    pub pin: String,
    pub client: String,
    pub token: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrolled {
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Notice {
    id: String,
    title: String,
    body: Option<String>,
    href: Option<String>,
}

#[derive(Deserialize)]
struct Feed {
    acknowledged: Vec<String>,
    notices: Vec<Notice>,
}

fn load(data: &Path) -> Enrolled {
    private_read(&data.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Adds or replaces the entry for a server. The file holds tokens, so it is private.
pub fn enroll(data: &Path, entry: Entry) -> Result<(), String> {
    let mut all = load(data);
    all.entries.retain(|e| e.server != entry.server);
    all.entries.push(entry);
    let bytes = serde_json::to_vec(&all).map_err(|_| "Cannot write the notifier list")?;
    private_write(&data.join(FILE), &bytes).map_err(|_| "Cannot write the notifier list".into())
}

pub fn forget(data: &Path, server: &str) -> Result<(), String> {
    let mut all = load(data);
    all.entries.retain(|e| e.server != server);
    let bytes = serde_json::to_vec(&all).map_err(|_| "Cannot write the notifier list")?;
    private_write(&data.join(FILE), &bytes).map_err(|_| "Cannot write the notifier list".into())
}

/// Marks that the window shows alerts for this server, so the notifier leaves it alone.
pub fn mark_app_active(data: &Path, server: &str) {
    let _ = std::fs::write(data.join(ACTIVE), server);
}

fn app_active_for(data: &Path, server: &str) -> bool {
    let path = data.join(ACTIVE);
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < FRESH);
    fresh && std::fs::read_to_string(path).is_ok_and(|s| s == server)
}

/// Holds the lock for the life of the process. A second notifier finds it taken and exits.
fn single_instance(data: &Path) -> Option<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join(LOCK))
        .ok()?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: the descriptor is valid for the lifetime of `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return None;
        }
    }
    Some(file)
}

/// Starts the notifier beside the app. If one is already running it finds the lock taken and
/// exits at once. It outlives the app.
pub fn spawn(data: &Path) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = std::process::Command::new(exe);
    command
        .args(["notifier", "run", "--data"])
        .arg(data)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let _ = command.spawn();
}

/// Runs until killed. `once` polls one round and returns, for tests.
pub fn run(data: PathBuf, once: bool) -> i32 {
    let Some(_lock) = single_instance(&data) else {
        return 0;
    };
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let mut seen: HashSet<(String, String)> = HashSet::new();
    loop {
        for entry in load(&data).entries {
            if app_active_for(&data, &entry.server) {
                continue;
            }
            runtime.block_on(poll(&entry, &mut seen));
        }
        if once {
            return 0;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

async fn poll(entry: &Entry, seen: &mut HashSet<(String, String)>) {
    let path = format!("/api/notifier/notices?client={}", entry.client);
    let Ok((200, body)) =
        reach::request(&entry.origin, &entry.pin, "GET", &path, &entry.token, None).await
    else {
        return;
    };
    let Ok(feed) = serde_json::from_slice::<Feed>(&body) else {
        return;
    };
    let mut shown = Vec::new();
    for notice in feed.notices {
        if feed.acknowledged.contains(&notice.id) {
            continue;
        }
        let text = notice.body.clone().unwrap_or_default();
        let key = (entry.server.clone(), notice.id.clone());
        // A failed acceptance last round must not show the same alert twice.
        if seen.contains(&key) || crate::desktop::notify(&notice.title, &text).is_ok() {
            seen.insert(key);
            shown.push(notice.id);
        }
        let _ = notice.href;
    }
    if shown.is_empty() {
        return;
    }
    let body = serde_json::json!({"client": entry.client, "events": shown}).to_string();
    let accepted = reach::request(
        &entry.origin,
        &entry.pin,
        "POST",
        &path,
        &entry.token,
        Some(&body),
    )
    .await;
    // The notice is in `seen` until the server agrees; after that the receipt carries it.
    if !matches!(accepted, Ok((200, _))) {
        eprintln!("moss-app notifier: the server did not accept the receipt ({:?})", accepted.as_ref().map(|(c, _)| *c));
    }
    if matches!(accepted, Ok((200, _))) {
        seen.retain(|(s, id)| !(s == &entry.server && shown.contains(id)));
    }
}

/// `moss-app notifier [run|once|add|forget]`, with `--data <folder>`.
pub fn command(args: Vec<String>) -> i32 {
    let mut sub = String::from("run");
    let mut data: Option<PathBuf> = None;
    let mut fields = std::collections::HashMap::new();
    let mut raw = args.into_iter().peekable();
    if raw.peek().is_some_and(|a| !a.starts_with("--")) {
        sub = raw.next().unwrap_or_default();
    }
    while let Some(flag) = raw.next() {
        let Some(value) = raw.next() else {
            eprintln!("moss-app: {flag} needs a value");
            return 2;
        };
        match flag.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            other => {
                fields.insert(other.trim_start_matches("--").to_owned(), value);
            }
        }
    }
    let data = match data
        .or_else(crate::store::default_data_dir)
        .and_then(|d| std::path::absolute(d).ok())
    {
        Some(d) => d,
        None => {
            eprintln!("moss-app: no data folder");
            return 2;
        }
    };
    match sub.as_str() {
        "run" => run(data, false),
        "once" => run(data, true),
        "add" => {
            let get = |k: &str| fields.get(k).cloned().unwrap_or_default();
            let entry = Entry {
                server: get("server"),
                origin: get("origin"),
                pin: get("pin"),
                client: get("client"),
                token: get("token"),
            };
            if entry.server.is_empty() || entry.origin.is_empty() || entry.token.is_empty() {
                eprintln!("moss-app: add needs --server, --origin, --pin, --client and --token");
                return 2;
            }
            match enroll(&data, entry) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("moss-app: {e}");
                    1
                }
            }
        }
        "forget" => match forget(&data, fields.get("server").map_or("", String::as_str)) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("moss-app: {e}");
                1
            }
        },
        _ => {
            eprintln!("moss-app: unknown notifier command {sub}");
            2
        }
    }
}
