//! The host half of the Moss tool gateway.
//!
//! Each agent loads `moss-tool-gateway` as a tool server. That program holds no tools and no
//! secrets: it connects back here over a private socket, proves itself with the lease it was
//! given, and forwards `list` and `call`. Every call is routed through `approvals::route`, so a
//! write the person has not trusted waits for their answer before it runs.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::approvals::{route, CallFacts, Risk, Route, ToolFacts};
use crate::driver::Answer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    /// Bare name. Agents see it as `mcp__moss__<name>` (Claude, Codex) or `moss_<name>` (OpenCode).
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    pub description: String,
    pub input_schema: Value,
    pub facts: ToolFacts,
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Where tools come from. The app supplies these; the gateway only routes.
pub trait ToolHost: Send + Sync + 'static {
    fn tools(&self, account: &str) -> Vec<ToolDef>;
    /// `account` is the account whose gateway accepted the call, so the host can scope it.
    fn call(&self, account: &str, name: &str, args: Value) -> ToolFuture;
}

/// A safe preparation failure is different from a person's refusal.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationError {
    pub code: String,
    pub message: String,
}
pub type Confirmation = Result<Answer, PreparationError>;
pub type ConfirmFuture = Pin<Box<dyn Future<Output = Confirmation> + Send>>;
/// Shows the person an approval card and waits for their answer.
pub type Confirm = Arc<dyn Fn(String, Value) -> ConfirmFuture + Send + Sync>;
/// The live facts for one call: YOLO switch, taint, marks. Read at call time, never cached.
pub type CallFactsFn = Arc<dyn Fn() -> CallFacts + Send + Sync>;

/// What the gateway program sends.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum GatewayOp {
    Hello { lease: String },
    List,
    Call { name: String, arguments: Value },
}

pub struct GatewayHost {
    pub socket: PathBuf,
    /// Owner-only file holding the lease. Only its path goes into the agent's launch, because
    /// any process of the same OS user can read another's command line.
    pub lease_file: PathBuf,
    task: tokio::task::JoinHandle<()>,
    changed: tokio::sync::watch::Sender<u64>,
}

impl Drop for GatewayHost {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_file(&self.lease_file);
    }
}

impl GatewayHost {
    pub fn tools_changed(&self) {
        self.changed
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    /// Listens on a new owner-only socket in `dir` and writes the lease beside it. `dir` must be
    /// the account's own folder, which confinement keeps other accounts out of.
    #[cfg(unix)]
    pub fn start(
        account: &str,
        dir: &Path,
        host: Arc<dyn ToolHost>,
        confirm: Confirm,
        facts: CallFactsFn,
    ) -> std::io::Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let lease = crate::hello::random_secret();
        let name = &crate::hello::random_secret()[..12];
        let socket = dir.join(format!("gw-{name}.sock"));
        let lease_file = dir.join(format!("gw-{name}.lease"));
        let _ = std::fs::remove_file(&lease_file);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&lease_file)?
            .write_all(lease.as_bytes())?;
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let expected = lease.clone();
        let account = account.to_string();
        let (changed, _) = tokio::sync::watch::channel(0);
        let notifications = changed.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (host, confirm, facts, expected, account) = (
                    host.clone(),
                    confirm.clone(),
                    facts.clone(),
                    expected.clone(),
                    account.clone(),
                );
                let changes = notifications.subscribe();
                tokio::spawn(async move {
                    let _ =
                        serve_one(stream, &expected, &account, host, confirm, facts, changes).await;
                });
            }
        });
        Ok(Self {
            socket,
            lease_file,
            task,
            changed,
        })
    }

    /// Keep the library available to the Windows shell without claiming socket support there.
    #[cfg(not(unix))]
    pub fn start(
        _account: &str,
        _dir: &Path,
        _host: Arc<dyn ToolHost>,
        _confirm: Confirm,
        _facts: CallFactsFn,
    ) -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "The agent tool gateway requires Unix sockets",
        ))
    }
}

