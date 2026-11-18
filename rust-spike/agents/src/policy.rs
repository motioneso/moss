//! Permission policy for the agent's own tools. Port of `packages/acp/src/permissions.ts` and
//! `tool-table.ts`; the parity check feeds both the same cases.
//!
//! Identity comes only from the real tool name, never the display title:
//!
//! - no name, or a name outside the table: refuse, nobody is asked;
//! - mode changes and tools never offered (subagents, skills, self-scheduling): refuse;
//! - Moss's own tools: allow, the tool gateway decides the real call;
//! - reads: inside the session folder allow, secret-shaped names ask, the forbidden zone
//!   (agent home, /proc, /sys, /dev, /run) refuses, anywhere else asks;
//! - web: fetches allow except loopback, private ranges and bare hostnames, which ask;
//! - writes: inside allow, forbidden zone refuses, elsewhere asks;
//! - shell: always asks.
//!
//! Containment is lexical, as in the TypeScript: a link inside the folder is not resolved.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Family {
    Read,
    Web,
    Harmless,
    Write,
    Shell,
    Mode,
    NotOffered,
    Moss,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyReason {
    UnknownTool,
    NotOffered,
    ForbiddenZone,
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "verdict", rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Ask,
    Deny { reason: DenyReason },
}

const MOSS_PREFIX: &str = "mcp__moss__";

/// The one tool table. Claude names match the TypeScript table exactly. Codex approvals are
/// mapped onto `Bash` and `Edit` by the driver. OpenCode's lowercase names are added here.
const TABLE: &[(&str, Family)] = &[
    ("Read", Family::Read),
    ("NotebookRead", Family::Read),
    ("LS", Family::Read),
    ("Glob", Family::Read),
    ("Grep", Family::Read),
    ("mcp__acp__Read", Family::Read),
    ("WebFetch", Family::Web),
    ("WebSearch", Family::Web),
    ("TodoWrite", Family::Harmless),
    ("BashOutput", Family::Harmless),
    ("mcp__acp__BashOutput", Family::Harmless),
    ("Write", Family::Write),
    ("Edit", Family::Write),
    ("MultiEdit", Family::Write),
    ("NotebookEdit", Family::Write),
    ("mcp__acp__Write", Family::Write),
    ("mcp__acp__Edit", Family::Write),
    ("Bash", Family::Shell),
    ("KillShell", Family::Shell),
    ("mcp__acp__Bash", Family::Shell),
    ("mcp__acp__KillShell", Family::Shell),
    ("ExitPlanMode", Family::Mode),
    ("EnterPlanMode", Family::Mode),
    ("Task", Family::NotOffered),
    ("Skill", Family::NotOffered),
    ("SlashCommand", Family::NotOffered),
    ("AskUserQuestion", Family::NotOffered),
    ("ScheduleWakeup", Family::NotOffered),
    ("CronCreate", Family::NotOffered),
    ("CronDelete", Family::NotOffered),
    ("CronList", Family::NotOffered),
    ("RemoteTrigger", Family::NotOffered),
    ("Monitor", Family::NotOffered),
];

/// OpenCode's own tool names. Not in the TypeScript table: today's Node path never saw them.
const OPENCODE_TABLE: &[(&str, Family)] = &[
    ("read", Family::Read),
    ("list", Family::Read),
    ("glob", Family::Read),
    ("grep", Family::Read),
    ("webfetch", Family::Web),
    ("websearch", Family::Web),
    ("todowrite", Family::Harmless),
    ("todoread", Family::Harmless),
    ("write", Family::Write),
    ("edit", Family::Write),
    ("patch", Family::Write),
    ("bash", Family::Shell),
    ("task", Family::NotOffered),
    ("skill", Family::NotOffered),
];

pub fn family(name: &str) -> Family {
    if let Some((_, f)) = TABLE.iter().find(|(n, _)| *n == name) {
        return *f;
    }
    if name.starts_with(MOSS_PREFIX) && name.len() > MOSS_PREFIX.len() {
        return Family::Moss;
    }
    // OpenCode reports Moss's tools as `moss_<tool>`.
    if name.starts_with("moss_") && name.len() > "moss_".len() {
        return Family::Moss;
    }
    OPENCODE_TABLE
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, f)| *f)
        .unwrap_or(Family::Unknown)
}

/// What one ask carries into the decision.
#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub tool_name: Option<&'a str>,
    pub raw_input: &'a Value,
    /// Announced file locations (ACP), checked alongside the input's own paths.
    pub locations: &'a [String],
}

pub struct Folders<'a> {
    pub cwd: &'a Path,
    pub home: Option<&'a Path>,
}

