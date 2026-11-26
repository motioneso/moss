//! The operating system firewall rule that lets other devices reach the server.
//!
//! Sharing opens one rule scoped to this server program and its port, and closing sharing
//! removes it. The rule is changed by `moss-server firewall-rule`, run with the owner's
//! approval from the operating system's own prompt. A record in the instance folder names the
//! rule that is open, so turning sharing off or removing the instance always finds it.
//!
//! Moss only ever touches a rule it can prove it made. The live rule carries the proof. The
//! Windows rule name and the ufw comment are `moss-<instance>-<token>`, the firewalld service
//! file `moss-<instance>.xml` holds the token in its description, and the macOS entry is Moss's
//! own server path, removed only when the record shows Moss added it. The local record alone
//! never proves ownership. Every delete looks the live rule up by that marker first, and a
//! lookup that cannot give a clear answer is an error, never "gone".

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const RECORD_FILE: &str = "firewall.json";
/// Installer receipt for an already-loaded, per-instance firewalld service. Not a secret.
pub const FIREWALLD_RECEIPT_FILE: &str = "firewalld-service.json";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstalledService {
    service: String,
    token: String,
    port: u16,
}
/// Environment variable that replaces the operating system prompt with a scripted answer. The
/// script receives the exact helper command and decides to run it or to exit 126 (declined).
pub const STAND_IN_ENV: &str = "MOSS_FIREWALL_STAND_IN";
/// The helper exits with this when the rule could not be changed.
pub const EXIT_FAILED: i32 = 3;
/// A failed add whose rollback could not be confirmed. The rule may still be open.
pub const EXIT_STUCK: i32 = 4;
/// The rule was already open before this add, so it belongs to someone else and stays on remove.
pub const EXIT_ALREADY: i32 = 5;
/// A rule with this name is already in the firewall and Moss did not create it.
pub const EXIT_FOREIGN: i32 = 6;
/// No supported firewall manager was found, so Moss cannot open or verify a rule.
pub const EXIT_NO_MANAGER: i32 = 7;
pub const EXIT_SERVICE_UNAVAILABLE: i32 = 8;
const STUCK: &str = "The firewall rule could not be taken back";
const FOREIGN: &str = "A firewall rule with this name exists and Moss did not create it";
const NO_MANAGER: &str = "No supported firewall manager was found";
const SERVICE_UNAVAILABLE: &str = "Reinstall Moss or restart the firewall";
const PROMPT_LIMIT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Add,
    Remove,
    Check,
}

