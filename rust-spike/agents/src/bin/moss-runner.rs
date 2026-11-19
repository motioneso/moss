//! The runner process. Owns every account's agent; the app talks to it over a private socket.
//!
//!   moss-runner <config.json>
//!
//! Config: `{"root": DIR, "gateway_bin": PATH, "confine_bin": PATH|null,
//!           "accounts": {"<user-id>": {"kind": "claude", "program": PATH,
//!             "sign_in_home": DIR, "person_home": false, "model": null}}}`
//!
//! `person_home: true` allows the person's own home as the sign-in folder. The agent can then
//! write files that run at login, so confinement is no boundary; the runner logs a warning.
//!
//! Each configured account brings its own agent sign-in folder.
//!
//! The socket (`<root>/runner.sock`) and the secret (`<root>/runner.secret`) are owner-only.
//! Every connection opens with `{"op":"hello","secret":...}`; a wrong secret closes it.
//! Then, one line of JSON each way:
//!
//!   -> {"op":"chat","account":"<signed-in-user-id>","text":"...","tools":[...],"turn_id":"<uuid>"}
//!   <- {"event":"text","delta":"..."} | {"event":"tool_started",...} | {"event":"tool_finished",...}
//!   <- {"event":"approval","id":1,"card":{"tool":...,"title":...,"input":...}}
//!   -> {"op":"answer","id":1,"allow":true}
//!   <- {"event":"tool_call","call_id":"<turn>:1","name":"scratchpad_read","arguments":{}}
//!   -> {"op":"tool_result","call_id":"<turn>:1","ok":true,"text":"..."}
//!   <- {"event":"done","text":"...","tools_used":[...]} | {"event":"error","message":"..."}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use moss_agents::builtins::BuiltinTools;
use moss_agents::driver::*;
use moss_agents::gateway::ToolDef;
use moss_agents::runner::*;
use moss_agents::tool_bridge::ToolBridge;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Deserialize)]
struct Config {
    root: PathBuf,
    gateway_bin: PathBuf,
    confine_bin: Option<PathBuf>,
    accounts: HashMap<String, AgentConfig>,
}

#[derive(Deserialize)]
struct AgentConfig {
    kind: String,
    program: PathBuf,
    sign_in_home: PathBuf,
    /// Lets the agent use the person's own home as its sign-in folder. Confinement is then no
    /// boundary, because the agent can write files that run at login.
    #[serde(default)]
    person_home: bool,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Hello {
        secret: String,
    },
    Chat {
        account: String,
        text: String,
        tools: Vec<ToolDef>,
        turn_id: String,
        #[serde(default)]
        fresh_conversation: bool,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        call_id: String,
        ok: bool,
        text: String,
    },
    Answer {
        id: u64,
        allow: bool,
    },
}

#[tokio::main]
async fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| die("usage: moss-runner <config.json>"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| die(&format!("config: {e}")));
    let cfg: Config = serde_json::from_str(&raw).unwrap_or_else(|e| die(&format!("config: {e}")));
    std::fs::create_dir_all(&cfg.root).unwrap_or_else(|e| die(&format!("root: {e}")));
    let accounts: HashMap<String, AccountSetup> = cfg
        .accounts
        .into_iter()
        .map(|(account, agent)| {
            if !valid_account(&account) {
                die("invalid configured account id");
            }
            let kind = AgentKind::parse(&agent.kind).unwrap_or_else(|| die("account agent.kind"));
            (
                account,
                AccountSetup {
                    kind,
                    program: agent.program,
                    sign_in_home: agent.sign_in_home,
                    person_home: agent.person_home,
                    model: agent.model,
                },
            )
        })
        .collect();
    let accounts = Arc::new(accounts);
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
    if accounts.values().any(|s| s.person_home) {
        eprintln!(
            "moss-runner: confinement on {}: not a boundary (the agent signs in from the person's own \
             home folder, so it can read it and write files that run at login)",
            status.os
        );
    } else {
        eprintln!(
            "moss-runner: confinement on {}: {} ({})",
            status.os, status.enforced, status.detail
        );
    }

    let secret = moss_agents::hello::random_secret();
    let secret_path = cfg.root.join("runner.secret");
    let socket = cfg.root.join("runner.sock");
    write_private(&secret_path, &secret);
    let _ = std::fs::remove_file(&socket);
    let listener =
        tokio::net::UnixListener::bind(&socket).unwrap_or_else(|e| die(&format!("socket: {e}")));
    set_private(&socket);
    eprintln!("moss-runner: listening on {}", socket.display());

    let secret = Arc::new(secret);
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let (runner, accounts, secret) = (runner.clone(), accounts.clone(), secret.clone());
        tokio::spawn(async move {
            let _ = serve(stream, runner, accounts, secret).await;
        });
    }
}

