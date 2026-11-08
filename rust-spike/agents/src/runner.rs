//! The runner: one agent process per account, each in its own folders.
//!
//! The runner owns every agent. For each account it makes a private folder tree, starts that
//! account's agent with a launch environment built from nothing, confines it to that tree where
//! the OS allows, and gives it a Moss tool gateway with a fresh lease. Permission asks that the
//! policy cannot settle become approval cards for whoever is driving the current turn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::approvals::CallFacts;
use crate::confine::{Confinement, SYSTEM_READ, SYSTEM_WRITE};
use crate::driver::*;
use crate::gateway::{CallFactsFn, Confirm, GatewayHost, ToolHost};
use crate::policy;
use crate::session::AgentSession;

/// How one account's agent is set up.
#[derive(Debug, Clone)]
pub struct AccountSetup {
    pub kind: AgentKind,
    /// The agent's native program.
    pub program: PathBuf,
    /// Where the agent finds its own sign-in. Each account has its own; on a one-person
    /// install it is that person's home folder.
    pub sign_in_home: PathBuf,
    /// Leave empty to use the model the person set up in the agent.
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// Holds `accounts/<id>/`. Nothing else of Moss's lives under it.
    pub root: PathBuf,
    pub gateway_bin: PathBuf,
    /// `None` runs agents unconfined. Only for systems that cannot confine yet.
    pub confine_bin: Option<PathBuf>,
}

/// One account's private folders.
#[derive(Debug, Clone, Serialize)]
pub struct AccountFolders {
    /// The agent's working folder.
    pub work: PathBuf,
    /// Moss-owned agent settings, so the person's other tool servers never load.
    pub agent_home: PathBuf,
    /// Sockets.
    pub run: PathBuf,
}

/// An approval card: the runner asks, the app shows it, the person answers.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalCard {
    pub tool: String,
    pub title: String,
    pub input: Value,
}

pub type ApprovalFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Answer> + Send>>;
pub type AskPerson = Arc<dyn Fn(ApprovalCard) -> ApprovalFuture + Send + Sync>;

/// Who answers approval cards during the current turn. Empty between turns, so a late ask
/// is refused.
type Slot = Arc<Mutex<Option<AskPerson>>>;

struct Account {
    session: AgentSession,
    _gateway: GatewayHost,
    slot: Slot,
}

pub struct Runner {
    cfg: RunnerConfig,
    tools: Arc<dyn ToolHost>,
    facts: CallFactsFn,
    accounts: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Account>>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("account ids are 1-64 lowercase letters, digits, - or _")]
    BadAccount,
    #[error("could not prepare the account folders: {0}")]
    Folders(std::io::Error),
    #[error("the Moss data folder must not sit inside a system folder every agent can reach")]
    RootExposed,
    #[error(transparent)]
    Agent(#[from] AgentError),
}

