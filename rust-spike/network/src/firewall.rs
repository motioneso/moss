//! The operating system firewall rule that lets other devices reach the server.
//!
//! Sharing opens one rule scoped to this server program and its port, and closing sharing
//! removes it. The rule is changed by `moss-server firewall-rule`, run with the owner's
//! approval from the operating system's own prompt. A record in the instance folder names the
//! rule that is open, so turning sharing off or removing the instance always finds it.

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const RECORD_FILE: &str = "firewall.json";
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
const STUCK: &str = "The firewall rule could not be taken back";
const FOREIGN: &str = "A firewall rule with this name exists and Moss did not create it";
const NO_MANAGER: &str = "No supported firewall manager was found";
const PROMPT_LIMIT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Add,
    Remove,
}

impl Action {
    pub fn word(self) -> &'static str {
        match self {
            Action::Add => "add",
            Action::Remove => "remove",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub name: String,
    pub port: u16,
    pub program: PathBuf,
}

impl Rule {
    /// Names and paths reach operating system commands, so only plain values are accepted.
    pub fn check(&self) -> Result<(), &'static str> {
        let plain = |c: char| c.is_ascii_alphanumeric() || "-_.".contains(c);
        if !self.name.starts_with("Moss-") {
            return Err("The rule name must start with Moss-");
        }
        if self.name.is_empty() || self.name.len() > 64 || !self.name.chars().all(plain) {
            return Err("The rule name must be short and plain");
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
    let port = rule.port.to_string();
    let program = rule.program.display().to_string();
    match os {
        Os::Windows => match action {
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
            Action::Add => vec![
                cmd(&[SOCKET_FILTER, "--add", &program]),
                cmd(&[SOCKET_FILTER, "--unblockapp", &program]),
            ],
            Action::Remove => vec![cmd(&[SOCKET_FILTER, "--remove", &program])],
        },
        Os::Linux => match (linux, action) {
            (Linux::Firewalld, Action::Add) => vec![
                cmd(&[
                    "firewall-cmd",
                    "--permanent",
                    &format!("--add-port={port}/tcp"),
                ]),
                cmd(&["firewall-cmd", &format!("--add-port={port}/tcp")]),
            ],
            (Linux::Firewalld, Action::Remove) => vec![
                cmd(&[
                    "firewall-cmd",
                    "--permanent",
                    &format!("--remove-port={port}/tcp"),
                ]),
                cmd(&["firewall-cmd", &format!("--remove-port={port}/tcp")]),
            ],
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
            Linux::Firewalld => Some((
                cmd(&[
                    "firewall-cmd",
                    "--permanent",
                    &format!("--query-port={port}/tcp"),
                ]),
                None,
            )),
            Linux::Ufw => Some((
                cmd(&["ufw", "show", "added"]),
                Some(format!("allow {port}/tcp")),
            )),
            Linux::Nothing => None,
        },
    }
}

fn output(args: &[String]) -> Option<(bool, String)> {
    let out = Command::new(&args[0])
        .args(&args[1..])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
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
        let (ok, text) = output(query)?;
        match &needle {
            // A listing that failed to run says nothing about the rule.
            Some(needle) => ok.then(|| text.contains(needle)),
            None => Some(ok),
        }
    };
    let saved = read(&query)?;
    if linux == Linux::Firewalld && os == Os::Linux {
        let live = read(&cmd(&[
            "firewall-cmd",
            &format!("--query-port={}/tcp", rule.port),
        ]))?;
        return Some(saved || live);
    }
    Some(saved)
}

/// Runs the operating system commands. This is the privileged step; callers reach it through
/// the elevated helper. The rule is read back, and a failed add is removed again. Returns true
/// when the rule was already open before an add, which then leaves it as it found it.
pub fn apply(action: Action, rule: &Rule) -> Result<bool, &'static str> {
    rule.check()?;
    let linux = if this_os() == Os::Linux {
        detect_linux()
    } else {
        Linux::Nothing
    };
    apply_with(this_os(), linux, action, rule)
}