impl Action {
    pub fn word(self) -> &'static str {
        match self {
            Action::Add => "add",
            Action::Remove => "remove",
            Action::Check => "check",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub name: String,
    pub port: u16,
    pub program: PathBuf,
    /// The firewalld zone the rule was opened in, so removal targets the same zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    /// Marks the Windows rule as Moss's own. It is written into the rule's description and read
    /// back before a delete, so a rule that only shares the name, port and program stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// The Linux firewall manager used at add time. Removal uses the same one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manager: Option<String>,
    /// The firewalld service name (`moss-<instance>`). Its file holds the token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// macOS only. True when Moss added the application firewall entry, false when the entry
    /// was already there. Removal runs only when this is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_added: Option<bool>,
}

/// A firewalld service command. `op` is `add`, `remove` or `query`.
fn firewalld(rule: &Rule, permanent: bool, op: &str) -> Vec<String> {
    let mut args = vec!["firewall-cmd".to_owned()];
    if permanent {
        args.push("--permanent".into());
    }
    if let Some(zone) = &rule.zone {
        args.push(format!("--zone={zone}"));
    }
    match service_name(rule) {
        Some(service) => args.push(format!("--{op}-service={service}")),
        None => args.push(format!("--{op}-port={}/tcp", rule.port)),
    }
    args
}

/// The firewalld service for a rule. Moss owns `moss-<instance>`; its file holds the token.
fn service_name(rule: &Rule) -> Option<String> {
    if let Some(service) = &rule.service {
        return Some(service.clone());
    }
    // Marker names are moss-<instance>-<token>. Dropping the last part names the service.
    let rest = rule
        .name
        .strip_prefix("moss-")
        .or_else(|| rule.name.strip_prefix("Moss-"))?;
    let instance = rest.rsplit_once('-').map_or(rest, |(head, _)| head);
    if instance.is_empty() {
        return None;
    }
    Some(format!("moss-{instance}"))
}

fn service_path(rule: &Rule) -> Option<PathBuf> {
    let service = service_name(rule)?;
    let dir = cfg!(test)
        .then(|| std::env::var_os("MOSS_FIREWALLD_SERVICE_DIR"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/etc/firewalld/services"));
    Some(dir.join(format!("{service}.xml")))
}

fn service_xml(rule: &Rule) -> Option<String> {
    let service = service_name(rule)?;
    let token = rule.token.as_deref()?;
    Some(format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<service>\n  <short>{service}</short>\n  <description>{token}</description>\n  <port port=\"{}\" protocol=\"tcp\"/>\n</service>\n",
        rule.port
    ))
}

/// Whether service file text proves this rule is Moss's. The token and the port must both match.
fn service_file_is_ours(text: &str, rule: &Rule) -> bool {
    service_xml(rule).is_some_and(|expected| text == expected)
}

/// The runtime catalog must carry the same token and the one TCP port, with no extra grants.
fn service_info_is_ours(text: &str, rule: &Rule) -> bool {
    let Some(service) = service_name(rule) else {
        return false;
    };
    let Some(token) = rule.token.as_deref() else {
        return false;
    };
    let mut lines = text.lines();
    if lines.next() != Some(service.as_str()) {
        return false;
    }
    let mut fields = std::collections::BTreeMap::new();
    for line in lines {
        let Some((key, value)) = line.trim().split_once(':') else {
            return false;
        };
        if fields.insert(key, value.trim()).is_some() {
            return false;
        }
    }
    fields.get("description") == Some(&token)
        && fields.get("ports") == Some(&format!("{}/tcp", rule.port).as_str())
        && fields.iter().all(|(key, value)| match *key {
            "description" | "ports" => true,
            "short" => *value == service,
            "protocols" | "source-ports" | "modules" | "destination" | "includes" | "helpers" => {
                value.is_empty()
            }
            _ => false,
        })
}

fn service_loaded(rule: &Rule) -> Result<(), &'static str> {
    let service = service_name(rule).ok_or(SERVICE_UNAVAILABLE)?;
    match run_code(&cmd(&[
        "firewall-cmd",
        &format!("--info-service={service}"),
        "--verbose",
    ])) {
        Some((0, text)) if service_info_is_ours(&text, rule) => Ok(()),
        _ => Err(SERVICE_UNAVAILABLE),
    }
}

impl Rule {
    /// Names and paths reach operating system commands, so only plain values are accepted.
    pub fn check(&self) -> Result<(), &'static str> {
        let plain = |c: char| c.is_ascii_alphanumeric() || "-_.".contains(c);
        if !(self.name.starts_with("moss-") || self.name.starts_with("Moss-")) {
            return Err("The rule name must start with moss-");
        }
        if self.name.is_empty() || self.name.len() > 96 || !self.name.chars().all(plain) {
            return Err("The rule name must be short and plain");
        }
        if let Some(service) = &self.service {
            if !service.starts_with("moss-")
                || service.is_empty()
                || service.len() > 64
                || !service.chars().all(plain)
            {
                return Err("The firewall service must be short and plain");
            }
        }
        if let Some(zone) = &self.zone {
            if zone.is_empty() || zone.len() > 64 || !zone.chars().all(plain) {
                return Err("The firewall zone must be short and plain");
            }
        }
        if let Some(token) = &self.token {
            if token.is_empty() || token.len() > 64 || !token.chars().all(plain) {
                return Err("The rule token must be short and plain");
            }
        }
        if !matches!(
            self.manager.as_deref(),
            None | Some("ufw") | Some("firewalld")
        ) {
            return Err("The firewall manager is not supported");
        }
        if self.port == 0 {
            return Err("The rule needs a port");
        }
        if !self.program.is_absolute() || !self.program.is_file() {
            return Err("The rule program must be an existing absolute path");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

pub fn this_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Linux
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Linux {
    Firewalld,
    Ufw,
    /// No firewall manager is installed, so nothing blocks the port.
    Nothing,
}

const SOCKET_FILTER: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";

fn cmd(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

/// The operating system commands that change the rule. Each inner list is one command. Delete
/// commands may fail when no rule exists, so the read-back decides.
pub fn plan(os: Os, linux: Linux, action: Action, rule: &Rule) -> Vec<Vec<String>> {
    if action == Action::Check {
        return Vec::new();
    }
    let port = rule.port.to_string();
    let program = rule.program.display().to_string();
    match os {
        Os::Windows => match action {
            Action::Check => Vec::new(),
            // A rule already holding this name is refused before this runs, so add never
            // replaces one it did not create.
            Action::Add => vec![cmd(&[
                "netsh",
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name={}", rule.name),
                "dir=in",
                "action=allow",
                "protocol=TCP",
                &format!("localport={port}"),
                &format!("program={program}"),
                "enable=yes",
                &format!("description={}", rule.token.as_deref().unwrap_or("Moss")),
            ])],
            // Only a rule with this name, port and program goes, never another one by name.
            Action::Remove => vec![cmd(&[
                "netsh",
                "advfirewall",
                "firewall",
                "delete",
                "rule",
                &format!("name={}", rule.name),
                "protocol=TCP",
                &format!("localport={port}"),
                &format!("program={program}"),
            ])],
        },
        Os::Mac => match action {
            Action::Check => Vec::new(),
            Action::Add => vec![
                cmd(&[SOCKET_FILTER, "--add", &program]),
                cmd(&[SOCKET_FILTER, "--unblockapp", &program]),
            ],
            Action::Remove => vec![cmd(&[SOCKET_FILTER, "--remove", &program])],
        },
        Os::Linux => match (linux, action) {
            (_, Action::Check) => Vec::new(),
            (Linux::Firewalld, Action::Add) => {
                vec![firewalld(rule, true, "add"), firewalld(rule, false, "add")]
            }
            (Linux::Firewalld, Action::Remove) => vec![
                firewalld(rule, true, "remove"),
                firewalld(rule, false, "remove"),
            ],
            // The comment carries the marker, so a later delete can prove the rule is Moss's.
            (Linux::Ufw, Action::Add) => vec![cmd(&[
                "ufw", "allow", "in", "proto", "tcp", "to", "any", "port", &port, "comment",
                &rule.name,
            ])],
            (Linux::Ufw, Action::Remove) => vec![cmd(&[
                "ufw", "delete", "allow", "in", "proto", "tcp", "to", "any", "port", &port,
            ])],
            (Linux::Nothing, _) => Vec::new(),
        },
    }
}

/// Commands that read the rule back. They report whether the rule exists.
fn present_query(os: Os, linux: Linux, rule: &Rule) -> Option<(Vec<String>, Option<String>)> {
    let port = rule.port.to_string();
    match os {
        Os::Windows => Some((
            cmd(&[
                "netsh",
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={}", rule.name),
            ]),
            None,
        )),
        Os::Mac => Some((
            cmd(&[SOCKET_FILTER, "--listapps"]),
            Some(rule.program.display().to_string()),
        )),
        Os::Linux => match linux {
            Linux::Firewalld => Some((firewalld(rule, true, "query"), None)),
            Linux::Ufw => Some((
                cmd(&["ufw", "show", "added"]),
                Some(format!("allow {port}/tcp")),
            )),
            Linux::Nothing => None,
        },
    }
}

/// Runs a command and returns its exit code and output. `None` when it did not run or was killed.
fn run_code(args: &[String]) -> Option<(i32, String)> {
    use std::io::Read;
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            pipe.by_ref().take(1_048_577).read_to_end(&mut bytes).ok()?;
            (bytes.len() <= 1_048_576).then_some(bytes)
        })();
        let _ = send.send(result);
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if start.elapsed() < Duration::from_secs(30) => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }?;
    let bytes = receive
        .recv_timeout(Duration::from_secs(30).saturating_sub(start.elapsed()))
        .ok()??;
    Some((code, String::from_utf8(bytes).ok()?))
}

fn output(args: &[String]) -> Option<(bool, String)> {
    run_code(args).map(|(code, text)| (code == 0, text))
}

fn detect_linux() -> Linux {
    if output(&cmd(&["firewall-cmd", "--state"]))
        .is_some_and(|(ok, text)| ok && text.trim() == "running")
    {
        Linux::Firewalld
    } else if output(&cmd(&["ufw", "version"])).is_some_and(|(ok, _)| ok) {
        Linux::Ufw
    } else {
        Linux::Nothing
    }
}

/// Whether the rule is in the system. `None` means the answer could not be read. Firewalld is
/// asked about both its saved and its live rules, because either one keeps the port open.
fn exists(os: Os, linux: Linux, rule: &Rule) -> Option<bool> {
    let (query, needle) = present_query(os, linux, rule)?;
    let read = |query: &[String]| {
        let (code, text) = run_code(query)?;
        match &needle {
            // A listing that failed to run says nothing about the rule.
            Some(needle) if os == Os::Linux && linux == Linux::Ufw => (code == 0
                && text.starts_with("Added user rules"))
            .then(|| !ufw_lines(&text, rule).is_empty()),
            Some(_) if os == Os::Mac => (code == 0)
                .then(|| {
                    mac_paths(&text)
                        .map(|paths| paths.contains(&rule.program.to_string_lossy().as_ref()))
                })
                .flatten(),
            Some(needle) => (code == 0).then(|| text.contains(needle)),
            // netsh answers 0 for a match and 1 for none. Any other code means it could not say.
            None if os == Os::Windows => match code {
                0 => Some(true),
                1 if text.trim() == "No rules match the specified criteria." => Some(false),
                _ => None,
            },
            // Firewalld answers 0 for yes and 1 for no. Any other code means it could not say.
            None => firewalld_answer(code, &text),
        }
    };
    let saved = read(&query)?;
    if linux == Linux::Firewalld && os == Os::Linux {
        let live = read(&firewalld(rule, false, "query"))?;
        return Some(saved || live);
    }
    Some(saved)
}

/// Runs the operating system commands. This is the privileged step; callers reach it through
/// the elevated helper. The rule is read back, and a failed add is removed again. Returns true
/// when the rule was already open before an add, which then leaves it as it found it.
pub fn apply(action: Action, rule: &Rule) -> Result<bool, &'static str> {
    rule.check()?;
    if this_os() == Os::Linux && action == Action::Remove && rule.manager.is_none() {
        return Err("The firewall could not be read");
    }
    let linux = if this_os() == Os::Linux {
        match rule.manager.as_deref() {
            Some("ufw") => Linux::Ufw,
            Some("firewalld") => Linux::Firewalld,
            _ => detect_linux(),
        }
    } else {
        Linux::Nothing
    };
    apply_with(this_os(), linux, action, rule)
}

fn firewalld_answer(code: i32, text: &str) -> Option<bool> {
    match (code, text.trim()) {
        (0, "yes") => Some(true),
        (1, "no") => Some(false),
        _ => None,
    }
}

/// Saved and live firewalld state for the port. Either one keeps it open.
fn firewalld_halves(rule: &Rule) -> Option<(bool, bool)> {
    let query = |permanent: bool| {
        let (code, text) = run_code(&firewalld(rule, permanent, "query"))?;
        firewalld_answer(code, &text)
    };
    Some((query(true)?, query(false)?))
}