async fn serve(
    stream: tokio::net::UnixStream,
    runner: Arc<Runner>,
    accounts: Arc<HashMap<String, AccountSetup>>,
    secret: Arc<String>,
) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Some(first) = lines.next_line().await? else {
        return Ok(());
    };
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
    let active: Arc<Mutex<Option<Arc<ToolBridge>>>> = Arc::default();
    while let Ok(Some(line)) = lines.next_line().await {
        match serde_json::from_str::<Op>(&line) {
            Ok(Op::Chat { ref account, .. }) if !accounts.contains_key(account) => {
                let _ = out_tx.send(json!({"event": "error", "message": "This runner has no agent for that account."}));
            }
            Ok(Op::Chat {
                account,
                text,
                tools,
                turn_id,
                fresh_conversation,
            }) => {
                if active.lock().unwrap().is_some() {
                    let _ = out_tx.send(
                        json!({"event":"error", "message":"A turn is already open on this socket"}),
                    );
                    continue;
                }
                let sender = out_tx.clone();
                let bridge = Arc::new(ToolBridge::new(
                    account.clone(),
                    turn_id,
                    Arc::new(move |event| sender.send(event).is_ok()),
                ));
                *active.lock().unwrap() = Some(bridge.clone());
                let active_turn = active.clone();
                let setup = Arc::new(accounts[&account].clone());
                let (runner, setup, out, pending, next_id) = (
                    runner.clone(),
                    setup.clone(),
                    out_tx.clone(),
                    pending.clone(),
                    next_id.clone(),
                );
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
                    let reply = match runner
                        .chat_with_bridge(
                            &account,
                            &setup,
                            &text,
                            &events,
                            ask,
                            tools,
                            Some(bridge.clone()),
                            fresh_conversation,
                        )
                        .await
                    {
                        Ok(t) => {
                            json!({"event": "done", "text": t.text, "tools_used": t.tools_used})
                        }
                        // The detail can hold agent output, so it stays in the runner's log.
                        Err(e) => {
                            eprintln!(
                                "moss-runner: {account}: {}",
                                moss_agents::redact::redact_line(&e.to_string())
                            );
                            json!({"event": "error", "message": "The agent stopped with an error. Details are in the Moss log."})
                        }
                    };
                    bridge.close();
                    *active_turn.lock().unwrap() = None;
                    let _ = out.send(reply);
                });
            }
            Ok(Op::ToolResult { call_id, ok, text }) => {
                let accepted = active
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|b| b.result(&call_id, ok, text));
                if !accepted {
                    eprintln!("moss-runner: refused unmatched tool result");
                }
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
    if let Some(bridge) = active.lock().unwrap().take() {
        bridge.close();
    }
    pending.lock().unwrap().clear();
    drop(out_tx);
    writer.abort();
    Ok(())
}

fn event_json(e: &AgentEvent) -> Value {
    match e {
        AgentEvent::Text { delta } => json!({"event": "text", "delta": delta}),
        AgentEvent::ToolStarted { id, name } => {
            json!({"event": "tool_started", "id": id, "name": name})
        }
        AgentEvent::ToolFinished { id, ok } => {
            json!({"event": "tool_finished", "id": id, "ok": ok})
        }
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
        f.write_all(text.as_bytes())
            .unwrap_or_else(|e| die(&format!("secret: {e}")));
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn runner_requires_the_hello_secret_before_ready() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(Runner::new(
            RunnerConfig {
                root: dir.path().into(),
                gateway_bin: "/bin/true".into(),
                confine_bin: None,
            },
            Arc::new(BuiltinTools),
            plain_facts(),
        ));
        let (client, server) = tokio::net::UnixStream::pair().unwrap();
        let task = tokio::spawn(serve(
            server,
            runner,
            Arc::new(HashMap::new()),
            Arc::new("expected".into()),
        ));
        let (read, mut write) = client.into_split();
        write
            .write_all(b"{\"op\":\"hello\",\"secret\":\"wrong\"}\n")
            .await
            .unwrap();
        let mut lines = BufReader::new(read).lines();
        // Keep the write half open: an EOF would abort the server writer before a weakened
        // hello check can flush its ready event, making this assertion pass either way.
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect("hello check did not close or answer")
            .unwrap();
        assert!(
            first.is_none(),
            "wrong hello secret opened a turn socket"
        );
        task.await.unwrap().unwrap();
    }

    #[test]
    fn chat_op_carries_tools_and_config_has_distinct_account_setups() {
        let tools = vec![moss_agents::builtins::current_time()];
        let op = json!({"op":"chat", "account":"alice", "text":"hello", "tools":tools, "turn_id":"turn-a"});
        let Op::Chat { account, tools, .. } = serde_json::from_value(op).unwrap() else {
            panic!("chat")
        };
        assert_eq!(account, "alice");
        assert_eq!(tools[0].facts.risk, moss_agents::approvals::Risk::Read);
        assert_eq!(tools[0].name, "current_time");
        let cfg: Config =
            serde_json::from_value(json!({"root":"/r", "gateway_bin":"/g", "accounts": {
                "alice":{"kind":"claude","program":"/claude","sign_in_home":"/a"},
                "bob":{"kind":"codex","program":"/codex","sign_in_home":"/b"}
            }}))
            .unwrap();
        assert_eq!(cfg.accounts.len(), 2);
        assert_ne!(
            cfg.accounts["alice"].sign_in_home,
            cfg.accounts["bob"].sign_in_home
        );
    }
}
