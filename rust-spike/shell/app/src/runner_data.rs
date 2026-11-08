//! Chat through the Moss runner. The shell and Today screens still use sample data.
//!
//! The runner's socket and secret are owner-only files in its data folder, so only a program
//! running as the same OS user can open a chat. The drawer has no approval card yet, so every
//! card the runner raises is answered no and the reply says so.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use moss_shell_contract::stub::StubShellData;
use moss_shell_contract::{ChatMessage, ChatRole, ChatThread, ShellData, ShellView, TodayView};
use serde_json::{json, Value};

pub struct RunnerShellData {
    root: PathBuf,
    account: String,
    sample: StubShellData,
    messages: Mutex<Vec<ChatMessage>>,
}

impl RunnerShellData {
    pub fn new(root: PathBuf, account: String) -> Self {
        Self {
            root,
            account,
            sample: StubShellData::default(),
            messages: Mutex::new(Vec::new()),
        }
    }

    #[cfg(unix)]
    fn ask_runner(&self, text: &str) -> Result<(String, usize), String> {
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
        send(json!({"op": "chat", "account": self.account, "text": text}))?;

        let mut refused = 0;
        for line in BufReader::new(stream).lines() {
            let line = line.map_err(|e| format!("lost the runner: {e}"))?;
            let Ok(m) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match m["event"].as_str() {
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
    fn ask_runner(&self, _: &str) -> Result<(String, usize), String> {
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

    fn send_message(&self, text: &str) -> ChatMessage {
        let n = {
            let mut m = self.messages.lock().expect("chat lock");
            let n = m.len();
            m.push(ChatMessage {
                id: format!("m{}", n + 1),
                role: ChatRole::User,
                text: text.to_string(),
            });
            n + 1
        };
        let text = match self.ask_runner(text) {
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
