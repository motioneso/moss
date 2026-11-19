//! Chat through the Moss runner. The shell and Today screens still use sample data.
//!
//! The runner's socket and secret are owner-only files in its data folder, so only a program
//! running as the same OS user can open a chat. The drawer has no approval card yet, so every
//! card the runner raises is answered no and the reply says so.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use moss_shell_contract::stub::StubShellData;
use moss_shell_contract::{
    ChatMessage, ChatRole, ChatThread, SendMessage, ShellData, ShellView, TodayView,
};
use serde_json::{json, Value};

pub struct RunnerShellData {
    root: PathBuf,
    account: String,
    sample: StubShellData,
    messages: Mutex<Vec<ChatMessage>>,
    tools: crate::chat_tools::Source,
    turn_lock: Mutex<()>,
}

impl RunnerShellData {
    pub fn new(root: PathBuf, account: String, tools: crate::chat_tools::Source) -> Self {
        Self {
            root,
            account,
            sample: StubShellData::default(),
            messages: Mutex::new(Vec::new()),
            tools,
            turn_lock: Mutex::new(()),
        }
    }

    #[cfg(unix)]
    fn ask_runner(&self, message: &SendMessage) -> Result<(String, usize), String> {
        let secret = std::fs::read_to_string(self.root.join("runner.secret"))
            .map_err(|e| format!("cannot read the runner secret: {e}"))?;
        let stream = std::os::unix::net::UnixStream::connect(self.root.join("runner.sock"))
            .map_err(|e| format!("the runner is not running: {e}"))?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(300)))
            .map_err(|e| e.to_string())?;
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let mut send = |v: Value| -> Result<(), String> {
            let mut line = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
            line.push(b'\n');
            writer.write_all(&line).map_err(|e| e.to_string())
        };
        send(json!({"op": "hello", "secret": secret.trim()}))?;
        let tools = self.tools.list()?;
        let mut turn = ToolTurn::new(tools.clone())?;
        send(
            json!({"op": "chat", "account": self.account, "text": message.text, "tools": tools, "turn_id": turn.id, "fresh_conversation": message.fresh_conversation}),
        )?;

        let mut refused = 0;
        for line in BufReader::new(stream).lines() {
            let line = line.map_err(|e| format!("lost the runner: {e}"))?;
            let Ok(m) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match m["event"].as_str() {
                Some("tool_call") => {
                    let result = turn.dispatch(&m, &*self.tools);
                    let (ok, text) = match result {
                        Ok(text) => (true, text),
                        Err(e) => (false, e),
                    };
                    send(
                        json!({"op":"tool_result", "call_id":m["call_id"], "ok":ok, "text":text}),
                    )?;
                }
                Some("approval") => {
                    refused += 1;
                    send(json!({"op": "answer", "id": m["id"], "allow": false}))?;
                }
                Some("done") => {
                    return Ok((m["text"].as_str().unwrap_or_default().to_string(), refused));
                }
                Some("error") => {
                    return Err(m["message"]
                        .as_str()
                        .unwrap_or("the runner failed")
                        .to_string());
                }
                _ => {}
            }
        }
        Err("the runner closed the chat".into())
    }

    #[cfg(not(unix))]
    fn ask_runner(&self, _: &SendMessage) -> Result<(String, usize), String> {
        Err("the runner is not built for this system yet".into())
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
        ChatThread {
            status: "Connected".into(),
            model_label: "Your agent".into(),
            messages: self.messages.lock().expect("chat lock").clone(),
        }
    }

    fn send_message(&self, message: &SendMessage) -> ChatMessage {
        let _turn = self.turn_lock.lock().expect("turn lock");
        let n = {
            let mut m = self.messages.lock().expect("chat lock");
            if message.fresh_conversation {
                m.clear();
            }
            let n = m.len();
            m.push(ChatMessage {
                id: format!("m{}", n + 1),
                role: ChatRole::User,
                text: message.text.clone(),
            });
            n + 1
        };
        let text = match self.ask_runner(message) {
            Ok((reply, 0)) => reply,
            Ok((reply, refused)) => format!(
                "{reply}\n\n({refused} action(s) needed your approval. Approvals are not in this \
                 window yet, so they were declined.)"
            ),
            Err(e) => format!("Moss could not reach your agent: {e}"),
        };
        let reply = ChatMessage {
            id: format!("m{}", n + 1),
            role: ChatRole::Assistant,
            text,
        };
        self.messages.lock().expect("chat lock").push(reply.clone());
        reply
    }
}

/// The socket owns this snapshot for exactly one turn. Only definitions sent in its chat op
/// can select a module; the runner never supplies a module id or an actor.
struct ToolTurn {
    id: String,
    offered: std::collections::HashMap<String, String>,
    used: std::collections::HashSet<String>,
}
impl ToolTurn {
    fn new(tools: Vec<moss_agents::gateway::ToolDef>) -> Result<Self, String> {
        let mut names = std::collections::HashSet::new();
        let mut offered = std::collections::HashMap::new();
        for def in tools {
            if !names.insert(def.name.clone()) {
                return Err("Duplicate offered tool name".into());
            }
            if let Some(module) = def.module {
                offered.insert(def.name, module);
            }
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            offered,
            used: Default::default(),
        })
    }
    fn dispatch(
        &mut self,
        event: &Value,
        tools: &dyn crate::chat_tools::ChatTools,
    ) -> Result<String, String> {
        let id = event["call_id"].as_str().unwrap_or_default();
        let valid_id = id
            .strip_prefix(&format!("{}:", self.id))
            .and_then(|n| n.parse::<u64>().ok())
            .is_some_and(|n| n > 0);
        if !valid_id || !self.used.insert(id.to_owned()) {
            eprintln!("moss-shell: refused invalid or repeated chat call id");
            return Err("Tool call does not belong to this open turn".into());
        }
        let name = event["name"].as_str().unwrap_or_default();
        let module = self.offered.get(name).ok_or_else(|| {
            eprintln!("moss-shell: refused unoffered chat tool");
            "Tool was not offered for this turn".to_string()
        })?;
        tools.run(module, &name.replace('_', "."), event["arguments"].clone())
    }
}

#[cfg(test)]
#[path = "runner_data_tests.rs"]
mod tests;