fn apply_with(os: Os, linux: Linux, action: Action, rule: &Rule) -> Result<bool, &'static str> {
    if os == Os::Linux && linux == Linux::Nothing {
        // Without a manager an add cannot be verified and a remove cannot be confirmed.
        return Err(NO_MANAGER);
    }
    let queryable = present_query(os, linux, rule).is_some();
    if action == Action::Remove && !owned(os, linux, rule)? {
        // Not Moss's rule, or already gone. Nothing is deleted.
        return Ok(false);
    }
    if action == Action::Add {
        match (os, linux) {
            // Only a rule Moss created may carry its marker name.
            (Os::Windows, _) => match exists(os, linux, rule) {
                Some(false) => {}
                Some(true) => return Err(FOREIGN),
                None => return Err("The firewall could not be read"),
            },
            (Os::Linux, Linux::Firewalld) => {
                match firewalld_mark(rule) {
                    ServiceMark::Ours => {}
                    ServiceMark::Foreign => return Err(FOREIGN),
                    ServiceMark::Missing => return Err(SERVICE_UNAVAILABLE),
                    ServiceMark::Unreadable => return Err("The firewall could not be read"),
                }
                service_loaded(rule)?;
                // An assignment that predates this add is not ours to remove.
                match firewalld_halves(rule) {
                    Some((false, false)) => {}
                    Some(_) => return Ok(true),
                    None => return Err("The firewall could not be read"),
                }
            }
            // The add and any rollback only touch a rule known to be absent before.
            _ => match exists(os, linux, rule) {
                Some(true) => return Ok(true),
                Some(false) => {}
                None => return Err("The firewall could not be read"),
            },
        }
    }
    for step in plan(os, linux, action, rule) {
        // A missing rule makes delete commands fail, which is the state removal wants. The
        // read-back below decides success.
        let ran = output(&step).is_some_and(|(ok, _)| ok);
        if !ran && action == Action::Add {
            return rolled_back(os, linux, rule, "The firewall refused the rule");
        }
    }
    if !queryable {
        return Ok(false);
    }
    let present = exists(os, linux, rule);
    match action {
        Action::Check => {
            if present == Some(true) && owned(os, linux, rule)? {
                Ok(false)
            } else {
                Err("The firewall could not be confirmed")
            }
        }
        Action::Add if present != Some(true) => {
            rolled_back(os, linux, rule, "The firewall did not keep the change")
        }
        Action::Add => {
            // The live rule must carry Moss's marker, not just the right port.
            let marked = if os == Os::Mac {
                present == Some(true)
            } else {
                owned(os, linux, rule) == Ok(true)
            };
            if marked {
                Ok(false)
            } else {
                rolled_back(os, linux, rule, "The firewall did not keep the change")
            }
        }
        Action::Remove if present != Some(false) => Err("The firewall did not keep the change"),
        // Installer-owned service definitions remain loaded, but unassigned to any zone.
        Action::Remove => Ok(false),
    }
}

/// Whether listing text proves a Windows rule is Moss's. `None` means the text is no clear answer.
fn windows_marker(text: &str, rule: &Rule) -> Option<bool> {
    let token = rule.token.as_deref()?;
    if text.contains("No rules match") {
        return Some(false);
    }
    let count = text
        .lines()
        .filter(|line| line.trim_start().starts_with("Rule Name:"))
        .count();
    if count != 1 {
        return None;
    }
    let field = |key: &str| {
        let mut values = text.lines().filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then_some(value.trim())
        });
        let value = values.next()?;
        values.next().is_none().then_some(value)
    };
    // Exactly one rule holds the marker name and it carries the token for this port and program.
    Some(
        field("Rule Name")? == rule.name
            && field("Description")? == token
            && field("LocalPort")? == rule.port.to_string()
            && field("Program")?.eq_ignore_ascii_case(&rule.program.display().to_string()),
    )
}

fn windows_lookup(code: i32, text: &str, rule: &Rule) -> Result<bool, &'static str> {
    match code {
        0 => windows_marker(text, rule).ok_or("The firewall could not be read"),
        1 if text.trim() == "No rules match the specified criteria." => Ok(false),
        _ => Err("The firewall could not be read"),
    }
}

/// Whether `ufw show added` text proves the rules on the port are Moss's.
fn ufw_lines<'a>(text: &'a str, rule: &Rule) -> Vec<&'a str> {
    let command = format!("ufw allow {}/tcp", rule.port);
    text.lines()
        .filter(|line| *line == command || line.starts_with(&format!("{command} comment ")))
        .collect()
}

fn ufw_marker(text: &str, rule: &Rule) -> bool {
    let lines = ufw_lines(text, rule);
    !lines.is_empty()
        && lines.iter().all(|line| {
            line.split_once(" comment ").is_some_and(|(_, comment)| {
                comment == rule.name || comment == format!("'{}'", rule.name)
            })
        })
}

fn mac_paths(text: &str) -> Option<Vec<&str>> {
    let mut lines = text.trim().lines();
    let header = lines.next()?.trim();
    // New macOS versions omit the old ALF prefix. Both formats come from socketfilterfw.
    let count = header
        .strip_prefix("ALF: total number of apps = ")
        .or_else(|| header.strip_prefix("Total number of apps = "))?
        .trim()
        .parse::<usize>()
        .ok()?;
    let mut paths = Vec::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty()
            || matches!(
                line,
                "(Allow incoming connections)" | "(Block incoming connections)"
            )
        {
            continue;
        }
        let (index, path) = line.split_once(':')?;
        if index.trim().parse::<usize>().ok()? != paths.len() + 1 || !path.trim().starts_with('/') {
            return None;
        }
        paths.push(path.trim());
    }
    (paths.len() == count).then_some(paths)
}

fn mac_path_present(text: &str, program: &Path) -> bool {
    mac_paths(text).is_some_and(|paths| paths.contains(&program.to_string_lossy().as_ref()))
}

/// Only the exact application path and a record saying Moss added it allow removal.
fn mac_marker(text: &str, rule: &Rule) -> bool {
    rule.entry_added == Some(true) && mac_path_present(text, &rule.program)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ServiceMark {
    Ours,
    Foreign,
    Missing,
    Unreadable,
}

fn firewalld_mark(rule: &Rule) -> ServiceMark {
    let Some(path) = service_path(rule) else {
        return ServiceMark::Unreadable;
    };
    match std::fs::read_to_string(&path) {
        Ok(text) if service_file_is_ours(&text, rule) => ServiceMark::Ours,
        Ok(_) => ServiceMark::Foreign,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ServiceMark::Missing,
        Err(_) => ServiceMark::Unreadable,
    }
}

/// Whether the one rule a remove would delete carries Moss's marker on the live rule. A failed
/// read is an error, never "gone". A record with no token proves nothing, so it never deletes.
fn owned(os: Os, linux: Linux, rule: &Rule) -> Result<bool, &'static str> {
    const UNREADABLE: &str = "The firewall could not be read";
    if rule.token.is_none() {
        return Err(UNREADABLE);
    }
    match (os, linux) {
        (Os::Windows, _) => {
            let verbose = cmd(&[
                "netsh",
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={}", rule.name),
                "verbose",
            ]);
            let (code, text) = run_code(&verbose).ok_or(UNREADABLE)?;
            windows_lookup(code, &text, rule)
        }
        (Os::Linux, Linux::Ufw) => match run_code(&cmd(&["ufw", "show", "added"])) {
            Some((0, text)) if text.starts_with("Added user rules") => {
                let marked = ufw_marker(&text, rule);
                if !marked
                    && ufw_lines(&text, rule)
                        .iter()
                        .any(|line| line.contains(&rule.name))
                {
                    // Our rule mixed with a foreign selector is ambiguous; retain the record.
                    Err(UNREADABLE)
                } else {
                    Ok(marked)
                }
            }
            _ => Err(UNREADABLE),
        },
        (Os::Linux, Linux::Firewalld) => {
            if rule.manager.as_deref() != Some("firewalld") {
                return Err(UNREADABLE);
            }
            match firewalld_mark(rule) {
                ServiceMark::Ours => service_loaded(rule).map(|_| true),
                ServiceMark::Foreign => Ok(false),
                ServiceMark::Missing => match firewalld_halves(rule) {
                    // Assigned with no Moss file is someone else's rule. It stays.
                    Some(_) => Ok(false),
                    None => Err(UNREADABLE),
                },
                ServiceMark::Unreadable => Err(UNREADABLE),
            }
        }
        (Os::Mac, _) => {
            // Only the record showing Moss added this path lets a remove run at all.
            match rule.entry_added {
                Some(false) => return Ok(false),
                None => return Err(UNREADABLE),
                Some(true) => {}
            }
            match run_code(&cmd(&[SOCKET_FILTER, "--listapps"])) {
                Some((0, text)) if mac_paths(&text).is_some() => Ok(mac_marker(&text, rule)),
                _ => Err(UNREADABLE),
            }
        }
        _ => Err(UNREADABLE),
    }
}

