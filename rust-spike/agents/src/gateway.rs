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

use crate::approvals::{route, CallFacts, Route, ToolFacts};
use crate::driver::Answer;

#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    /// Bare name. Agents see it as `mcp__moss__<name>` (Claude, Codex) or `moss_<name>` (OpenCode).
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip)]
    pub facts: ToolFacts,
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Where tools come from. The app supplies these; the gateway only routes.
pub trait ToolHost: Send + Sync + 'static {
    fn tools(&self) -> Vec<ToolDef>;
    fn call(&self, name: &str, args: Value) -> ToolFuture;
}

pub type ConfirmFuture = Pin<Box<dyn Future<Output = Answer> + Send>>;
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
    lease: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for GatewayHost {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl GatewayHost {
    /// Listens on a new owner-only socket in `dir`. The lease goes to the agent's tool server
    /// only, through its launch environment.
    #[cfg(unix)]
    pub fn start(
        dir: &Path,
        host: Arc<dyn ToolHost>,
        confirm: Confirm,
        facts: CallFactsFn,
    ) -> std::io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        let lease = crate::hello::random_secret();
        let socket = dir.join(format!("gw-{}.sock", &lease[..12]));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let expected = lease.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (host, confirm, facts, expected) =
                    (host.clone(), confirm.clone(), facts.clone(), expected.clone());
                tokio::spawn(async move {
                    let _ = serve_one(stream, &expected, host, confirm, facts).await;
                });
            }
        });
        Ok(Self { socket, lease, task })
    }

    pub fn lease(&self) -> &str {
        &self.lease
    }
}

#[cfg(unix)]
async fn serve_one(
    stream: tokio::net::UnixStream,
    expected: &str,
    host: Arc<dyn ToolHost>,
    confirm: Confirm,
    facts: CallFactsFn,
) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    // The first line must be the right lease, or the connection closes with nothing said.
    let Some(first) = lines.next_line().await? else { return Ok(()) };
    match serde_json::from_str::<GatewayOp>(&first) {
        Ok(GatewayOp::Hello { lease }) if crate::hello::same_secret(&lease, expected) => {}
        _ => return Ok(()),
    }
    write.write_all(b"{\"ok\":true}\n").await?;

    while let Some(line) = lines.next_line().await? {
        let reply = match serde_json::from_str::<GatewayOp>(&line) {
            Ok(GatewayOp::List) => json!({"tools": host.tools()}),
            Ok(GatewayOp::Call { name, arguments }) => {
                call_tool(&*host, &confirm, &facts, &name, arguments).await
            }
            _ => json!({"error": "bad request"}),
        };
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
    name: &str,
    arguments: Value,
) -> Value {
    let Some(def) = host.tools().into_iter().find(|t| t.name == name) else {
        return json!({"isError": true, "text": format!("Moss has no tool called {name}.")});
    };
    let decision = route(&def.facts, &facts());
    let allowed = match decision {
        Route::AutoRun | Route::YoloRun => true,
        Route::Confirm | Route::YoloConfirm => confirm(name.to_string(), arguments.clone()).await == Answer::Allow,
    };
    if !allowed {
        return json!({"isError": true, "route": decision, "text": "The person did not approve this action."});
    }
    match host.call(name, arguments).await {
        Ok(text) => json!({"isError": false, "route": decision, "text": text}),
        Err(text) => json!({"isError": true, "route": decision, "text": text}),
    }
}
