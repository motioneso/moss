//! Kill-gate check: can Rust drive this agent, with a Moss tool, and no Node from Moss?
//!
//!   moss-agent-probe <claude|codex|opencode> --program <path> --work <dir> [--model <id>]
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

    fn call(&self, _name: &str, _args: Value) -> ToolFuture {
        let w = self.word.clone();
        Box::pin(async move { Ok(w) })
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let kind = args.next().and_then(|k| AgentKind::parse(&k)).unwrap_or_else(|| die("agent?"));
    let (mut program, mut work, mut model) = (None, None, None);
    while let Some(flag) = args.next() {
        let v = args.next().unwrap_or_else(|| die("flag needs a value"));
        match flag.as_str() {
            "--program" => program = Some(PathBuf::from(v)),
            "--work" => work = Some(PathBuf::from(v)),
            "--model" => model = Some(v),
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
        log.lock().unwrap().push(json!({"tool": ask.tool_name, "decision": d, "answer": answer}));
        Box::pin(async move { answer })
    });

    let mut env: Vec<(String, String)> = ["HOME", "PATH", "USER", "LANG", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    let _ = &home;
    env.push(("NO_COLOR".into(), "1".into()));
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
                ("MOSS_TOOL_LEASE".into(), gw.lease().into()),
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
        let tree_before = process_tree(pid);
        let outcome = session
            .prompt(
                "Call the Moss tool named secret_word, then reply with only the word it returned.",
                &sink,
            )
            .await;
        let tree = process_tree(pid);
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
        if let Ok(children) = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) {
            queue.extend(children.split_whitespace().filter_map(|c| c.parse::<u32>().ok()));
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