/// Takes a failed add back out and reports `reason`, or says so when the rule could not be removed.
/// The rollback goes through the same marker check as any other delete.
fn rolled_back(
    os: Os,
    linux: Linux,
    rule: &Rule,
    reason: &'static str,
) -> Result<bool, &'static str> {
    match apply_with(os, linux, Action::Remove, rule) {
        Ok(_) if exists(os, linux, rule) == Some(false) => Err(reason),
        _ => Err(STUCK),
    }
}

/// What the app tells the owner about the firewall.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    NotAsked,
    Allowed,
    Paused,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::NotAsked => "not_asked",
            State::Allowed => "allowed",
            State::Paused => "paused",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal {
    /// The owner declined the prompt, or none could be shown.
    Declined,
    /// The prompt was approved but the firewall did not take the change.
    Failed,
    /// The change failed and the rule may still be open, so its record is kept.
    Stuck,
    /// A rule with Moss's name exists that Moss did not create. It is left alone.
    Foreign,
    /// No supported firewall manager was found. Sharing stays off.
    NoManager,
    /// A record from before ownership tokens. It never deletes, and the owner removes the old rule.
    Legacy,
    ServiceUnavailable,
}

impl Refusal {
    pub fn word(self) -> &'static str {
        match self {
            Refusal::Declined => "declined",
            Refusal::Failed => "failed",
            Refusal::Stuck => "stuck",
            Refusal::Foreign => "foreign_rule",
            Refusal::NoManager => "no_firewall_manager",
            Refusal::Legacy => "legacy_rule",
            Refusal::ServiceUnavailable => "firewall_service_unavailable",
        }
    }
}

/// The rule the instance asked for. A record that is not confirmed was written before the
/// operating system approved the change, so it never counts as permission.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    rule: Rule,
    #[serde(default)]
    paused: bool,
    confirmed: bool,
    /// The rule was open before Moss added it, so removal leaves it alone.
    #[serde(default)]
    preexisting: bool,
    /// The add ran and may have left a rule, so removal is allowed even when unconfirmed.
    #[serde(default)]
    added: bool,
}

#[derive(Clone)]
pub struct Firewall {
    folder: PathBuf,
    instance: String,
    program: PathBuf,
    stand_in: Option<PathBuf>,
}

impl Firewall {
    pub fn new(folder: &Path, program: PathBuf) -> Self {
        Self::with_stand_in(
            folder,
            program,
            std::env::var_os(STAND_IN_ENV).map(PathBuf::from),
        )
    }

    fn with_stand_in(folder: &Path, program: PathBuf, stand_in: Option<PathBuf>) -> Self {
        let instance = folder
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("default")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                    c
                } else {
                    '-'
                }
            })
            .take(24)
            .collect::<String>();
        Firewall {
            folder: folder.to_owned(),
            instance,
            program,
            stand_in,
        }
    }

    fn record_path(&self) -> PathBuf {
        self.folder.join(RECORD_FILE)
    }

    /// `Ok(None)` means no record. A record that cannot be read is an error, never "no record".
    fn recorded(&self) -> Result<Option<Record>, Refusal> {
        match std::fs::read(self.record_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| Refusal::Failed),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Refusal::Failed),
        }
    }

    /// Whether the live rule still carries Moss's marker for `port`. A record from before
    /// ownership tokens, a rule that was already open before Moss, a wrong port, or a lookup
    /// that cannot answer all mean sharing stays off. This runs against the real rule, with no
    /// stand-in shortcut.
    pub fn rule_intact(&self, port: u16) -> bool {
        let Ok(Some(record)) = self.recorded() else {
            return false;
        };
        let rule = &record.rule;
        if !record.confirmed
            || record.preexisting
            || rule.token.is_none()
            || rule.port != port
            || rule.program != self.program
        {
            return false;
        }
        let (os, linux) = match this_os() {
            Os::Windows => (Os::Windows, Linux::Nothing),
            Os::Mac => (Os::Mac, Linux::Nothing),
            Os::Linux => match rule.manager.as_deref() {
                Some("ufw") => (Os::Linux, Linux::Ufw),
                Some("firewalld") => (Os::Linux, Linux::Firewalld),
                _ => return false,
            },
        };
        owned(os, linux, rule) == Ok(true)
            && (linux != Linux::Firewalld || firewalld_halves(rule).is_some_and(|(_, live)| live))
    }

    /// Startup never authorizes. Preserve intent and the token while accepting loopback only.
    pub fn pause(&self) -> Result<(), Refusal> {
        let Some(mut record) = self.recorded()? else {
            return Ok(());
        };
        record.paused = true;
        self.write_record(&record)
    }

    pub fn startup(&self, intended: bool, port: u16) -> Result<bool, Refusal> {
        if !intended {
            return Ok(false);
        }
        let active = self.rule_intact(port);
        if let Some(mut record) = self.recorded()? {
            record.paused = !active;
            self.write_record(&record)?;
        }
        Ok(active)
    }

    pub async fn resume(&self, port: u16) -> Result<(), Refusal> {
        let Some(mut record) = self.recorded()? else {
            return Err(Refusal::Failed);
        };
        if record.rule.token.is_none() {
            return Err(Refusal::Legacy);
        }
        if !record.paused
            || !record.confirmed
            || record.preexisting
            || record.rule.port != port
            || record.rule.program != self.program
        {
            return Err(Refusal::Failed);
        }
        // This verb reads only. It never recreates a missing rule or changes a foreign rule.
        self.run(Action::Check, record.rule.clone()).await?;
        record.paused = false;
        self.write_record(&record)
    }

    pub fn state(&self) -> State {
        match self.recorded() {
            Ok(Some(record)) if record.paused => State::Paused,
            Ok(Some(record)) if record.confirmed && record.rule.token.is_some() => State::Allowed,
            _ => State::NotAsked,
        }
    }

    fn write_record(&self, record: &Record) -> Result<(), Refusal> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| Refusal::Failed)?;
        crate::config::private_write(&self.record_path(), &bytes).map_err(|_| Refusal::Failed)
    }

    /// Opens the rule for `port`, asking the owner once. Nothing stays open if it fails.
    pub async fn open(&self, port: u16) -> Result<(), Refusal> {
        let (mut zone, mut manager) = (None, None);
        if this_os() == Os::Linux {
            let linux = detect_linux();
            manager = match linux {
                Linux::Ufw => Some("ufw".to_owned()),
                Linux::Firewalld => Some("firewalld".to_owned()),
                Linux::Nothing => None,
            };
            match linux {
                // No manager means no way to verify a rule, so fail before asking the owner.
                Linux::Nothing if self.stand_in.is_none() => return Err(Refusal::NoManager),
                Linux::Firewalld => {
                    let (ok, text) = output(&cmd(&["firewall-cmd", "--get-default-zone"]))
                        .ok_or(Refusal::Failed)?;
                    if !ok {
                        return Err(Refusal::Failed);
                    }
                    zone = Some(text.trim().to_owned());
                }
                _ => {}
            }
        }
        let token = if manager.as_deref() == Some("firewalld") {
            let installed: InstalledService =
                std::fs::read(self.folder.join(FIREWALLD_RECEIPT_FILE))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .ok_or(Refusal::ServiceUnavailable)?;
            if installed.service != format!("moss-{}", self.instance) || installed.port != port {
                return Err(Refusal::ServiceUnavailable);
            }
            installed.token
        } else {
            new_token()
        };
        let mut rule = Rule {
            // The marker names the instance and this one add, on the live rule itself.
            name: format!("moss-{}-{token}", self.instance),
            port,
            program: self.program.clone(),
            zone,
            token: Some(token),
            manager,
            service: Some(format!("moss-{}", self.instance)),
            entry_added: None,
        };
        if this_os() == Os::Mac {
            // The macOS marker is the server path entry. Moss may remove it only when Moss
            // added it, so the add needs to know whether the entry is already there.
            rule.entry_added = match exists(Os::Mac, Linux::Nothing, &rule) {
                Some(false) => Some(true),
                Some(true) => Some(false),
                None => return Err(Refusal::Failed),
            };
        }
        rule.check().map_err(|_| Refusal::Failed)?;
        match self.recorded()? {
            Some(open) if open.confirmed && open.rule.port == rule.port => return Ok(()),
            // A different rule, or one that was never confirmed, goes before a new one opens.
            Some(_) => self.close().await?,
            None => {}
        }
        // Intent is written before the add, then the add, then the live marker is confirmed.
        // A crash at any step leaves either nothing or a rule the marker can still prove.
        // The macOS entry is claimed only when Moss is the one adding it.
        let added = if this_os() == Os::Mac {
            rule.entry_added == Some(true)
        } else {
            true
        };
        self.write_record(&Record {
            rule: rule.clone(),
            paused: false,
            confirmed: false,
            preexisting: false,
            added,
        })?;
        match self.run(Action::Add, rule.clone()).await {
            Ok(preexisting) => {
                // The elevated helper confirms the live marker before returning its receipt.
                // The unprivileged process cannot re-read ufw's root-only configuration.
                let mut stored = rule.clone();
                if this_os() == Os::Mac {
                    stored.entry_added = Some(!preexisting);
                }
                self.write_record(&Record {
                    rule: stored,
                    paused: false,
                    confirmed: true,
                    preexisting,
                    added: !preexisting,
                })
            }
            // The rule may be open, so the record now allows its removal.
            Err(Refusal::Stuck) => {
                let _ = self.write_record(&Record {
                    rule,
                    paused: false,
                    confirmed: false,
                    preexisting: false,
                    added: true,
                });
                Err(Refusal::Stuck)
            }
            Err(other) => {
                // Only a refused prompt proves that the helper did not run. Lookup errors
                // and failed commands keep intent for a later verified cleanup.
                if other == Refusal::Declined {
                    let _ = std::fs::remove_file(self.record_path());
                }
                Err(other)
            }
        }
    }

    /// Removes the open rule, if there is one. The record stays until the removal is confirmed.
    pub async fn close(&self) -> Result<(), Refusal> {
        let Some(record) = self.recorded()? else {
            return Ok(());
        };
        // A record from before ownership tokens never deletes and is never quietly cleared.
        if record.rule.token.is_none() {
            return Err(Refusal::Legacy);
        }
        // A rule is only removed when Moss added it. A record written before the owner's answer
        // proves nothing, because the rule under that name may belong to someone else.
        if !record.preexisting && (record.confirmed || record.added) {
            // A record from before ownership tokens never deletes. The record stays and the
            // owner is told to remove the old rule by hand.
            if record.rule.token.is_none() {
                return Err(Refusal::Legacy);
            }
            self.run(Action::Remove, record.rule).await?;
        }
        std::fs::remove_file(self.record_path()).map_err(|_| Refusal::Failed)
    }

    async fn run(&self, action: Action, rule: Rule) -> Result<bool, Refusal> {
        let command = elevated(self.stand_in.as_deref(), action, &rule)?;
        let expected = (action != Action::Remove).then(|| confirmation(&rule));
        tokio::task::spawn_blocking(move || wait(command, expected))
            .await
            .map_err(|_| Refusal::Failed)?
    }
}

