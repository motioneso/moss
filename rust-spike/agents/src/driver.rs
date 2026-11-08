//! What every agent driver shares: how it is launched, what it reports, how it asks.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::confine::Confinement;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    OpenCode,
}

impl AgentKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
        }
    }
}

/// The Moss tool server an agent should load, as a plain command line.
#[derive(Debug, Clone)]
pub struct ToolServer {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Everything needed to start one agent process for one account.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub kind: AgentKind,
    pub program: PathBuf,
    /// The account's working folder. The agent starts here and may read and write inside it.
    pub cwd: PathBuf,
    /// The complete environment. The runner builds it; nothing is inherited.
    pub env: Vec<(String, String)>,
    /// A model id the agent itself reported. `None` lets the driver pick the cheapest one.
    pub model: Option<String>,
    pub tools: Option<ToolServer>,
    pub confinement: Option<Confinement>,
}

/// An agent's request to use one of its own tools, normalised across the three protocols.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionAsk {
    /// The real tool name from the agent's own protocol. Never the display title.
    pub tool_name: Option<String>,
    pub tool_call_id: String,
    /// Display text only; it never decides.
    pub title: String,
    pub raw_input: Value,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Allow,
    Deny,
}

pub type ApproveFuture = Pin<Box<dyn Future<Output = Answer> + Send>>;

/// Decides each permission ask. The runner wires this to the policy and, when the policy says
/// ask, to a person.
pub type Approver = Arc<dyn Fn(PermissionAsk) -> ApproveFuture + Send + Sync>;

/// Progress the driver reports while a turn runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text { delta: String },
    ToolStarted { id: String, name: String },
    ToolFinished { id: String, ok: bool },
    Permission { tool: Option<String>, answer: Answer },
}

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// One finished turn.
#[derive(Debug, Clone, Serialize)]
pub struct TurnOutcome {
    pub text: String,
    pub tools_used: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("could not start the agent: {0}")]
    Launch(String),
    #[error("agent protocol error: {0}")]
    Protocol(String),
    #[error("agent refused a request: {0}")]
    Rpc(String),
    #[error("agent stopped: {0}")]
    Exited(String),
    #[error("agent went quiet: {0}")]
    Timeout(String),
    #[error("agent is not signed in: {0}")]
    NotSignedIn(String),
}
