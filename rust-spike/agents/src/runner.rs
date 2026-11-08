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
    /// Where the agent finds its own sign-in. The agent can write it, so no two accounts may
    /// share one, and it must not hold the Moss data folder.
    pub sign_in_home: PathBuf,
    /// Allows the person's own home folder as the sign-in folder. The agent can then write
    /// files that run at login, so confinement is no boundary for that launch.
    pub person_home: bool,
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

/// Starts at most once, without holding the account list while the agent starts.
type StartCell = Arc<tokio::sync::OnceCell<Arc<tokio::sync::Mutex<Account>>>>;

struct Account {
    session: AgentSession,
    _gateway: GatewayHost,
    slot: Slot,
}

pub struct Runner {
    cfg: RunnerConfig,
    tools: Arc<dyn ToolHost>,
    facts: CallFactsFn,
    accounts: Mutex<HashMap<String, StartCell>>,
    /// Which account holds each sign-in home.
    sign_ins: Mutex<HashMap<PathBuf, String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("account ids are 1-64 lowercase letters, digits, - or _")]
    BadAccount,
    #[error("could not prepare the account folders: {0}")]
    Folders(std::io::Error),
    #[error("the Moss data folder must not sit inside a system folder every agent can reach")]
    RootExposed,
    #[error("an agent's sign-in folder must not hold the Moss data folder or another account's folders")]
    SignInOverlap,
    #[error("another account already uses this sign-in folder")]
    SignInShared,
    #[error("the sign-in folder is or holds the person's home, or sits in it outside this account's Moss folder; the agent could escape confinement")]
    PersonHome,
    #[error(transparent)]
    Agent(#[from] AgentError),
}

/// True when `sign_in` is the person's home, holds it, or sits anywhere in it outside the
/// account's own tree. Any such folder can hold files the person's unconfined programs run later.
pub fn touches_person_home(sign_in: &Path, person: &Path, account_tree: &Path) -> bool {
    person.starts_with(sign_in) || (sign_in.starts_with(person) && !sign_in.starts_with(account_tree))
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
            sign_ins: Default::default(),
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

    fn prepare(&self, account: &str, setup: &AccountSetup) -> Result<AccountFolders, RunnerError> {
        if !valid_account(account) {
            return Err(RunnerError::BadAccount);
        }
        std::fs::create_dir_all(&self.cfg.root).map_err(RunnerError::Folders)?;
        let root = std::fs::canonicalize(&self.cfg.root).map_err(RunnerError::Folders)?;
        if SYSTEM_READ.iter().chain(SYSTEM_WRITE).chain(["/tmp", "/dev"].iter()).any(|s| root.starts_with(s)) {
            return Err(RunnerError::RootExposed);
        }
        let home = std::fs::canonicalize(&setup.sign_in_home).map_err(RunnerError::Folders)?;
        if !setup.person_home {
            // Without a resolvable home the check cannot be made, so the launch is refused.
            let person = std::env::var_os("HOME")
                .and_then(|h| std::fs::canonicalize(h).ok())
                .ok_or(RunnerError::PersonHome)?;
            if touches_person_home(&home, &person, &root.join("accounts").join(account)) {
                return Err(RunnerError::PersonHome);
            }
        }
        if root.starts_with(&home) || (home.starts_with(&root) && !home.starts_with(root.join("accounts").join(account))) {
            return Err(RunnerError::SignInOverlap);
        }
        {
            let mut taken = self.sign_ins.lock().unwrap();
            let clash = taken
                .iter()
                .any(|(h, owner)| owner != account && (h.starts_with(&home) || home.starts_with(h)));
            if clash {
                return Err(RunnerError::SignInShared);
            }
            taken.insert(home, account.to_string());
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
            let mut write: Vec<PathBuf> = SYSTEM_WRITE.iter().map(PathBuf::from).filter(|p| p.exists()).collect();
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
        let cell = self.accounts.lock().unwrap().entry(account.to_string()).or_default().clone();
        let acct = cell.get_or_try_init(|| self.start(account, setup)).await?;
        Ok(acct.clone())
    }

    async fn start(&self, account: &str, setup: &AccountSetup) -> Result<Arc<tokio::sync::Mutex<Account>>, RunnerError> {
        let f = self.prepare(account, setup)?;
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
        let gateway = GatewayHost::start(account, &f.run, self.tools.clone(), confirm, self.facts.clone())
            .map_err(RunnerError::Folders)?;
        let tools = ToolServer {
            command: self.cfg.gateway_bin.clone(),
            args: vec![],
            env: vec![
                ("MOSS_TOOL_SOCKET".into(), gateway.socket.to_string_lossy().into()),
                ("MOSS_TOOL_LEASE_FILE".into(), gateway.lease_file.to_string_lossy().into_owned()),
            ],
        };
        let spec = self.launch_spec(setup, &f, tools);
        let approve = approver(f.work.clone(), setup.sign_in_home.clone(), slot.clone());
        let session = AgentSession::start(&spec, approve).await?;
        Ok(Arc::new(tokio::sync::Mutex::new(Account {
            session,
            _gateway: gateway,
            slot,
        })))
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
            drop(acct);
            self.stop(account).await;
        }
        Ok(out?)
    }

    pub async fn pid(&self, account: &str) -> Option<u32> {
        let cell = self.accounts.lock().unwrap().get(account)?.clone();
        let acct = cell.get()?.clone();
        let pid = acct.lock().await.session.pid();
        pid
    }

    pub async fn stop(&self, account: &str) {
        let cell = self.accounts.lock().unwrap().remove(account);
        let acct = cell.and_then(|c| Arc::try_unwrap(c).ok()).and_then(|c| c.into_inner());
        if let Some(Ok(a)) = acct.map(Arc::try_unwrap) {
            a.into_inner().session.shutdown().await;
        }
    }
}

