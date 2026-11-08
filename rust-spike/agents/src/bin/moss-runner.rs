//! The runner process. Owns every account's agent; the app talks to it over a private socket.
//!
//!   moss-runner <config.json>
//!
//! Config: `{"root": DIR, "gateway_bin": PATH, "confine_bin": PATH|null, "account": "local",
//!           "agent": {"kind": "claude", "program": PATH, "sign_in_home": DIR, "model": null}}`
//!
//! The agent's sign-in folder belongs to that one account, so chats for any other account are
//! refused until each account brings its own sign-in.
//!
//! The socket (`<root>/runner.sock`) and the secret (`<root>/runner.secret`) are owner-only.
//! Every connection opens with `{"op":"hello","secret":...}`; a wrong secret closes it.
//! Then, one line of JSON each way:
//!
//!   -> {"op":"chat","account":"local","text":"..."}
//!   <- {"event":"text","delta":"..."} | {"event":"tool_started",...} | {"event":"tool_finished",...}
//!   <- {"event":"approval","id":1,"card":{"tool":...,"title":...,"input":...}}
//!   -> {"op":"answer","id":1,"allow":true}
//!   <- {"event":"done","text":"...","tools_used":[...]} | {"event":"error","message":"..."}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use moss_agents::approvals::{Risk, ToolFacts};
use moss_agents::driver::*;
use moss_agents::gateway::{ToolDef, ToolFuture, ToolHost};
use moss_agents::runner::*;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Deserialize)]
struct Config {
    root: PathBuf,
    gateway_bin: PathBuf,
    confine_bin: Option<PathBuf>,
    #[serde(default = "local")]
    account: String,
    agent: AgentConfig,
}

fn local() -> String {
    "local".into()
}

#[derive(Deserialize)]
struct AgentConfig {
    kind: String,
    program: PathBuf,
    sign_in_home: PathBuf,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Hello { secret: String },
    Chat { account: String, text: String },
    Answer { id: u64, allow: bool },
}

/// The tools this runner offers until the app supplies the real tool list.
struct BuiltinTools;

impl ToolHost for BuiltinTools {
    fn tools(&self) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "current_time".into(),
            description: "The current date and time on the Moss server, in UTC.".into(),
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

    fn call(&self, _: &str, _: &str, _: Value) -> ToolFuture {
        Box::pin(async {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();
            Ok(format!("Unix time {secs} (UTC)."))
        })
    }
}

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| die("usage: moss-runner <config.json>"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| die(&format!("config: {e}")));
    let cfg: Config = serde_json::from_str(&raw).unwrap_or_else(|e| die(&format!("config: {e}")));
    let kind = AgentKind::parse(&cfg.agent.kind).unwrap_or_else(|| die("agent.kind"));
    std::fs::create_dir_all(&cfg.root).unwrap_or_else(|e| die(&format!("root: {e}")));
    let setup = Arc::new(AccountSetup {
        kind,
        program: cfg.agent.program,
        sign_in_home: cfg.agent.sign_in_home,
        model: cfg.agent.model,
    });
    let runner = Arc::new(Runner::new(
        RunnerConfig {
            root: cfg.root.clone(),
            gateway_bin: cfg.gateway_bin,
            confine_bin: cfg.confine_bin,
        },
        Arc::new(BuiltinTools),
        plain_facts(),
    ));
    let status = moss_agents::confine::status();
    eprintln!("moss-runner: confinement on {}: {} ({})", status.os, status.enforced, status.detail);

    let secret = moss_agents::hello::random_secret();
    let secret_path = cfg.root.join("runner.secret");
    let socket = cfg.root.join("runner.sock");
    write_private(&secret_path, &secret);
    let _ = std::fs::remove_file(&socket);
    let listener = tokio::net::UnixListener::bind(&socket).unwrap_or_else(|e| die(&format!("socket: {e}")));
    set_private(&socket);
    eprintln!("moss-runner: listening on {}", socket.display());

    let secret = Arc::new(secret);
    let owner = Arc::new(cfg.account);
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let (runner, setup, secret, owner) = (runner.clone(), setup.clone(), secret.clone(), owner.clone());
        tokio::spawn(async move {
            let _ = serve(stream, runner, setup, owner, secret).await;
        });
    }
}