const PATH_KEYS: [&str; 3] = ["file_path", "notebook_path", "path"];

/// Paths named by a tool input, under the keys every agent uses.
pub fn paths_in(input: &Value) -> Vec<String> {
    PATH_KEYS
        .iter()
        .filter_map(|k| input.get(*k).and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn extract_paths(req: &Request) -> Vec<String> {
    let mut out = paths_in(req.raw_input);
    out.extend(req.locations.iter().cloned());
    out
}

fn extract_web_address(req: &Request) -> Option<String> {
    req.raw_input
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// `path.resolve` without touching the filesystem: join, then fold `.` and `..`.
fn resolve(base: &Path, target: &str) -> PathBuf {
    let joined = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        base.join(target)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push("/");
    }
    out
}

fn is_under(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

pub fn is_inside_session_folder(cwd: &Path, target: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }
    let root = resolve(Path::new("/"), &cwd.to_string_lossy());
    is_under(&root, &resolve(&root, target))
}

const FORBIDDEN_PREFIXES: [&str; 4] = ["/proc", "/sys", "/dev", "/run"];

fn in_forbidden_zone(abs: &Path, home: Option<&Path>) -> bool {
    if let Some(h) = home {
        if !h.as_os_str().is_empty() && is_under(&resolve(Path::new("/"), &h.to_string_lossy()), abs) {
            return true;
        }
    }
    FORBIDDEN_PREFIXES.iter().any(|p| abs.starts_with(p))
}

fn is_secret_shaped(abs: &Path) -> bool {
    let base = abs.file_name().map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
    base == ".env"
        || base.starts_with(".env.")
        || base.ends_with(".pem")
        || base.ends_with(".key")
        || base.ends_with(".p12")
        || base.starts_with("id_rsa")
        || base == ".npmrc"
        || base == ".netrc"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Zone {
    None,
    Inside,
    InsideSecret,
    Outside,
    Forbidden,
}

fn classify_zone(paths: &[String], folders: &Folders) -> Zone {
    let named: Vec<&String> = paths.iter().filter(|p| !p.trim().is_empty()).collect();
    if named.is_empty() {
        return Zone::None;
    }
    let root = resolve(Path::new("/"), &folders.cwd.to_string_lossy());
    let mut worst = Zone::Inside;
    for target in named {
        let abs = if let Some(rest) = target.strip_prefix('~') {
            let rest = if rest.is_empty() {
                Some("")
            } else {
                rest.strip_prefix('/')
            };
            match (rest, folders.home) {
                (Some(r), Some(h)) if !h.as_os_str().is_empty() => resolve(h, r),
                _ => return Zone::Forbidden,
            }
        } else {
            resolve(&root, target)
        };
        if !is_under(&root, &abs) {
            if in_forbidden_zone(&abs, folders.home) {
                return Zone::Forbidden;
            }
            worst = Zone::Outside;
        } else if worst == Zone::Inside && is_secret_shaped(&abs) {
            worst = Zone::InsideSecret;
        }
    }
    worst
}

const READ_NEEDS_TARGET: [&str; 4] = ["Read", "mcp__acp__Read", "NotebookRead", "read"];

fn classify_read(name: &str, paths: &[String], folders: &Folders) -> Decision {
    match classify_zone(paths, folders) {
        Zone::Forbidden => Decision::Deny {
            reason: DenyReason::ForbiddenZone,
        },
        Zone::None if READ_NEEDS_TARGET.contains(&name) => Decision::Deny {
            reason: DenyReason::Malformed,
        },
        Zone::None | Zone::Inside => Decision::Allow,
        _ => Decision::Ask,
    }
}

fn classify_write(paths: &[String], folders: &Folders) -> Decision {
    match classify_zone(paths, folders) {
        Zone::Forbidden => Decision::Deny {
            reason: DenyReason::ForbiddenZone,
        },
        Zone::Inside => Decision::Allow,
        _ => Decision::Ask,
    }
}

/// Loopback, private ranges, link-local and bare hostnames ask; public addresses fetch.
pub fn is_private_web_address(address: &str) -> bool {
    let Some(mut host) = host_of(address) else {
        return true;
    };
    if host.starts_with('[') && host.ends_with(']') {
        host = host[1..host.len() - 1].to_string();
    }
    if host.is_empty() || host == "localhost" {
        return true;
    }
    if host.contains(':') {
        return host == "::1"
            || host == "::"
            || host.starts_with("fc")
            || host.starts_with("fd")
            || ["fe8", "fe9", "fea", "feb"].iter().any(|p| host.starts_with(p));
    }
    if ["127.", "10.", "0.", "192.168.", "169.254."].iter().any(|p| host.starts_with(p)) {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(n) = rest.split('.').next().and_then(|n| n.parse::<u32>().ok()) {
            if (16..=31).contains(&n) && rest.contains('.') {
                return true;
            }
        }
    }
    !host.contains('.')
}

/// The WHATWG URL hostname, for the forms agents send. Anything unparseable is `None`.
fn host_of(address: &str) -> Option<String> {
    let (scheme, rest) = address.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        let end = host_port.find(']')?;
        &host_port[..=end]
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    if host.is_empty() && matches!(scheme, "http" | "https") {
        return None;
    }
    let mut host = host.to_lowercase();
    // URL parsing turns a trailing-dot or decimal host into its canonical form; agents send
    // ordinary names, so only the trailing dot is folded here.
    if host.ends_with('.') && host.len() > 1 {
        host.pop();
    }
    Some(host)
}

fn classify_web(name: &str, req: &Request) -> Decision {
    if name == "WebSearch" || name == "websearch" {
        return Decision::Allow;
    }
    match extract_web_address(req) {
        None => Decision::Deny {
            reason: DenyReason::Malformed,
        },
        Some(a) if is_private_web_address(&a) => Decision::Ask,
        Some(_) => Decision::Allow,
    }
}

pub fn classify(req: &Request, folders: &Folders) -> Decision {
    let Some(name) = req.tool_name else {
        return Decision::Deny {
            reason: DenyReason::UnknownTool,
        };
    };
    match family(name) {
        Family::Unknown => Decision::Deny {
            reason: DenyReason::UnknownTool,
        },
        Family::Mode | Family::NotOffered => Decision::Deny {
            reason: DenyReason::NotOffered,
        },
        Family::Moss | Family::Harmless => Decision::Allow,
        Family::Shell => Decision::Ask,
        Family::Write => classify_write(&extract_paths(req), folders),
        Family::Web => classify_web(name, req),
        Family::Read => classify_read(name, &extract_paths(req), folders),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decide(name: Option<&str>, input: Value) -> Decision {
        let folders = Folders {
            cwd: Path::new("/srv/acct/work"),
            home: Some(Path::new("/srv/acct/home")),
        };
        classify(
            &Request {
                tool_name: name,
                raw_input: &input,
                locations: &[],
            },
            &folders,
        )
    }

    #[test]
    fn unknown_and_unnamed_tools_are_refused() {
        let unknown = Decision::Deny {
            reason: DenyReason::UnknownTool,
        };
        assert_eq!(decide(None, json!({})), unknown);
        assert_eq!(decide(Some("Frobnicate"), json!({})), unknown);
        assert_eq!(decide(Some("mcp__moss__"), json!({})), unknown);
    }

    #[test]
    fn reads_inside_allow_and_forbidden_zone_refuses() {
        assert_eq!(decide(Some("Read"), json!({"file_path": "notes.md"})), Decision::Allow);
        assert_eq!(decide(Some("Read"), json!({"file_path": ".env"})), Decision::Ask);
        assert_eq!(decide(Some("Read"), json!({"file_path": "/etc/hosts"})), Decision::Ask);
        let forbidden = Decision::Deny {
            reason: DenyReason::ForbiddenZone,
        };
        assert_eq!(decide(Some("Read"), json!({"file_path": "/proc/self/environ"})), forbidden);
        assert_eq!(decide(Some("Read"), json!({"file_path": "~/.codex/auth.json"})), forbidden);
        assert_eq!(decide(Some("Read"), json!({"file_path": "../../acct/home/x"})), forbidden);
        assert_eq!(decide(Some("Read"), json!({"file_path": "~other/x"})), forbidden);
    }

    #[test]
    fn shell_always_asks_and_moss_tools_pass_to_the_gateway() {
        assert_eq!(decide(Some("Bash"), json!({"command": "ls"})), Decision::Ask);
        assert_eq!(decide(Some("bash"), json!({"command": "ls"})), Decision::Ask);
        assert_eq!(decide(Some("mcp__moss__today"), json!({})), Decision::Allow);
    }

    #[test]
    fn private_web_addresses_ask() {
        assert!(is_private_web_address("http://localhost:3000"));
        assert!(is_private_web_address("http://192.168.1.4/"));
        assert!(is_private_web_address("http://172.20.0.1/"));
        assert!(is_private_web_address("http://intranet/"));
        assert!(is_private_web_address("http://[::1]/"));
        assert!(is_private_web_address("not a url"));
        assert!(!is_private_web_address("https://example.com/a"));
        assert!(!is_private_web_address("https://172.32.0.1/"));
    }
}