/// Account ids become folder names, so only plain characters pass.
pub fn valid_account(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

impl Runner {
    pub fn new(cfg: RunnerConfig, tools: Arc<dyn ToolHost>, facts: CallFactsFn) -> Self {
        Self {
            cfg,
            tools,
            facts,
            accounts: Default::default(),
        }
    }

    pub fn folders(&self, account: &str) -> AccountFolders {
        let base = self.cfg.root.join("accounts").join(account);
        AccountFolders {
            work: base.join("work"),
            agent_home: base.join("agent-home"),
            run: base.join("run"),
        }
    }

    fn prepare(&self, account: &str) -> Result<AccountFolders, RunnerError> {
        if !valid_account(account) {
            return Err(RunnerError::BadAccount);
        }
        if SYSTEM_READ.iter().chain(SYSTEM_WRITE).chain(["/tmp"].iter()).any(|s| self.cfg.root.starts_with(s)) {
            return Err(RunnerError::RootExposed);
        }
        let f = self.folders(account);
        let base = f.work.parent().expect("account folder").to_path_buf();
        for d in [&f.work, &f.agent_home, &f.run, &base] {
            std::fs::create_dir_all(d).map_err(RunnerError::Folders)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))
                    .map_err(RunnerError::Folders)?;
            }
        }
        Ok(f)
    }

    /// The launch for one account. Public so tests can check exactly what an agent receives.
    pub fn launch_spec(&self, setup: &AccountSetup, f: &AccountFolders, tools: ToolServer) -> LaunchSpec {
        let home = setup.sign_in_home.to_string_lossy().into_owned();
        let mut env = vec![
            ("HOME".to_string(), home.clone()),
            ("PATH".to_string(), "/usr/local/bin:/usr/bin:/bin".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
            ("TERM".to_string(), "dumb".to_string()),
            ("NO_COLOR".to_string(), "1".to_string()),
            ("TMPDIR".to_string(), f.run.to_string_lossy().into_owned()),
        ];
        let agent_home = f.agent_home.to_string_lossy().into_owned();
        match setup.kind {
            AgentKind::Codex => env.push(("CODEX_HOME".into(), agent_home)),
            AgentKind::OpenCode => {
                env.push(("XDG_CONFIG_HOME".into(), agent_home));
                env.push(("XDG_DATA_HOME".into(), format!("{home}/.local/share")));
            }
            // Claude is kept to Moss's settings by its launch flags.
            AgentKind::Claude => {}
        }

        let confinement = self.cfg.confine_bin.as_ref().map(|launcher| {
            let mut read: Vec<PathBuf> = SYSTEM_READ.iter().map(PathBuf::from).collect();
            for p in [&setup.program, &self.cfg.gateway_bin] {
                if let Some(dir) = std::fs::canonicalize(p).ok().and_then(|c| c.parent().map(Path::to_path_buf)) {
                    read.push(dir);
                }
            }
            let mut write: Vec<PathBuf> = SYSTEM_WRITE.iter().map(PathBuf::from).collect();
            // Agents keep sessions and caches beside their sign-in, so that folder is writable.
            write.extend([setup.sign_in_home.clone(), f.work.clone(), f.agent_home.clone(), f.run.clone()]);
            Confinement {
                read,
                write,
                launcher: launcher.clone(),
            }
        });

        LaunchSpec {
            kind: setup.kind,
            program: setup.program.clone(),
            cwd: f.work.clone(),
            env,
            model: setup.model.clone(),
            tools: Some(tools),
            confinement,
        }
    }

    /// Starts the account's agent if it is not running. One agent per account, ever.
    async fn account(&self, account: &str, setup: &AccountSetup) -> Result<Arc<tokio::sync::Mutex<Account>>, RunnerError> {
        let mut all = self.accounts.lock().await;
        if let Some(a) = all.get(account) {
            return Ok(a.clone());
        }
        let f = self.prepare(account)?;
        let slot: Slot = Arc::default();

        let gw_slot = slot.clone();
        let confirm: Confirm = Arc::new(move |tool, input| {
            let ask = gw_slot.lock().unwrap().clone();
            Box::pin(async move {
                match ask {
                    Some(ask) => {
                        ask(ApprovalCard {
                            title: tool.clone(),
                            tool,
                            input,
                        })
                        .await
                    }
                    None => Answer::Deny,
                }
            })
        });
        let gateway = GatewayHost::start(&f.run, self.tools.clone(), confirm, self.facts.clone())
            .map_err(RunnerError::Folders)?;
        let tools = ToolServer {
            command: self.cfg.gateway_bin.clone(),
            args: vec![],
            env: vec![
                ("MOSS_TOOL_SOCKET".into(), gateway.socket.to_string_lossy().into()),
                ("MOSS_TOOL_LEASE".into(), gateway.lease().into()),
            ],
        };
        let spec = self.launch_spec(setup, &f, tools);
        let session = AgentSession::start(&spec, approver(f.work.clone(), slot.clone())).await?;
        let acct = Arc::new(tokio::sync::Mutex::new(Account {
            session,
            _gateway: gateway,
            slot,
        }));
        all.insert(account.to_string(), acct.clone());
        Ok(acct)
    }

    /// Runs one chat turn for the account. Turns for one account run one at a time.
    pub async fn chat(
        &self,
        account: &str,
        setup: &AccountSetup,
        text: &str,
        events: &EventSink,
        ask: AskPerson,
    ) -> Result<TurnOutcome, RunnerError> {
        let acct = self.account(account, setup).await?;
        let mut a = acct.lock().await;
        *a.slot.lock().unwrap() = Some(ask);
        let out = a.session.prompt(text, events).await;
        *a.slot.lock().unwrap() = None;
        if out.is_err() {
            // A failed agent is started fresh next turn rather than reused half-broken.
            drop(a);
            self.stop(account).await;
        }
        Ok(out?)
    }

    pub async fn pid(&self, account: &str) -> Option<u32> {
        let acct = self.accounts.lock().await.get(account)?.clone();
        let pid = acct.lock().await.session.pid();
        pid
    }

    pub async fn stop(&self, account: &str) {
        let acct = self.accounts.lock().await.remove(account);
        if let Some(acct) = acct {
            if let Ok(a) = Arc::try_unwrap(acct) {
                a.into_inner().session.shutdown().await;
            }
        }
    }
}