/// Saved and live firewalld state for the port. Either one keeps it open.
fn firewalld_halves(rule: &Rule) -> Option<(bool, bool)> {
    let query = |permanent: bool| {
        let mut args = vec!["firewall-cmd".to_owned()];
        if permanent {
            args.push("--permanent".into());
        }
        args.push(format!("--query-port={}/tcp", rule.port));
        output(&args).map(|(ok, _)| ok)
    };
    Some((query(true)?, query(false)?))
}

fn apply_with(os: Os, linux: Linux, action: Action, rule: &Rule) -> Result<bool, &'static str> {
    if os == Os::Linux && linux == Linux::Nothing {
        // Without a manager an add cannot be verified and a remove cannot be confirmed.
        return Err(NO_MANAGER);
    }
    let queryable = present_query(os, linux, rule).is_some();
    if action == Action::Add {
        match (os, linux) {
            // Only a rule Moss created may carry its name.
            (Os::Windows, _) => match exists(os, linux, rule) {
                Some(false) => {}
                Some(true) => return Err(FOREIGN),
                None => return Err("The firewall could not be read"),
            },
            (Os::Linux, Linux::Firewalld) => match firewalld_halves(rule) {
                Some((false, false)) => {}
                Some((true, true)) => return Ok(true),
                Some(_) => return Err(FOREIGN),
                None => return Err("The firewall could not be read"),
            },
            _ => {
                if exists(os, linux, rule) == Some(true) {
                    return Ok(true);
                }
            }
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
        Action::Add if present != Some(true) => {
            rolled_back(os, linux, rule, "The firewall did not keep the change")
        }
        Action::Remove if present != Some(false) => Err("The firewall did not keep the change"),
        _ => Ok(false),
    }
}

/// Takes a failed add back out and reports `reason`, or says so when the rule could not be removed.
fn rolled_back(
    os: Os,
    linux: Linux,
    rule: &Rule,
    reason: &'static str,
) -> Result<bool, &'static str> {
    let _ = apply_quietly(Action::Remove, rule, os, linux);
    if present_query(os, linux, rule).is_some() && exists(os, linux, rule) != Some(false) {
        return Err(STUCK);
    }
    Err(reason)
}

fn apply_quietly(action: Action, rule: &Rule, os: Os, linux: Linux) -> Option<()> {
    for step in plan(os, linux, action, rule) {
        output(&step);
    }
    Some(())
}

/// What the app tells the owner about the firewall.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    NotAsked,
    Allowed,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::NotAsked => "not_asked",
            State::Allowed => "allowed",
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
}

impl Refusal {
    pub fn word(self) -> &'static str {
        match self {
            Refusal::Declined => "declined",
            Refusal::Failed => "failed",
            Refusal::Stuck => "stuck",
            Refusal::Foreign => "foreign_rule",
            Refusal::NoManager => "no_firewall_manager",
        }
    }
}

/// The rule the instance asked for. A record that is not confirmed was written before the
/// operating system approved the change, so it never counts as permission.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    rule: Rule,
    confirmed: bool,
    /// The rule was open before Moss added it, so removal leaves it alone.
    #[serde(default)]
    preexisting: bool,
}

#[derive(Clone)]
pub struct Firewall {
    folder: PathBuf,
    name: String,
    program: PathBuf,
    stand_in: Option<PathBuf>,
}

impl Firewall {
    pub fn new(folder: &Path, program: PathBuf) -> Self {
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
            .take(48)
            .collect::<String>();
        Firewall {
            folder: folder.to_owned(),
            name: format!("Moss-{instance}"),
            program,
            stand_in: std::env::var_os(STAND_IN_ENV).map(PathBuf::from),
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

    pub fn state(&self) -> State {
        match self.recorded() {
            Ok(Some(record)) if record.confirmed => State::Allowed,
            _ => State::NotAsked,
        }
    }

    fn write_record(&self, record: &Record) -> Result<(), Refusal> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| Refusal::Failed)?;
        crate::config::private_write(&self.record_path(), &bytes).map_err(|_| Refusal::Failed)
    }

