//! Chat through the Moss runner. The shell and Today screens still use sample data.
//!
//! The runner's socket and secret are owner-only files in its data folder, so only a program
//! running as the same OS user can open a chat.
//!
//! A turn runs on its own thread over one socket held for the whole turn, so an approval
//! answer reaches the connection that asked. The drawer polls the thread meanwhile.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::chat_approvals::{self, Book, Record};
use moss_shell_contract::stub::StubShellData;
use moss_shell_contract::{
    ApprovalKind, ApprovalState, ChatError, ChatMessage, ChatRole, ChatThread, Decision,
    SendMessage, ShellData, ShellView, TodayView,
};
use serde_json::{json, Value};

/// How long a turn may run, however busy the agent is.
const TURN_LIMIT: Duration = Duration::from_secs(15 * 60);
/// A turn with nothing pending and no word from the runner this long has stalled.
const IDLE_LIMIT: Duration = Duration::from_secs(300);
/// A pending approval expires this long after it is raised. The runner's own timer is one
/// minute longer, as a backstop.
const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);
const TICK: Duration = Duration::from_millis(250);

#[derive(Clone, Copy)]
pub struct Limits {
    pub turn: Duration,
    pub idle: Duration,
    pub approval_ttl: Duration,
    pub tick: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            turn: TURN_LIMIT,
            idle: IDLE_LIMIT,
            approval_ttl: APPROVAL_TTL,
            tick: TICK,
        }
    }
}

struct OpenTurn {
    /// The held socket's write half. Answers to the runner go through it.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

#[derive(Default)]
struct State {
    messages: Vec<ChatMessage>,
    turn: Option<OpenTurn>,
    book: Book,
    completed: Vec<moss_shell_contract::CompletedWrite>,
}

struct Inner {
    root: PathBuf,
    account: String,
    tools: crate::chat_tools::Source,
    limits: Limits,
    state: Mutex<State>,
}

pub struct RunnerShellData {
    sample: StubShellData,
    inner: Arc<Inner>,
}

impl RunnerShellData {
    pub fn new(root: PathBuf, account: String, tools: crate::chat_tools::Source) -> Self {
        Self::with_limits(root, account, tools, Limits::default())
    }

    pub fn with_limits(
        root: PathBuf,
        account: String,
        tools: crate::chat_tools::Source,
        limits: Limits,
    ) -> Self {
        Self {
            sample: StubShellData::default(),
            inner: Arc::new(Inner {
                root,
                account,
                tools,
                limits,
                state: Mutex::new(State::default()),
            }),
        }
    }
}

fn send_line(writer: &Mutex<Box<dyn Write + Send>>, v: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let mut w = writer.lock().map_err(|_| "socket lock")?;
    w.write_all(&line)
        .and_then(|_| w.flush())
        .map_err(|e| e.to_string())
}

impl Inner {
    fn thread(&self) -> ChatThread {
        let st = self.state.lock().expect("chat lock");
        ChatThread {
            status: if st.book.has_pending() {
                "Waiting for your approval".into()
            } else {
                "Connected".into()
            },
            model_label: "Your agent".into(),
            messages: st.messages.clone(),
            running: st.turn.is_some(),
            approvals: st.book.views(&self.account),
            completed: st.completed.clone(),
        }
    }

    /// Answers every record whose time ran out. The runner is told no at that moment.
    fn expire(&self, now: Instant) {
        let mut st = self.state.lock().expect("chat lock");
        let refused = st.book.expire(now);
        if let Some(turn) = &st.turn {
            for id in refused {
                let _ = send_line(&turn.writer, &json!({"op":"answer","id":id,"allow":false}));
            }
        }
    }