fn confirmation(rule: &Rule) -> String {
    format!("moss-firewall-confirmed:{}:{}", rule.name, rule.port)
}

/// A fresh marker for one rule.
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn helper_args(action: Action, rule: &Rule) -> Vec<String> {
    let mut args = vec![
        "firewall-rule".into(),
        action.word().into(),
        "--name".into(),
        rule.name.clone(),
        "--port".into(),
        rule.port.to_string(),
        "--program".into(),
        rule.program.display().to_string(),
    ];
    if let Some(zone) = &rule.zone {
        args.push("--zone".into());
        args.push(zone.clone());
    }
    if let Some(token) = &rule.token {
        args.push("--token".into());
        args.push(token.clone());
    }
    if let Some(manager) = &rule.manager {
        args.push("--manager".into());
        args.push(manager.clone());
    }
    if let Some(service) = &rule.service {
        args.push("--service".into());
        args.push(service.clone());
    }
    if let Some(entry_added) = rule.entry_added {
        args.push("--entry-added".into());
        args.push(entry_added.to_string());
    }
    args
}

fn quote_windows(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The command that asks the owner and then runs the helper with the owner's approval.
fn elevated(stand_in: Option<&Path>, action: Action, rule: &Rule) -> Result<Command, Refusal> {
    let exe = std::env::current_exe().map_err(|_| Refusal::Failed)?;
    let args = helper_args(action, rule);
    let mut command;
    if let Some(script) = stand_in {
        command = Command::new(script);
        command.arg(&exe).args(&args);
    } else if cfg!(windows) {
        command = Command::new("powershell.exe");
        let list = args
            .iter()
            .map(|a| quote_windows(a))
            .collect::<Vec<_>>()
            .join(" ");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(
                "try { $p = Start-Process -FilePath $env:MOSS_ELEVATE_EXE -ArgumentList $env:MOSS_ELEVATE_ARGS \
                 -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 126 }",
            )
            .env("MOSS_ELEVATE_EXE", &exe)
            .env("MOSS_ELEVATE_ARGS", list);
    } else if cfg!(target_os = "macos") {
        command = Command::new("osascript");
        let shell = std::iter::once(quote_shell(&exe.display().to_string()))
            .chain(args.iter().map(|a| quote_shell(a)))
            .collect::<Vec<_>>()
            .join(" ");
        let script = shell.replace('\\', "\\\\").replace('"', "\\\"");
        command.arg("-e").arg(format!(
            "do shell script \"{script}\" with administrator privileges"
        ));
    } else {
        // The graphical agent only. Without it the prompt is declined, never a terminal.
        command = Command::new("pkexec");
        command
            .arg("--disable-internal-agent")
            .arg(&exe)
            .args(&args);
    }
    Ok(command)
}

fn wait(mut command: Command, expected: Option<String>) -> Result<bool, Refusal> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Refusal::Declined)?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROMPT_LIMIT => {
                std::thread::sleep(Duration::from_millis(200))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                // The helper may have changed the firewall before it was stopped.
                return Err(Refusal::Stuck);
            }
        }
    };
    if status.success() {
        if let Some(expected) = expected {
            use std::io::Read;
            let mut text = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                let _ = stdout.read_to_string(&mut text);
            }
            if !text.lines().any(|line| line == expected) {
                return Err(Refusal::Stuck);
            }
        }
        return Ok(false);
    }
    let mut note = String::new();
    if let Some(mut err) = child.stderr.take() {
        use std::io::Read;
        let _ = err.read_to_string(&mut note);
    }
    match status.code() {
        Some(EXIT_ALREADY) => Ok(true),
        Some(EXIT_FAILED) => Err(Refusal::Failed),
        Some(EXIT_STUCK) => Err(Refusal::Stuck),
        Some(EXIT_FOREIGN) => Err(Refusal::Foreign),
        Some(EXIT_NO_MANAGER) => Err(Refusal::NoManager),
        Some(EXIT_SERVICE_UNAVAILABLE) => Err(Refusal::ServiceUnavailable),
        // The macOS prompt reports a cancelled dialog as error -128.
        Some(1) if note.contains("-128") => Err(Refusal::Declined),
        // `do shell script` ends its error text with the helper's own exit code.
        Some(1) if cfg!(target_os = "macos") => match note.trim_end().rsplit_once('(') {
            Some((_, tail)) if tail.starts_with("5)") => Ok(true),
            Some((_, tail)) if tail.starts_with("4)") => Err(Refusal::Stuck),
            Some((_, tail)) if tail.starts_with("6)") => Err(Refusal::Foreign),
            Some((_, tail)) if tail.starts_with("7)") => Err(Refusal::NoManager),
            Some((_, tail)) if tail.starts_with("8)") => Err(Refusal::ServiceUnavailable),
            _ => Err(Refusal::Failed),
        },
        _ => Err(Refusal::Declined),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> Rule {
        Rule {
            name: "moss-default-0123456789abcdef".into(),
            port: 5198,
            program: std::env::current_exe().unwrap(),
            zone: None,
            token: Some("0123456789abcdef".into()),
            manager: None,
            service: Some("moss-default".into()),
            entry_added: None,
        }
    }

    #[test]
    fn windows_rule_is_scoped_to_the_program_and_port() {
        let steps = plan(Os::Windows, Linux::Nothing, Action::Add, &rule());
        let add = steps.last().unwrap();
        assert!(add.contains(&"localport=5198".to_owned()));
        assert!(add.iter().any(|a| a.starts_with("program=")));
        let delete = plan(Os::Windows, Linux::Nothing, Action::Remove, &rule());
        assert!(delete[0].iter().any(|a| a.starts_with("program=")));
        assert!(delete[0].contains(&"localport=5198".to_owned()));
        assert!(add.contains(&"dir=in".to_owned()));
    }

    #[test]
    fn each_os_removes_what_it_adds() {
        for (os, linux) in [
            (Os::Windows, Linux::Nothing),
            (Os::Mac, Linux::Nothing),
            (Os::Linux, Linux::Ufw),
            (Os::Linux, Linux::Firewalld),
        ] {
            assert!(!plan(os, linux, Action::Add, &rule()).is_empty());
            assert!(!plan(os, linux, Action::Remove, &rule()).is_empty());
        }
        assert!(plan(Os::Linux, Linux::Nothing, Action::Add, &rule()).is_empty());
    }

    #[test]
    fn rules_with_odd_names_or_paths_are_refused() {
        let mut bad = rule();
        bad.name = "x; rm".into();
        assert!(bad.check().is_err());
        let mut bad = rule();
        bad.name = "Other-default".into();
        assert!(bad.check().is_err());
        let mut bad = rule();
        bad.program = PathBuf::from("relative");
        assert!(bad.check().is_err());
        assert!(rule().check().is_ok());
    }

    struct Scratch(PathBuf);
    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        let path = std::env::temp_dir().join(format!(
            "moss-fw-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }

    #[tokio::test]
    async fn an_unreadable_record_is_never_treated_as_no_record() {
        let folder = scratch();
        let firewall = Firewall::new(folder.path(), std::env::current_exe().unwrap());
        assert!(firewall.close().await.is_ok());
        std::fs::write(folder.path().join(RECORD_FILE), b"not json").unwrap();
        assert!(firewall.close().await.is_err());
        assert!(folder.path().join(RECORD_FILE).exists());
        assert_eq!(firewall.state(), State::NotAsked);
    }

    #[tokio::test]
    async fn a_record_never_confirmed_does_not_count_as_allowed() {
        let folder = scratch();
        let firewall = Firewall::new(folder.path(), std::env::current_exe().unwrap());
        let record = Record {
            rule: rule(),
            paused: false,
            confirmed: false,
            preexisting: false,
            added: false,
        };
        firewall.write_record(&record).unwrap();
        assert_eq!(firewall.state(), State::NotAsked);
    }

    #[tokio::test]
    async fn a_record_before_the_owner_answered_never_deletes_a_rule() {
        let folder = scratch();
        let firewall = Firewall::new(folder.path(), std::env::current_exe().unwrap());
        firewall
            .write_record(&Record {
                rule: rule(),
                paused: false,
                confirmed: false,
                preexisting: false,
                added: false,
            })
            .unwrap();
        // Running a removal would start the operating system prompt and fail here.
        assert!(firewall.close().await.is_ok());
        assert!(!folder.path().join(RECORD_FILE).exists());
    }

    #[test]
    fn the_helper_receives_the_owner_token_and_manager() {
        let mut owned = rule();
        owned.token = Some("Moss-owner-1".into());
        owned.manager = Some("ufw".into());
        let args = helper_args(Action::Remove, &owned);
        assert!(args.windows(2).any(|w| w == ["--token", "Moss-owner-1"]));
        assert!(args.windows(2).any(|w| w == ["--manager", "ufw"]));
        owned.manager = Some("iptables".into());
        assert!(owned.check().is_err());
    }

    #[test]
    fn no_firewall_manager_fails_closed_for_add_and_remove() {
        for action in [Action::Add, Action::Remove] {
            assert_eq!(
                apply_with(Os::Linux, Linux::Nothing, action, &rule()),
                Err(NO_MANAGER)
            );
        }
    }

    #[test]
    fn windows_add_never_replaces_a_rule_by_name() {
        let steps = plan(Os::Windows, Linux::Nothing, Action::Add, &rule());
        assert_eq!(steps.len(), 1);
        assert!(!steps[0].iter().any(|a| a == "delete"));
    }

    #[test]
    fn every_live_rule_carries_the_marker() {
        let owned = rule();
        let win = plan(Os::Windows, Linux::Nothing, Action::Add, &owned);
        assert!(win[0].contains(&format!("name={}", owned.name)));
        assert!(win[0].contains(&"description=0123456789abcdef".to_owned()));
        assert!(owned.name.starts_with("moss-default-"));
        let ufw = plan(Os::Linux, Linux::Ufw, Action::Add, &owned);
        assert!(ufw[0].contains(&owned.name));
        let fwd = plan(Os::Linux, Linux::Firewalld, Action::Add, &owned);
        assert!(fwd
            .iter()
            .flatten()
            .any(|a| a == "--add-service=moss-default"));
        assert!(!fwd.iter().flatten().any(|a| a.contains("-port=")));
        let xml = service_xml(&owned).unwrap();
        assert!(xml.contains("<description>0123456789abcdef</description>"));
        assert!(xml.contains("port=\"5198\""));
    }

    #[test]
    fn windows_marker_rejects_near_matches_and_ambiguous_lists() {
        let rule = rule();
        let text = format!(
            "Rule Name: {}\nDescription: {}\nLocalPort: {}\nProgram: {}\n",
            rule.name,
            rule.token.as_deref().unwrap(),
            rule.port,
            rule.program.display()
        );
        assert_eq!(windows_marker(&text, &rule), Some(true));
        assert_eq!(
            windows_marker(&text.replace("5198", "15198"), &rule),
            Some(false)
        );
        assert_eq!(
            windows_marker(
                &text.replace("Rule Name: moss-", "Rule Name: foreign-moss-"),
                &rule
            ),
            Some(false)
        );
        assert_eq!(windows_marker(&format!("{text}{text}"), &rule), None);
        assert!(windows_lookup(2, &text, &rule).is_err());
        assert!(windows_lookup(1, "lookup failed", &rule).is_err());
        assert!(windows_lookup(0, "garbled", &rule).is_err());
        assert!(windows_lookup(0, &format!("{text}{text}"), &rule).is_err());
        assert_eq!(
            windows_lookup(1, "No rules match the specified criteria.\n", &rule),
            Ok(false)
        );
    }

    #[test]
    fn marker_checks_accept_ours_and_refuse_foreign_rules() {
        let owned = rule();
        let program = owned.program.display().to_string();
        let good = format!(
            "Rule Name: {}\nProgram: {program}\nLocalPort: 5198\nDescription: 0123456789abcdef\n",
            owned.name
        );
        assert_eq!(windows_marker(&good, &owned), Some(true));
        // Negative controls. A foreign token, a second rule, and a garbled answer never prove.
        let foreign = good.replace("0123456789abcdef", "someone-else");
        assert_eq!(windows_marker(&foreign, &owned), Some(false));
        let two = format!("{good}Rule Name: other\n");
        assert_eq!(windows_marker(&two, &owned), None);
        assert_eq!(windows_marker("No rules match", &owned), Some(false));
        assert_eq!(windows_marker("garbled", &owned), None);

        let ufw_good = format!("ufw allow 5198/tcp comment {}", owned.name);
        assert!(ufw_marker(&ufw_good, &owned));
        let ufw_foreign = "ufw allow 5198/tcp";
        assert!(!ufw_marker(ufw_foreign, &owned));
        assert!(!ufw_marker(&format!("{ufw_good}\n{ufw_foreign}"), &owned));
        assert!(!ufw_marker("", &owned));
        assert!(!ufw_marker(&format!("{ufw_good}-foreign"), &owned));
        assert!(!ufw_marker(
            &format!("ufw allow 15198/tcp comment {}", owned.name),
            &owned
        ));

        let mut mac = owned.clone();
        // This fixture models macOS even when the parser tests run on Windows.
        mac.program = PathBuf::from("/Applications/Moss.app/Contents/MacOS/moss-server");
        let program = mac.program.display().to_string();
        mac.entry_added = Some(true);
        assert!(mac_marker(
            &format!("ALF: total number of apps = 1\n1 : {program}\n"),
            &mac
        ));
        mac.entry_added = Some(false);
        assert!(!mac_marker(&program, &mac));
        mac.entry_added = None;
        assert!(!mac_marker(&program, &mac));
        mac.entry_added = Some(true);
        assert!(!mac_marker("/usr/bin/true", &mac));
        assert!(!mac_marker(&format!("1 : {program}.foreign"), &mac));

        assert!(service_file_is_ours(&service_xml(&owned).unwrap(), &owned));
        let bad_token = service_xml(&owned)
            .unwrap()
            .replace("0123456789abcdef", "nope");
        assert!(!service_file_is_ours(&bad_token, &owned));
        let bad_port = service_xml(&owned).unwrap().replace("5198", "6000");
        assert!(!service_file_is_ours(&bad_port, &owned));
    }

    #[test]
    fn a_delete_without_marker_proof_is_an_error_or_a_no_op() {
        // No token at all proves nothing on any system.
        let mut legacy = rule();
        legacy.token = None;
        for (os, linux) in [
            (Os::Windows, Linux::Nothing),
            (Os::Mac, Linux::Nothing),
            (Os::Linux, Linux::Ufw),
            (Os::Linux, Linux::Firewalld),
        ] {
            assert!(owned(os, linux, &legacy).is_err());
        }
        // macOS without the record showing Moss added the entry never deletes.
        assert!(owned(Os::Mac, Linux::Nothing, &rule()).is_err());
        let mut preexisting = rule();
        preexisting.entry_added = Some(false);
        assert_eq!(owned(Os::Mac, Linux::Nothing, &preexisting), Ok(false));
    }

    #[test]
    fn firewalld_query_requires_a_clear_answer_and_success_code() {
        assert_eq!(firewalld_answer(0, "yes\n"), Some(true));
        assert_eq!(firewalld_answer(1, "no\n"), Some(false));
        for (code, text) in [(0, "error"), (1, "timeout"), (2, "no"), (0, "no")] {
            assert_eq!(firewalld_answer(code, text), None);
        }
    }

    #[test]
    fn mac_listing_accepts_native_headers_but_never_incomplete_or_failed_output() {
        for prefix in ["ALF: total number of apps = ", "Total number of apps = "] {
            let text = format!("{prefix}1 \n1 : /moss-server \n  (Allow incoming connections)\n");
            assert_eq!(mac_paths(&text), Some(vec!["/moss-server"]));
            assert_eq!(mac_paths(&format!("{prefix}0\n")), Some(vec![]));
            assert!(mac_paths(&text.replace("= 1", "= 2")).is_none());
        }
        assert!(mac_paths("You need root access").is_none());
        assert!(mac_paths("Total number of apps = 0\nerror").is_none());
    }

    #[test]
    fn firewalld_live_definition_requires_exact_token_port_and_no_extra_grants() {
        let owned = rule();
        let service = service_name(&owned).unwrap();
        let info = format!("{service}\n  short: {service}\n  description: {}\n  ports: {}/tcp\n  protocols: \n  source-ports: \n  modules: \n  destination: \n  includes: \n  helpers: \n", owned.token.as_deref().unwrap(), owned.port);
        assert!(service_info_is_ours(&info, &owned));
        for bad in [
            info.replace(owned.token.as_deref().unwrap(), "foreign"),
            info.replace("5198/tcp", "15198/tcp"),
            info.replace("5198/tcp", "5198/tcp 22/tcp"),
            info.replace("protocols: ", "protocols: tcp"),
            format!("{info}  description: foreign\n"),
        ] {
            assert!(!service_info_is_ours(&bad, &owned));
        }
        let xml = service_xml(&owned).unwrap();
        assert!(!service_file_is_ours(
            &xml.replace(
                "</service>",
                "<port port=\"22\" protocol=\"tcp\"/></service>"
            ),
            &owned
        ));
        assert!(!service_file_is_ours(&xml.replace("5198", "15198"), &owned));
    }

    #[test]
    fn firewalld_runtime_never_changes_installer_service_files() {
        let folder = scratch();
        std::env::set_var("MOSS_FIREWALLD_SERVICE_DIR", folder.path());
        let mut fwd = rule();
        fwd.manager = Some("firewalld".into());
        let path = service_path(&fwd).unwrap();
        // A foreign service file is left alone and the remove is a no-op success.
        std::fs::write(
            &path,
            "<service><description>someone-else</description></service>",
        )
        .unwrap();
        assert_eq!(firewalld_mark(&fwd), ServiceMark::Foreign);
        assert_eq!(owned(Os::Linux, Linux::Firewalld, &fwd), Ok(false));
        assert!(path.exists());
        // Our file with no clear assignment answer is an error, and the file stays.
        std::fs::write(&path, service_xml(&fwd).unwrap()).unwrap();
        assert_eq!(firewalld_mark(&fwd), ServiceMark::Ours);
        if Command::new("firewall-cmd")
            .arg("--state")
            .output()
            .is_err()
        {
            assert!(apply_with(Os::Linux, Linux::Firewalld, Action::Remove, &fwd).is_err());
            assert!(path.exists());
        }
        let _ = std::fs::remove_file(&path);
        assert_eq!(firewalld_mark(&fwd), ServiceMark::Missing);
        std::env::remove_var("MOSS_FIREWALLD_SERVICE_DIR");
    }

    #[tokio::test]
    async fn a_legacy_record_never_deletes_and_stays() {
        let folder = scratch();
        // The folder name keeps the instance so the firewall can be built from it.
        let firewall = Firewall::new(folder.path(), std::env::current_exe().unwrap());
        let mut legacy = rule();
        legacy.token = None;
        firewall
            .write_record(&Record {
                rule: legacy,
                paused: false,
                confirmed: true,
                preexisting: false,
                added: true,
            })
            .unwrap();
        assert_eq!(firewall.close().await, Err(Refusal::Legacy));
        assert!(folder.path().join(RECORD_FILE).exists());
        assert_eq!(firewall.state(), State::NotAsked);
        assert!(!firewall.rule_intact(5198));
    }

    #[tokio::test]
    async fn restart_needs_the_live_marker_and_the_current_port() {
        let folder = scratch();
        let firewall = Firewall::new(folder.path(), std::env::current_exe().unwrap());
        let mut current = rule();
        current.manager = Some("ufw".into());
        firewall
            .write_record(&Record {
                rule: current,
                paused: false,
                confirmed: true,
                preexisting: false,
                added: true,
            })
            .unwrap();
        // Wrong port, and right port with no live marked rule, both keep sharing off.
        assert!(!firewall.rule_intact(6000));
        assert!(!firewall.rule_intact(5198));
    }

    #[cfg(unix)]
    fn stand_in(folder: &Scratch, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = folder.path().join("stand-in.sh");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn intent_is_written_first_and_an_unmarked_add_stays_unconfirmed() {
        let folder = scratch();
        let seen = folder.path().join("seen.txt");
        let script = stand_in(
            &folder,
            &format!("printf '%s' \"$*\" > '{}'\nexit 0", seen.display()),
        );
        let firewall = Firewall::with_stand_in(
            folder.path(),
            std::env::current_exe().unwrap(),
            Some(script),
        );
        // The stand-in approves but adds no rule, so the marker check must refuse to confirm.
        assert_eq!(firewall.open(5198).await, Err(Refusal::Stuck));
        let record = firewall.recorded().unwrap().unwrap();
        assert!(!record.confirmed && record.added);
        assert!(record.rule.token.is_some());
        assert!(record
            .rule
            .name
            .contains(&record.rule.token.clone().unwrap()));
        // The helper was handed the marker name for this instance.
        let handed = std::fs::read_to_string(&seen).unwrap();
        assert!(handed.contains("add") && handed.contains("moss-"));
        assert_eq!(firewall.state(), State::NotAsked);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_never_prompts_and_resume_only_checks_the_preserved_rule() {
        let folder = scratch();
        let seen = folder.path().join("seen");
        let script = stand_in(
            &folder,
            &format!("echo \"$*\" >> '{}'\nexit 126", seen.display()),
        );
        let firewall = Firewall::with_stand_in(
            folder.path(),
            std::env::current_exe().unwrap(),
            Some(script),
        );
        let mut rule = rule();
        rule.manager = Some("ufw".into());
        firewall
            .write_record(&Record {
                rule: rule.clone(),
                paused: false,
                confirmed: true,
                preexisting: false,
                added: true,
            })
            .unwrap();
        assert_eq!(firewall.startup(true, 6000), Ok(false));
        assert_eq!(firewall.state(), State::Paused);
        assert!(
            !seen.exists(),
            "startup must never invoke authorization, including a stand-in"
        );
        let before = std::fs::read(firewall.record_path()).unwrap();
        assert_eq!(firewall.resume(6000).await, Err(Refusal::Failed));
        assert!(!seen.exists(), "wrong current port cannot prompt or resume");
        assert_eq!(firewall.resume(5198).await, Err(Refusal::Declined));
        assert_eq!(std::fs::read(firewall.record_path()).unwrap(), before);
        let args = std::fs::read_to_string(seen).unwrap();
        assert!(args.contains("firewall-rule check "));
        assert!(!args.contains("firewall-rule add ") && !args.contains("firewall-rule remove "));
        assert!(args.contains(&rule.name));
        assert_eq!(firewall.recorded().unwrap().unwrap().rule.token, rule.token);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_declined_prompt_leaves_no_rule_and_no_record() {
        let folder = scratch();
        let script = stand_in(&folder, "exit 126");
        let firewall = Firewall::with_stand_in(
            folder.path(),
            std::env::current_exe().unwrap(),
            Some(script),
        );
        assert_eq!(firewall.open(5198).await, Err(Refusal::Declined));
        assert!(!folder.path().join(RECORD_FILE).exists());
    }

    #[test]
    fn linux_prompt_never_opens_a_terminal() {
        if cfg!(unix) && !cfg!(target_os = "macos") {
            let command = elevated(None, Action::Add, &rule()).ok().unwrap();
            let args: Vec<_> = command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert_eq!(command.get_program(), "pkexec");
            assert_eq!(args[0], "--disable-internal-agent");
        }
    }
}

/// The `firewall-rule` and `firewall-close` commands of the server program. `firewall-rule
/// add|remove` changes the operating system rule and runs with the owner's approval from the
/// system prompt. `firewall-close --instance FOLDER` removes the rule an instance left open, for
/// uninstall. Returns the process exit code.
/// True on Linux when neither ufw nor firewalld is usable, so sharing cannot be opened safely.
pub fn manager_missing() -> bool {
    this_os() == Os::Linux && detect_linux() == Linux::Nothing
}

pub fn command(args: &[String]) -> i32 {
    let word = args.first().map(String::as_str);
    if word == Some("firewall-close") {
        let folder = match (args.get(1).map(String::as_str), args.get(2)) {
            (Some("--instance"), Some(folder)) => PathBuf::from(folder),
            _ => return 2,
        };
        let Ok(program) = std::env::current_exe() else {
            return EXIT_FAILED;
        };
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return EXIT_FAILED;
        };
        return match runtime.block_on(Firewall::new(&folder, program).close()) {
            Ok(()) => 0,
            Err(_) => EXIT_FAILED,
        };
    }
    let action = match args.get(1).map(String::as_str) {
        Some("add") => Action::Add,
        Some("remove") => Action::Remove,
        Some("check") => Action::Check,
        _ => return 2,
    };
    let (mut name, mut port, mut program, mut zone) = (None, None, None, None);
    let (mut token, mut manager, mut service, mut entry_added) = (None, None, None, None);
    let mut rest = args.iter().skip(2);
    while let Some(flag) = rest.next() {
        let Some(value) = rest.next() else { return 2 };
        match flag.as_str() {
            "--name" => name = Some(value.clone()),
            "--port" => port = value.parse::<u16>().ok(),
            "--program" => program = Some(PathBuf::from(value)),
            "--zone" => zone = Some(value.clone()),
            "--token" => token = Some(value.clone()),
            "--manager" => manager = Some(value.clone()),
            "--service" => service = Some(value.clone()),
            "--entry-added" => entry_added = value.parse::<bool>().ok(),
            _ => return 2,
        }
    }
    let (Some(name), Some(port), Some(program)) = (name, port, program) else {
        return 2;
    };
    // Only this program may be named, so the elevated helper opens nothing else.
    if std::env::current_exe().ok().as_deref() != Some(program.as_path()) {
        return 2;
    }
    let rule = Rule {
        name,
        port,
        program,
        zone,
        token,
        manager,
        service,
        entry_added,
    };
    let result = if action == Action::Check {
        rule.check().and_then(|_| {
            let linux = match rule.manager.as_deref() {
                Some("ufw") => Linux::Ufw,
                Some("firewalld") => Linux::Firewalld,
                _ => Linux::Nothing,
            };
            if owned(this_os(), linux, &rule)?
                && exists(this_os(), linux, &rule) == Some(true)
                && (linux != Linux::Firewalld
                    || firewalld_halves(&rule).is_some_and(|(_, live)| live))
            {
                Ok(false)
            } else {
                Err("The firewall could not be confirmed")
            }
        })
    } else {
        apply(action, &rule)
    };
    match result {
        Ok(true) => EXIT_ALREADY,
        Ok(false) => {
            if action != Action::Remove {
                println!("{}", confirmation(&rule));
            }
            0
        }
        Err(reason) => {
            eprintln!("moss-server: {reason}");
            match reason {
                STUCK => EXIT_STUCK,
                FOREIGN => EXIT_FOREIGN,
                NO_MANAGER => EXIT_NO_MANAGER,
                SERVICE_UNAVAILABLE => EXIT_SERVICE_UNAVAILABLE,
                _ => EXIT_FAILED,
            }
        }
    }
}