    /// Opens the rule for `port`, asking the owner once. Nothing stays open if it fails.
    pub async fn open(&self, port: u16) -> Result<(), Refusal> {
        let rule = Rule {
            name: self.name.clone(),
            port,
            program: self.program.clone(),
        };
        // No manager means no way to verify a rule, so fail before asking the owner anything.
        if self.stand_in.is_none() && this_os() == Os::Linux && detect_linux() == Linux::Nothing {
            return Err(Refusal::NoManager);
        }
        match self.recorded()? {
            Some(open) if open.confirmed && open.rule == rule => return Ok(()),
            // A different rule, or one that was never confirmed, goes before a new one opens.
            Some(_) => self.close().await?,
            None => {}
        }
        // The record comes first, so a crash during the change still leaves a way to remove it.
        self.write_record(&Record {
            rule: rule.clone(),
            confirmed: false,
            preexisting: false,
        })?;
        match self.run(Action::Add, rule.clone()).await {
            Ok(preexisting) => self.write_record(&Record {
                rule,
                confirmed: true,
                preexisting,
            }),
            Err(Refusal::Stuck) => Err(Refusal::Stuck),
            Err(other) => {
                let _ = std::fs::remove_file(self.record_path());
                Err(other)
            }
        }
    }

    /// Removes the open rule, if there is one. The record stays until the removal is confirmed.
    pub async fn close(&self) -> Result<(), Refusal> {
        let Some(record) = self.recorded()? else {
            return Ok(());
        };
        if !record.preexisting {
            self.run(Action::Remove, record.rule).await?;
        }
        std::fs::remove_file(self.record_path()).map_err(|_| Refusal::Failed)
    }

    async fn run(&self, action: Action, rule: Rule) -> Result<bool, Refusal> {
        let command = elevated(self.stand_in.as_deref(), action, &rule)?;
        tokio::task::spawn_blocking(move || wait(command))
            .await
            .map_err(|_| Refusal::Failed)?
    }
}

fn helper_args(action: Action, rule: &Rule) -> Vec<String> {
    vec![
        "firewall-rule".into(),
        action.word().into(),
        "--name".into(),
        rule.name.clone(),
        "--port".into(),
        rule.port.to_string(),
        "--program".into(),
        rule.program.display().to_string(),
    ]
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

fn wait(mut command: Command) -> Result<bool, Refusal> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
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
        // The macOS prompt reports a cancelled dialog as error -128.
        Some(1) if note.contains("-128") => Err(Refusal::Declined),
        // `do shell script` ends its error text with the helper's own exit code.
        Some(1) if cfg!(target_os = "macos") => match note.trim_end().rsplit_once('(') {
            Some((_, tail)) if tail.starts_with("5)") => Ok(true),
            Some((_, tail)) if tail.starts_with("4)") => Err(Refusal::Stuck),
            Some((_, tail)) if tail.starts_with("6)") => Err(Refusal::Foreign),
            Some((_, tail)) if tail.starts_with("7)") => Err(Refusal::NoManager),
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
            name: "Moss-default".into(),
            port: 5198,
            program: std::env::current_exe().unwrap(),
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
            confirmed: false,
            preexisting: false,
        };
        firewall.write_record(&record).unwrap();
        assert_eq!(firewall.state(), State::NotAsked);
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
        _ => return 2,
    };
    let (mut name, mut port, mut program) = (None, None, None);
    let mut rest = args.iter().skip(2);
    while let Some(flag) = rest.next() {
        let Some(value) = rest.next() else { return 2 };
        match flag.as_str() {
            "--name" => name = Some(value.clone()),
            "--port" => port = value.parse::<u16>().ok(),
            "--program" => program = Some(PathBuf::from(value)),
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
    match apply(
        action,
        &Rule {
            name,
            port,
            program,
        },
    ) {
        Ok(true) => EXIT_ALREADY,
        Ok(false) => 0,
        Err(reason) => {
            eprintln!("moss-server: {reason}");
            match reason {
                STUCK => EXIT_STUCK,
                FOREIGN => EXIT_FOREIGN,
                NO_MANAGER => EXIT_NO_MANAGER,
                _ => EXIT_FAILED,
            }
        }
    }
}