    fn decide(&self, actor: &str, id: &str, decision: Decision) -> Result<ChatThread, ChatError> {
        self.expire(Instant::now());
        {
            let mut st = self.state.lock().expect("chat lock");
            let writer = st.turn.as_ref().ok_or(ChatError::Closed)?.writer.clone();
            let (runner_id, allow) = st.book.decide(actor, id, decision)?;
            send_line(
                &writer,
                &json!({"op":"answer","id":runner_id,"allow":allow}),
            )
            .map_err(|_| ChatError::Closed)?;
        }
        Ok(self.thread())
    }

    #[cfg(unix)]
    fn run_turn(&self, message: &SendMessage, turn_id: &str) -> Result<String, String> {
        let secret = std::fs::read_to_string(self.root.join("runner.secret"))
            .map_err(|e| format!("cannot read the runner secret: {e}"))?;
        let stream = std::os::unix::net::UnixStream::connect(self.root.join("runner.sock"))
            .map_err(|e| format!("the runner is not running: {e}"))?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(
            stream.try_clone().map_err(|e| e.to_string())?,
        )));
        {
            let mut st = self.state.lock().expect("chat lock");
            let open = st.turn.as_mut().ok_or("the turn is not open")?;
            open.writer = writer.clone();
        }
        send_line(&writer, &json!({"op": "hello", "secret": secret.trim()}))?;
        let tools = self.tools.list()?;
        let mut turn = ToolTurn::new(tools.clone(), turn_id.to_owned())?;
        send_line(
            &writer,
            &json!({"op": "chat", "account": self.account, "text": message.text, "tools": tools, "turn_id": turn.id, "fresh_conversation": message.fresh_conversation}),
        )?;

