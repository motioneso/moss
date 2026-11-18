//! Kill-gate check: can Rust drive this agent, with a Moss tool, and no Node from Moss?
//!
//!   moss-agent-probe <claude|codex|opencode> --program <path> --work <dir> [--model <id>]
//!                    [--agent-home <dir>]
//!
//! Starts the agent through its native protocol, offers one Moss tool that returns a random
//! word, and asks the agent to call it and repeat the word. The word exists only inside this
//! process, so a reply containing it proves the tool round trip really ran. Prints one JSON
//! line with the result.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use moss_agents::approvals::{CallFacts, Risk, ToolFacts};
use moss_agents::driver::*;
use moss_agents::gateway::{GatewayHost, ToolDef, ToolFuture, ToolHost};
use moss_agents::policy;
use moss_agents::session::AgentSession;
use serde_json::{json, Value};

struct ProbeTools {
    word: String,
}

impl ToolHost for ProbeTools {
    fn tools(&self) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "secret_word".into(),
            description: "Returns today's secret word from Moss.".into(),
            input_schema: json!({"type": "object", "properties": {}}),
            facts: ToolFacts {
                risk: Risk::Read,
                is_external: false,
                execution_auto: true,
                confirm_under_yolo: false,
                family: None,
            },
        }]
    }

    fn call(&self, _account: &str, _name: &str, _args: Value) -> ToolFuture {
        let w = self.word.clone();
        Box::pin(async move { Ok(w) })
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let kind = args.next().and_then(|k| AgentKind::parse(&k)).unwrap_or_else(|| die("agent?"));
    let (mut program, mut work, mut model, mut agent_home) = (None, None, None, None::<PathBuf>);
    while let Some(flag) = args.next() {
        let v = args.next().unwrap_or_else(|| die("flag needs a value"));
        match flag.as_str() {
            "--program" => program = Some(PathBuf::from(v)),
            "--work" => work = Some(PathBuf::from(v)),
            "--model" => model = Some(v),
            "--agent-home" => agent_home = Some(PathBuf::from(v)),
            _ => die("unknown flag"),
        }
    }
    let program = program.unwrap_or_else(|| die("--program"));
    let work = work.unwrap_or_else(|| die("--work"));
    std::fs::create_dir_all(&work).expect("work dir");
    let gateway_bin = std::env::current_exe().unwrap().with_file_name("moss-tool-gateway");

    let word = format!("moss-{}", &moss_agents::hello::random_secret()[..10]);
    let host = Arc::new(ProbeTools { word: word.clone() });
    let gw = GatewayHost::start(
        "probe",
        &work,
        host,
        Arc::new(|_, _| Box::pin(async { Answer::Deny })),
        Arc::new(CallFacts::default),
    )
    .expect("gateway");

    let asks: Arc<Mutex<Vec<Value>>> = Arc::default();
    let cwd = work.clone();
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let log = asks.clone();
    let approver: Approver = Arc::new(move |ask: PermissionAsk| {
        let folders = policy::Folders {
            cwd: &cwd,
            home: None, // the probe runs on the person's own sign-in; see the report
        };
        let d = policy::classify(
            &policy::Request {
                tool_name: ask.tool_name.as_deref(),
                raw_input: &ask.raw_input,
                locations: &ask.paths,
            },
            &folders,
        );
        let answer = if d == policy::Decision::Allow { Answer::Allow } else { Answer::Deny };
        log.lock().unwrap().push(json!({"tool": ask.tool_name, "title": ask.title, "input": ask.raw_input, "decision": d, "answer": answer}));
        Box::pin(async move { answer })
    });

    let mut env: Vec<(String, String)> = ["HOME", "PATH", "USER", "LANG", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    let _ = &home;
    env.push(("NO_COLOR".into(), "1".into()));
    // A Moss-owned settings folder for the agent, so the person's own tool servers never load
    // in a Moss chat. Codex reads it from CODEX_HOME; OpenCode from its config folder (its
    // sign-ins live in the data folder, which stays).
    if let Some(dir) = &agent_home {
        let var = match kind {
            AgentKind::Codex => "CODEX_HOME",
            AgentKind::OpenCode => "XDG_CONFIG_HOME",
            AgentKind::Claude => die("Claude is isolated by its launch flags; --agent-home is not used"),
        };
        env.retain(|(k, _)| k != var);
        env.push((var.into(), dir.to_string_lossy().into()));
    }
    // Prove Moss passes no Node of its own: the agent's PATH has no Node directory added by us,
    // and the probe records whether the agent process tree ever ran node.
    let spec = LaunchSpec {
        kind,
        program: program.clone(),
        cwd: work.clone(),
        env,
        model,
        tools: Some(ToolServer {
            command: gateway_bin,
            args: vec![],
            env: vec![
                ("MOSS_TOOL_SOCKET".into(), gw.socket.to_string_lossy().into()),
                ("MOSS_TOOL_LEASE_FILE".into(), gw.lease_file.to_string_lossy().into_owned()),
            ],
        }),
        confinement: None,
    };

    let started = Instant::now();
    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: EventSink = Arc::new(move |e| sink_events.lock().unwrap().push(e));
    let result = async {
        let mut session = AgentSession::start(&spec, approver).await?;
        let pid = session.pid();
        let model = session.model().to_string();
        // Sample the process tree all through the turn, so a short-lived helper is still seen.
        let seen: Arc<Mutex<std::collections::BTreeSet<String>>> = Arc::default();
        let sampler = {
            let seen = seen.clone();
            tokio::spawn(async move {
                loop {
                    seen.lock().unwrap().extend(process_tree(pid));
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
        };
        let outcome = session
            .prompt(
                "Call the Moss tool named secret_word, then reply with only the word it returned.",
                &sink,
            )
            .await;
        sampler.abort();
        let tree: Vec<String> = seen.lock().unwrap().iter().cloned().collect();
        let tree_before: Vec<String> = vec![];
        session.shutdown().await;
        Ok::<_, AgentError>((model, outcome?, tree_before, tree))
    }
    .await;

    let report = match result {
        Ok((model, outcome, tree_before, tree)) => {
            let node_seen = tree.iter().chain(tree_before.iter()).any(|c| is_node(c));
            json!({
                "agent": kind,
                "program": program,
                "model": model,
                "ok": outcome.text.contains(&word),
                "tool_round_trip": outcome.text.contains(&word),
                "tools_used": outcome.tools_used,
                "reply": outcome.text.chars().take(200).collect::<String>(),
                "seconds": started.elapsed().as_secs_f32(),
                "permission_asks": *asks.lock().unwrap(),
                "process_tree": tree,
                "node_in_process_tree": node_seen,
            })
        }
        Err(e) => json!({"agent": kind, "ok": false, "error": e.to_string(), "seconds": started.elapsed().as_secs_f32()}),
    };
    println!("{report}");
}

/// Executable paths of the agent and every descendant still running, from /proc.
fn process_tree(root: Option<u32>) -> Vec<String> {
    let Some(root) = root else { return vec![] };
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        if let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) {
            out.push(exe.to_string_lossy().into_owned());
        }
        // Each thread keeps its own child list, so read every thread's.
        for task in std::fs::read_dir(format!("/proc/{pid}/task")).into_iter().flatten().flatten() {
            if let Ok(children) = std::fs::read_to_string(task.path().join("children")) {
                queue.extend(children.split_whitespace().filter_map(|c| c.parse::<u32>().ok()));
            }
        }
    }
    out
}

fn is_node(exe: &str) -> bool {
    let base = exe.rsplit('/').next().unwrap_or_default();
    base == "node" || base.starts_with("node")
}

fn die(msg: &str) -> ! {
    eprintln!("moss-agent-probe: {msg}");
    std::process::exit(2);
}