/// The agent's own permission asks. The policy settles most; the rest become approval cards.
fn approver(cwd: PathBuf, slot: Slot) -> Approver {
    Arc::new(move |ask: PermissionAsk| {
        let decision = policy::classify(
            &policy::Request {
                tool_name: ask.tool_name.as_deref(),
                raw_input: &ask.raw_input,
                locations: &ask.paths,
            },
            &policy::Folders { cwd: &cwd, home: None },
        );
        let person = slot.lock().unwrap().clone();
        Box::pin(async move {
            match decision {
                policy::Decision::Allow => Answer::Allow,
                policy::Decision::Deny { .. } => Answer::Deny,
                policy::Decision::Ask => match person {
                    Some(person) => {
                        person(ApprovalCard {
                            tool: ask.tool_name.unwrap_or_else(|| "unknown".into()),
                            title: ask.title,
                            input: ask.raw_input,
                        })
                        .await
                    }
                    None => Answer::Deny,
                },
            }
        })
    })
}

/// Facts for a runner with no YOLO switch or marks yet: every call routes on its tool alone.
pub fn plain_facts() -> CallFactsFn {
    Arc::new(CallFacts::default)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoTools;
    impl ToolHost for NoTools {
        fn tools(&self) -> Vec<crate::gateway::ToolDef> {
            vec![]
        }
        fn call(&self, _: &str, _: Value) -> crate::gateway::ToolFuture {
            Box::pin(async { Err("none".into()) })
        }
    }

    fn runner(root: &Path) -> Runner {
        Runner::new(
            RunnerConfig {
                root: root.into(),
                gateway_bin: "/bin/true".into(),
                confine_bin: Some("/bin/moss-confine".into()),
            },
            Arc::new(NoTools),
            plain_facts(),
        )
    }

    #[test]
    fn data_root_under_a_system_folder_is_refused() {
        let r = runner(Path::new("/tmp/moss"));
        assert!(matches!(r.prepare("alice"), Err(RunnerError::RootExposed)));
    }

    #[test]
    fn account_ids_cannot_escape_the_accounts_folder() {
        for bad in ["", "../other", "a/b", "A", ".", "x".repeat(65).as_str()] {
            assert!(!valid_account(bad), "{bad:?}");
        }
        assert!(valid_account("ben-1_a"));
    }

    #[test]
    fn launch_carries_no_runner_secrets_and_confines_to_own_folders() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let r = runner(dir.path());
        let setup = AccountSetup {
            kind: AgentKind::Codex,
            program: "/bin/sh".into(),
            sign_in_home: "/home/someone".into(),
            model: None,
        };
        let f = r.folders("alice");
        let spec = r.launch_spec(
            &setup,
            &f,
            ToolServer {
                command: "/bin/true".into(),
                args: vec![],
                env: vec![],
            },
        );
        let names: Vec<&str> = spec.env.iter().map(|(k, _)| k.as_str()).collect();
        for banned in ["DATABASE_URL", "MOSS_AUTH_SECRET", "MOSS_ENCRYPTION_KEY"] {
            assert!(!names.contains(&banned));
        }
        assert!(names.contains(&"CODEX_HOME"));
        let c = spec.confinement.unwrap();
        let bob = r.folders("bob");
        for p in c.read.iter().chain(c.write.iter()) {
            assert!(!bob.work.starts_with(p), "{p:?} would expose another account");
            assert!(!dir.path().starts_with(p) || p.starts_with(dir.path().join("accounts/alice")));
        }
    }
}