        let (lines, events) = std::sync::mpsc::channel::<Result<Value, String>>();
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                match line {
                    Ok(line) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            if lines.send(Ok(v)).is_err() {
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = lines.send(Err(format!("lost the runner: {e}")));
                        return;
                    }
                }
            }
            let _ = lines.send(Err("the runner closed the chat".into()));
        });

        let started = Instant::now();
        let mut last_heard = started;
        let outcome = loop {
            self.expire(Instant::now());
            if started.elapsed() >= self.limits.turn {
                break Err("this turn ran longer than the 15 minute limit".to_string());
            }
            let waiting = self.state.lock().expect("chat lock").book.has_pending();
            // Time spent waiting on the person is not the runner going quiet.
            if waiting {
                last_heard = Instant::now();
            }
            if !waiting && last_heard.elapsed() >= self.limits.idle {
                break Err("the runner stopped answering".to_string());
            }
            let m = match events.recv_timeout(self.limits.tick) {
                Ok(Ok(m)) => m,
                Ok(Err(e)) => break Err(e),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break Err("the runner closed the chat".into()),
            };
            last_heard = Instant::now();
            match m["event"].as_str() {
                Some("tool_call") => {
                    let (ok, text) =
                        match turn.dispatch_with(&m, &*self.tools, |module, tool, parameters| {
                            self.state.lock().expect("chat lock").book.consume(
                                &self.account,
                                &turn_id,
                                module,
                                tool,
                                parameters,
                            )
                        }) {
                            Ok(text) => {
                                if turn
                                    .plain_writes
                                    .contains(m["name"].as_str().unwrap_or_default())
                                {
                                    if let Some(done) = crate::chat_completed::from_reply(
                                        m["call_id"].as_str().unwrap_or_default(),
                                        &text,
                                    ) {
                                        let mut st = self.state.lock().expect("chat lock");
                                        st.completed.push(done);
                                        if st.completed.len() > 200 {
                                            st.completed.remove(0);
                                        }
                                    }
                                }
                                (true, text)
                            }
                            Err(e) => (false, e),
                        };
                    if let Err(e) = send_line(
                        &writer,
                        &json!({"op":"tool_result", "call_id":m["call_id"], "ok":ok, "text":text}),
                    ) {
                        break Err(e);
                    }
                }
                Some("approval") => {
                    if let Err(error) = self.raise_approval(&m, &turn) {
                        if let Err(e) = send_line(
                            &writer,
                            &json!({"op": "answer", "id": m["id"], "allow": false,"error":error}),
                        ) {
                            break Err(e);
                        }
                    }
                }
                Some("done") => {
                    break Ok(m["text"].as_str().unwrap_or_default().to_string());
                }
                Some("error") => {
                    break Err(m["message"]
                        .as_str()
                        .unwrap_or("the runner failed")
                        .to_string());
                }
                _ => {}
            }
        };
        // Closing the socket tells the runner to end its side of the turn.
        let _ = stream.shutdown(std::net::Shutdown::Both);
        outcome
    }

    #[cfg(not(unix))]
    fn run_turn(&self, _: &SendMessage, _: &str) -> Result<String, String> {
        Err("the runner is not built for this system yet".into())
    }

    /// Store only a card built by the host for a tool offered in this open turn, or a fixed
    /// agent permission disclosure. Preparation failure is returned to the model as a tool error.
    fn raise_approval(
        &self,
        m: &Value,
        turn: &ToolTurn,
    ) -> Result<(), moss_agents::gateway::PreparationError> {
        let failure = |message: &str| moss_agents::gateway::PreparationError {
            code: "approval_preparation_failed".into(),
            message: message.into(),
        };
        let Some(runner_id) = m["id"].as_u64() else {
            return Err(failure("Approval request is not available for this turn"));
        };
        let tool = m["card"]["tool"].as_str().unwrap_or("unknown");
        let parameters = &m["card"]["input"];
        let (kind, title, target, fields, content, danger, batch, action) =
            match m["card"]["source"].as_str() {
                Some("agent") => (
                    ApprovalKind::Permission,
                    chat_approvals::PERMISSION_TITLE.into(),
                    "Your agent is asking to use a tool.".into(),
                    chat_approvals::permission_fields(tool, parameters),
                    None,
                    false,
                    false,
                    None,
                ),
                Some("moss") => {
                    let Some(module) = turn.offered.get(tool) else {
                        return Err(failure("Approval request is not available for this turn"));
                    };
                    let name = tool.replace('_', ".");
                    let card = self.tools.card(module, &name, parameters)?;
                    let action = chat_approvals::Action {
                        module: module.clone(),
                        tool: name,
                        parameters: parameters.clone(),
                        version: card.version,
                    };
                    (
                        ApprovalKind::Action,
                        card.title,
                        card.target,
                        card.fields
                            .into_iter()
                            .map(|f| moss_shell_contract::CardField {
                                label: f.label,
                                value: f.value,
                            })
                            .collect(),
                        card.content,
                        card.danger,
                        card.batch,
                        Some(action),
                    )
                }
                _ => return Err(failure("Unknown approval request")),
            };
        let mut st = self.state.lock().expect("chat lock");
        st.book.add(Record {
            id: uuid::Uuid::new_v4(),
            actor: self.account.clone(),
            turn: turn.id.clone(),
            kind,
            runner_id,
            title,
            target,
            fields,
            content,
            danger,
            batch,
            action,
            expires: Instant::now() + self.limits.approval_ttl,
            state: ApprovalState::Pending,
        });
        Ok(())
    }

    fn finish_turn(&self, turn_id: &str, result: Result<String, String>) {
        let text = match result {
            Ok(reply) => reply,
            Err(e) => format!("Moss could not reach your agent: {e}"),
        };
        let mut st = self.state.lock().expect("chat lock");
        // No approval outlives its turn.
        st.book.void_turn(turn_id);
        let n = st.messages.len();
        st.messages.push(ChatMessage {
            id: format!("m{}", n + 1),
            role: ChatRole::Assistant,
            text,
        });
        st.turn = None;
    }
}

impl ShellData for RunnerShellData {
    fn shell(&self) -> ShellView {
        self.sample.shell()
    }

    fn today(&self) -> TodayView {
        self.sample.today()
    }

    fn chat_thread(&self) -> ChatThread {
        self.inner.thread()
    }

