//! Newline-delimited JSON over a child process's stdin and stdout.
//!
//! All three agents speak one JSON value per line. Claude's stream mode uses its own message
//! shapes; Codex's app server and OpenCode's ACP server use JSON-RPC 2.0. This module owns the
//! child, the line framing and request ids, and nothing protocol-specific.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

use crate::driver::{AgentError, LaunchSpec};

/// A running agent process with framed JSON lines in both directions.
pub struct JsonLines {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    incoming: mpsc::Receiver<Value>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl JsonLines {
    pub fn spawn(spec: &LaunchSpec, args: &[String]) -> Result<Self, AgentError> {
        let (program, args) = match &spec.confinement {
            Some(c) => c.wrap(&spec.program, args),
            None => (spec.program.clone(), args.to_vec()),
        };
        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // The agent gets only the variables the runner chose. Nothing is inherited, so a
        // database address or sign-in secret in the runner's own environment never reaches it.
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| AgentError::Launch(format!("{}: {e}", spec.program.display())))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdin = child.stdin.take().expect("piped stdin");

        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Non-JSON lines (banners, stray logs) are dropped, never parsed as protocol.
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if tx.send(v).await.is_err() {
                        break;
                    }
                }
            }
        });

        // Keep the last stderr lines for error reports. They are shown redacted, never logged raw.
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut t = tail.lock().await;
                t.push(crate::redact::redact_line(&line));
                if t.len() > 20 {
                    t.remove(0);
                }
            }
        });

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            incoming: rx,
            stderr_tail,
        })
    }

    pub async fn send(&self, value: &Value) -> Result<(), AgentError> {
        let mut line = serde_json::to_vec(value).expect("json");
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&line)
            .await
            .map_err(|e| AgentError::Protocol(format!("write to agent: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| AgentError::Protocol(format!("flush to agent: {e}")))
    }

    /// Next message, or an error naming the agent's last words if it exits or goes quiet.
    pub async fn recv(&mut self, timeout: Duration) -> Result<Value, AgentError> {
        match tokio::time::timeout(timeout, self.incoming.recv()).await {
            Ok(Some(v)) => Ok(v),
            Ok(None) => Err(AgentError::Exited(self.stderr_summary().await)),
            Err(_) => Err(AgentError::Timeout(self.stderr_summary().await)),
        }
    }

    pub async fn stderr_summary(&self) -> String {
        self.stderr_tail.lock().await.join(" | ")
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn shutdown(mut self) {
        drop(self.stdin);
        if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

/// JSON-RPC 2.0 on top of `JsonLines`, for Codex's app server and ACP agents.
///
/// Requests from us wait for their response; requests from the agent (approvals) and
/// notifications are handed back to the caller in arrival order.
pub struct JsonRpc {
    pub lines: JsonLines,
    next_id: AtomicU64,
    /// Responses that arrived while we were waiting on a different id.
    parked: HashMap<u64, Value>,
}

/// Something the agent sent that is not a response to one of our requests.
#[derive(Debug, Clone)]
pub enum Inbound {
    Notification { method: String, params: Value },
    Request { id: Value, method: String, params: Value },
    Response { id: u64, result: Result<Value, Value> },
}

impl JsonRpc {
    pub fn new(lines: JsonLines) -> Self {
        Self {
            lines,
            next_id: AtomicU64::new(1),
            parked: HashMap::new(),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), AgentError> {
        self.lines
            .send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    pub async fn start_request(&self, method: &str, params: Value) -> Result<u64, AgentError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.lines
            .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        Ok(id)
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), AgentError> {
        self.lines
            .send(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), AgentError> {
        self.lines
            .send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}))
            .await
    }

    pub async fn next(&mut self, timeout: Duration) -> Result<Inbound, AgentError> {
        let v = self.lines.recv(timeout).await?;
        Ok(classify(v))
    }

    /// Send a request and wait for its answer, answering nothing else on the way. Only for
    /// setup calls, before any turn can raise an approval.
    pub async fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, AgentError> {
        let id = self.start_request(method, params).await?;
        if let Some(v) = self.parked.remove(&id) {
            return response_result(method, v);
        }
        loop {
            match self.next(timeout).await? {
                Inbound::Response { id: got, result } if got == id => {
                    return result.map_err(|e| AgentError::Rpc(format!("{method}: {e}")));
                }
                Inbound::Response { id: other, result } => {
                    self.parked.insert(other, result.unwrap_or_else(|e| json!({"error": e})));
                }
                Inbound::Request { id, method: m, .. } => {
                    // No approval is expected during setup; refuse rather than guess.
                    self.respond_error(id, -32601, &format!("{m} not available during setup"))
                        .await?;
                }
                Inbound::Notification { .. } => {}
            }
        }
    }
}

fn response_result(method: &str, v: Value) -> Result<Value, AgentError> {
    match v.get("error") {
        Some(e) => Err(AgentError::Rpc(format!("{method}: {e}"))),
        None => Ok(v),
    }
}

fn classify(v: Value) -> Inbound {
    let method = v.get("method").and_then(Value::as_str).map(str::to_string);
    let id = v.get("id").cloned();
    match (method, id) {
        (Some(method), Some(id)) if !id.is_null() => Inbound::Request {
            id,
            method,
            params: v.get("params").cloned().unwrap_or(Value::Null),
        },
        (Some(method), _) => Inbound::Notification {
            method,
            params: v.get("params").cloned().unwrap_or(Value::Null),
        },
        (None, id) => {
            let id = id.and_then(|i| i.as_u64()).unwrap_or(0);
            let result = match v.get("error") {
                Some(e) => Err(e.clone()),
                None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            };
            Inbound::Response { id, result }
        }
    }
}