async fn serve(
    stream: tokio::net::UnixStream,
    runner: Arc<Runner>,
    setup: Arc<AccountSetup>,
    owner: Arc<String>,
    secret: Arc<String>,
) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Some(first) = lines.next_line().await? else { return Ok(()) };
    match serde_json::from_str::<Op>(&first) {
        Ok(Op::Hello { secret: s }) if moss_agents::hello::same_secret(&s, &secret) => {}
        _ => return Ok(()),
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(v) = out_rx.recv().await {
            let mut line = serde_json::to_vec(&v).expect("json");
            line.push(b'\n');
            if write.write_all(&line).await.is_err() {
                break;
            }
        }
    });
    let _ = out_tx.send(json!({"event": "ready"}));

    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Answer>>>> = Arc::default();
    let next_id = Arc::new(AtomicU64::new(1));
    while let Some(line) = lines.next_line().await? {
        match serde_json::from_str::<Op>(&line) {
            Ok(Op::Chat { account, .. }) if account != *owner => {
                let _ = out_tx.send(json!({"event": "error", "message": "This runner has no agent for that account."}));
            }
            Ok(Op::Chat { account, text }) => {
                let (runner, setup, out, pending, next_id) =
                    (runner.clone(), setup.clone(), out_tx.clone(), pending.clone(), next_id.clone());
                tokio::spawn(async move {
                    let sink_out = out.clone();
                    let events: EventSink = Arc::new(move |e| {
                        let _ = sink_out.send(event_json(&e));
                    });
                    let ask_out = out.clone();
                    let ask: AskPerson = Arc::new(move |card| {
                        let id = next_id.fetch_add(1, Ordering::Relaxed);
                        let (tx, rx) = oneshot::channel();
                        pending.lock().unwrap().insert(id, tx);
                        let _ = ask_out.send(json!({"event": "approval", "id": id, "card": card}));
                        // No answer (the app went away) counts as no.
                        Box::pin(async move { rx.await.unwrap_or(Answer::Deny) })
                    });
                    let reply = match runner.chat(&account, &setup, &text, &events, ask).await {
                        Ok(t) => json!({"event": "done", "text": t.text, "tools_used": t.tools_used}),
                        // The detail can hold agent output, so it stays in the runner's log.
                        Err(e) => {
                            eprintln!("moss-runner: {account}: {}", moss_agents::redact::redact_line(&e.to_string()));
                            json!({"event": "error", "message": "The agent stopped with an error. Details are in the Moss log."})
                        }
                    };
                    let _ = out.send(reply);
                });
            }
            Ok(Op::Answer { id, allow }) => {
                if let Some(tx) = pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(if allow { Answer::Allow } else { Answer::Deny });
                }
            }
            _ => {
                let _ = out_tx.send(json!({"event": "error", "message": "bad request"}));
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

fn event_json(e: &AgentEvent) -> Value {
    match e {
        AgentEvent::Text { delta } => json!({"event": "text", "delta": delta}),
        AgentEvent::ToolStarted { id, name } => json!({"event": "tool_started", "id": id, "name": name}),
        AgentEvent::ToolFinished { id, ok } => json!({"event": "tool_finished", "id": id, "ok": ok}),
        other => json!({"event": "other", "detail": format!("{other:?}")}),
    }
}

fn write_private(path: &std::path::Path, text: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(path);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap_or_else(|e| die(&format!("secret: {e}")));
        f.write_all(text.as_bytes()).unwrap_or_else(|e| die(&format!("secret: {e}")));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, text);
        die("the runner is not built for this system yet");
    }
}

fn set_private(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .unwrap_or_else(|e| die(&format!("socket: {e}")));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn die(msg: &str) -> ! {
    eprintln!("moss-runner: {msg}");
    std::process::exit(2);
}