    fn send_message(&self, message: &SendMessage) -> Result<ChatThread, ChatError> {
        let turn_id = uuid::Uuid::new_v4().to_string();
        {
            let mut st = self.inner.state.lock().expect("chat lock");
            if st.turn.is_some() {
                return Err(ChatError::Busy);
            }
            if message.fresh_conversation {
                st.messages.clear();
                st.book.clear();
                st.completed.clear();
            }
            let n = st.messages.len();
            st.messages.push(ChatMessage {
                id: format!("m{}", n + 1),
                role: ChatRole::User,
                text: message.text.clone(),
            });
            st.turn = Some(OpenTurn {
                writer: Arc::new(Mutex::new(Box::new(std::io::sink()))),
            });
        }
        let (inner, message) = (self.inner.clone(), message.clone());
        std::thread::spawn(move || {
            let result = inner.run_turn(&message, &turn_id);
            inner.finish_turn(&turn_id, result);
        });
        Ok(self.inner.thread())
    }

    fn decide_approval(
        &self,
        actor: &str,
        id: &str,
        decision: Decision,
    ) -> Result<ChatThread, ChatError> {
        self.inner.decide(actor, id, decision)
    }
}

/// The socket owns this snapshot for exactly one turn. Only definitions sent in its chat op
/// can select a module; the runner never supplies a module id or an actor.
struct ToolTurn {
    id: String,
    offered: std::collections::HashMap<String, String>,
    used: std::collections::HashSet<String>,
    plain_writes: std::collections::HashSet<String>,
}
impl ToolTurn {
    fn new(tools: Vec<moss_agents::gateway::ToolDef>, id: String) -> Result<Self, String> {
        let mut names = std::collections::HashSet::new();
        let mut offered = std::collections::HashMap::new();
        let mut plain_writes = std::collections::HashSet::new();
        for def in tools {
            if def.facts.risk == moss_agents::approvals::Risk::Write && def.facts.execution_auto {
                plain_writes.insert(def.name.clone());
            }
            if !names.insert(def.name.clone()) {
                return Err("Duplicate offered tool name".into());
            }
            if let Some(module) = def.module {
                offered.insert(def.name, module);
            }
        }
        Ok(Self {
            id,
            offered,
            used: Default::default(),
            plain_writes,
        })
    }
    #[cfg(test)]
    fn dispatch(
        &mut self,
        event: &Value,
        tools: &dyn crate::chat_tools::ChatTools,
    ) -> Result<String, String> {
        self.dispatch_with(event, tools, |_, _, _| None)
    }
    fn dispatch_with(
        &mut self,
        event: &Value,
        tools: &dyn crate::chat_tools::ChatTools,
        approved: impl FnOnce(&str, &str, &Value) -> Option<chat_approvals::Action>,
    ) -> Result<String, String> {
        let id = event["call_id"].as_str().unwrap_or_default();
        let valid_id = id
            .strip_prefix(&format!("{}:", self.id))
            .and_then(|n| n.parse::<u64>().ok())
            .is_some_and(|n| n > 0);
        if !valid_id || !self.used.insert(id.to_owned()) {
            eprintln!("moss-server: refused invalid or repeated chat call id");
            return Err("Tool call does not belong to this open turn".into());
        }
        let name = event["name"].as_str().unwrap_or_default();
        let module = self.offered.get(name).ok_or_else(|| {
            eprintln!("moss-server: refused unoffered chat tool");
            "Tool was not offered for this turn".to_string()
        })?;
        let tool = name.replace('_', ".");
        let parameters = event["arguments"].clone();
        if let Some(action) = approved(module, &tool, &parameters) {
            tools.run_approved(module, &tool, parameters, action.version.as_deref())
        } else {
            tools.run(module, &tool, parameters)
        }
    }
}

#[cfg(test)]
#[path = "runner_data_tests.rs"]
mod tests;