/// The agent's own permission asks. The policy settles most; the rest become approval cards.
/// `home` is the agent's HOME. As in the TypeScript chat, anything under it is refused outright,
/// so a person cannot approve an agent reading its own sign-in token.
fn approver(cwd: PathBuf, home: PathBuf, slot: Slot) -> Approver {
    Arc::new(move |ask: PermissionAsk| {
        let decision = policy::classify(
            &policy::Request {
                tool_name: ask.tool_name.as_deref(),
                raw_input: &ask.raw_input,
                locations: &ask.paths,
            },
            &policy::Folders { cwd: &cwd, home: Some(&home) },
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

/// Facts for a runner with no YOLO switch, outside-content taint or marks yet: every call
/// routes on its tool alone.
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
        fn call(&self, _: &str, _: &str, _: Value) -> crate::gateway::ToolFuture {
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

    fn setup(home: &Path) -> AccountSetup {
        AccountSetup {
            kind: AgentKind::Codex,
            program: "/bin/sh".into(),
            sign_in_home: home.into(),
            person_home: false,
            model: None,
        }
    }

    /// The test folders sit under the person's home, so checks other than that one need the
    /// setting to be reached.
    fn setup_in_home(home: &Path) -> AccountSetup {
        AccountSetup { person_home: true, ..setup(home) }
    }

    #[test]
    fn data_root_under_a_system_folder_is_refused() {
        let r = runner(Path::new("/tmp/moss-runner-test"));
        let home = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        assert!(matches!(r.prepare("alice", &setup(home.path())), Err(RunnerError::RootExposed)));
    }

    #[test]
    fn sign_in_home_holding_the_data_folder_is_refused() {
        let home = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let r = runner(&home.path().join("moss"));
        assert!(matches!(r.prepare("alice", &setup_in_home(home.path())), Err(RunnerError::SignInOverlap)));
        // Inside the data folder but in another account's tree.
        let bob = home.path().join("moss/accounts/bob/home");
        std::fs::create_dir_all(&bob).unwrap();
        assert!(matches!(r.prepare("alice", &setup_in_home(&bob)), Err(RunnerError::SignInOverlap)));
    }

    #[test]
    fn the_persons_home_and_login_folders_are_refused_as_sign_in() {
        let (p, tree) = (Path::new("/home/p"), Path::new("/home/p/moss/accounts/a"));
        for bad in ["/home/p", "/home", "/", "/home/p/.config/systemd", "/home/p/.cargo", "/home/p/bin", "/home/p/.gnupg"] {
            assert!(touches_person_home(Path::new(bad), p, tree), "{bad}");
        }
        for ok in ["/home/p/moss/accounts/a/home", "/srv/moss/a"] {
            assert!(!touches_person_home(Path::new(ok), p, tree), "{ok}");
        }
    }

    #[test]
    fn the_runners_own_home_needs_the_explicit_setting() {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
        let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let r = runner(root.path());
        let mut s = setup(&home);
        assert!(matches!(r.prepare("alice", &s), Err(RunnerError::PersonHome)));
        // With the setting, the person's-home check is passed and the next check, that the data
        // folder (here under HOME) is not inside the sign-in folder, is the one that refuses.
        s.person_home = true;
        assert!(matches!(r.prepare("alice", &s), Err(RunnerError::SignInOverlap)));
    }

    #[test]
    fn two_accounts_cannot_share_a_sign_in_home() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let home = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let r = runner(dir.path());
        r.prepare("alice", &setup_in_home(home.path())).unwrap();
        r.prepare("alice", &setup_in_home(home.path())).unwrap();
        assert!(matches!(r.prepare("bob", &setup_in_home(home.path())), Err(RunnerError::SignInShared)));
        let inner = home.path().join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(matches!(r.prepare("bob", &setup_in_home(&inner)), Err(RunnerError::SignInShared)));
    }

    #[tokio::test]
    async fn reading_inside_the_agent_home_is_refused_not_asked() {
        let asked: Slot = Arc::new(Mutex::new(Some(Arc::new(|_| Box::pin(async { Answer::Allow }) as ApprovalFuture))));
        let approve = approver("/srv/work".into(), "/home/p".into(), asked);
        let ask = PermissionAsk {
            tool_name: Some("Read".into()),
            tool_call_id: "t1".into(),
            title: "Read".into(),
            raw_input: serde_json::json!({"file_path": "/home/p/.codex/auth.json"}),
            paths: vec!["/home/p/.codex/auth.json".into()],
        };
        assert_eq!(approve(ask).await, Answer::Deny);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gateway_secret_is_kept_out_of_names_and_launch_settings() {
        use std::os::unix::fs::PermissionsExt;
        // Socket paths are capped near 108 bytes, so this one stays short.
        let dir = tempfile::tempdir().unwrap();
        let gw = GatewayHost::start(
            "alice",
            dir.path(),
            Arc::new(NoTools),
            Arc::new(|_, _| Box::pin(async { Answer::Deny })),
            plain_facts(),
        )
        .unwrap();
        let lease = std::fs::read_to_string(&gw.lease_file).unwrap();
        assert_eq!(std::fs::metadata(&gw.lease_file).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!gw.socket.to_string_lossy().contains(&lease[..12]));
        let r = runner(dir.path());
        let tools = ToolServer {
            command: "/bin/true".into(),
            args: vec![],
            env: vec![
                ("MOSS_TOOL_SOCKET".into(), gw.socket.to_string_lossy().into()),
                ("MOSS_TOOL_LEASE_FILE".into(), gw.lease_file.to_string_lossy().into()),
            ],
        };
        let home = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let spec = r.launch_spec(&setup(home.path()), &r.folders("alice"), tools);
        let launch = format!("{:?}", spec);
        assert!(!launch.contains(lease.trim()), "the lease reached the agent's launch");
    }

    #[test]
    fn device_rules_leave_out_shared_memory() {
        assert!(!SYSTEM_WRITE.iter().any(|p| Path::new("/dev/shm/x").starts_with(p)));
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
            person_home: false,
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