#[cfg(unix)]
async fn serve_one(
    stream: tokio::net::UnixStream,
    expected: &str,
    account: &str,
    host: Arc<dyn ToolHost>,
    confirm: Confirm,
    facts: CallFactsFn,
    mut changes: tokio::sync::watch::Receiver<u64>,
) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    // The first line must be the right lease, or the connection closes with nothing said.
    let Some(first) = lines.next_line().await? else {
        return Ok(());
    };
    match serde_json::from_str::<GatewayOp>(&first) {
        Ok(GatewayOp::Hello { lease }) if crate::hello::same_secret(&lease, expected) => {}
        _ => return Ok(()),
    }
    write.write_all(b"{\"ok\":true}\n").await?;

    loop {
        let line = tokio::select! {
            line = lines.next_line() => match line? { Some(line) => line, None => break },
            changed = changes.changed() => {
                if changed.is_err() { break; }
                write.write_all(b"{\"event\":\"list_changed\"}\n").await?;
                continue;
            }
        };
        let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let reply = async {
            match serde_json::from_value::<GatewayOp>(request.clone()) {
                Ok(GatewayOp::List) => json!({"tools": host.tools(account)}),
                Ok(GatewayOp::Call { name, arguments }) => {
                    call_tool(&*host, &confirm, &facts, account, &name, arguments).await
                }
                _ => json!({"error": "bad request"}),
            }
        };
        tokio::pin!(reply);
        let mut reply = loop {
            tokio::select! {
                reply = &mut reply => break reply,
                changed = changes.changed() => {
                    if changed.is_err() { return Ok(()); }
                    write.write_all(b"{\"event\":\"list_changed\"}\n").await?;
                }
            }
        };
        reply["id"] = request["id"].clone();
        let mut out = serde_json::to_vec(&reply).expect("json");
        out.push(b'\n');
        write.write_all(&out).await?;
    }
    Ok(())
}

/// Routes one call. Public so the runner's tests can drive the approval path without an agent.
pub async fn call_tool(
    host: &dyn ToolHost,
    confirm: &Confirm,
    facts: &CallFactsFn,
    account: &str,
    name: &str,
    arguments: Value,
) -> Value {
    let Some(def) = host.tools(account).into_iter().find(|t| t.name == name) else {
        return json!({"isError": true, "text": format!("Moss has no tool called {name}.")});
    };
    let decision = route(&def.facts, &facts());
    let allowed = match decision {
        Route::AutoRun | Route::YoloRun => true,
        Route::Confirm | Route::YoloConfirm => {
            match confirm(name.to_string(), arguments.clone()).await {
                Ok(answer) => answer == Answer::Allow,
                Err(error) => {
                    return json!({"isError":true,"route":decision,
                    "code":error.code,"text":error.message})
                }
            }
        }
    };
    if !allowed {
        return json!({"isError": true, "route": decision, "text": "The person did not approve this action."});
    }
    // Metadata only. A plain read claims nothing.
    let approval = match decision {
        Route::Confirm | Route::YoloConfirm => Some("approved"),
        Route::YoloRun => Some("policy"),
        Route::AutoRun if def.facts.risk != Risk::Read => Some("policy"),
        Route::AutoRun => None,
    };
    let (is_error, text) = match host.call(account, name, arguments).await {
        Ok(text) => (false, text),
        Err(text) => (true, text),
    };
    let mut reply = json!({"isError": is_error, "route": decision, "text": text});
    if let Some(approval) = approval {
        reply["approval"] = json!(approval);
    }
    reply
}

/// The text the model reads for a finished call. Prepends one plain line saying how the
/// action was cleared, so the model never tells the person no approval happened.
pub fn model_text(reply: &Value) -> String {
    let text = reply["text"].as_str().unwrap_or("No answer from Moss.");
    let is_error = reply["isError"] != false;
    match reply["approval"].as_str() {
        Some("approved") if !is_error => {
            format!("[Approval: the person approved this action on its card before it ran.]\n{text}")
        }
        Some("approved") => format!(
            "[Approval: the person approved this action on its card, but it then failed.]\n{text}"
        ),
        Some("policy") => format!(
            "[Approval: no card was shown because the person's settings let this action run without one.]\n{text}"
        ),
        _ => text.to_string(),
    }
}

#[cfg(all(test, unix))]
#[path = "gateway_tests.rs"]
mod tests;
