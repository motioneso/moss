//! One agent session behind one type, whichever program it is.

use crate::acp::AcpSession;
use crate::claude::ClaudeSession;
use crate::codex::CodexSession;
use crate::driver::*;

pub enum AgentSession {
    Claude(ClaudeSession),
    Codex(CodexSession),
    OpenCode(AcpSession),
}

impl AgentSession {
    pub async fn start(spec: &LaunchSpec, approver: Approver) -> Result<Self, AgentError> {
        Ok(match spec.kind {
            AgentKind::Claude => Self::Claude(ClaudeSession::start(spec, approver).await?),
            AgentKind::Codex => Self::Codex(CodexSession::start(spec, approver).await?),
            AgentKind::OpenCode => Self::OpenCode(AcpSession::start(spec, approver).await?),
        })
    }

    pub async fn prompt(&mut self, text: &str, events: &EventSink) -> Result<TurnOutcome, AgentError> {
        match self {
            Self::Claude(s) => s.prompt(text, events).await,
            Self::Codex(s) => s.prompt(text, events).await,
            Self::OpenCode(s) => s.prompt(text, events).await,
        }
    }

    pub fn model(&self) -> &str {
        match self {
            Self::Claude(s) => &s.model,
            Self::Codex(s) => &s.model,
            Self::OpenCode(s) => &s.model,
        }
    }

    pub fn pid(&self) -> Option<u32> {
        match self {
            Self::Claude(s) => s.pid(),
            Self::Codex(s) => s.pid(),
            Self::OpenCode(s) => s.pid(),
        }
    }

    pub async fn shutdown(self) {
        match self {
            Self::Claude(s) => s.shutdown().await,
            Self::Codex(s) => s.shutdown().await,
            Self::OpenCode(s) => s.shutdown().await,
        }
    }
}
