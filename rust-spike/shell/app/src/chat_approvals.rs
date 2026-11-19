//! Approval records for one chat account, kept in memory beside its messages.
//!
//! The browser sees `ApprovalView`s only. Raw tool parameters stay here and never leave.

use moss_shell_contract::{
    ApprovalKind, ApprovalState, ApprovalView, CardField, ChatError, Decision,
};
use serde_json::Value;
use std::time::Instant;
use uuid::Uuid;

/// Records kept for the thread. The oldest answered ones drop first.
const MAX_RECORDS: usize = 50;
const FIELD_CAP: usize = 500;

#[derive(Clone, Debug)]
pub struct Action {
    pub module: String,
    pub tool: String,
    pub parameters: Value,
    pub version: Option<String>,
}

pub struct Record {
    pub id: Uuid,
    pub actor: String,
    pub turn: String,
    pub kind: ApprovalKind,
    /// The runner's own id. The browser never sees it.
    pub runner_id: u64,
    pub title: String,
    pub fields: Vec<CardField>,
    pub target: String,
    pub content: Option<String>,
    pub danger: bool,
    pub action: Option<Action>,
    pub expires: Instant,
    pub state: ApprovalState,
}

#[derive(Default)]
pub struct Book {
    records: Vec<Record>,
}

impl Book {
    pub fn add(&mut self, record: Record) {
        self.records.push(record);
        while self.records.len() > MAX_RECORDS {
            match self
                .records
                .iter()
                .position(|r| r.state != ApprovalState::Pending)
            {
                Some(i) => self.records.remove(i),
                None => break,
            };
        }
    }

    pub fn clear(&mut self) {
        self.records.clear();
    }

    pub fn has_pending(&self) -> bool {
        self.records
            .iter()
            .any(|r| r.state == ApprovalState::Pending)
    }

    /// Moves every pending record past its deadline to `TimedOut`. Returns the runner ids the
    /// caller must now answer with a refusal.
    pub fn expire(&mut self, now: Instant) -> Vec<u64> {
        let mut refused = Vec::new();
        for r in &mut self.records {
            if r.state == ApprovalState::Pending && now >= r.expires {
                r.state = ApprovalState::TimedOut;
                refused.push(r.runner_id);
            }
        }
        refused
    }

    /// Answers one pending record for `actor`. Returns the runner id and whether to allow.
    /// A record that is not this actor's is reported as unknown.
    pub fn decide(
        &mut self,
        actor: &str,
        id: &str,
        decision: Decision,
    ) -> Result<(u64, bool), ChatError> {
        let record = self
            .records
            .iter_mut()
            .find(|r| r.id.to_string() == id && r.actor == actor)
            .ok_or(ChatError::NotFound)?;
        if record.state != ApprovalState::Pending {
            return Err(ChatError::Closed);
        }
        let allow = decision == Decision::Approve;
        // An agent permission ask has no later call to match. The answer itself uses the
        // approval up, so an approved agent record goes straight to `Used`.
        record.state = match (allow, record.kind) {
            (false, _) => ApprovalState::Declined,
            (true, ApprovalKind::Permission) => ApprovalState::Used,
            (true, ApprovalKind::Action) => ApprovalState::Approved,
        };
        Ok((record.runner_id, allow))
    }

    /// Ends every record of a finished turn that was not used. No approval outlives its turn.
    pub fn void_turn(&mut self, turn: &str) {
        for r in &mut self.records {
            if r.turn == turn && matches!(r.state, ApprovalState::Pending | ApprovalState::Approved)
            {
                r.state = ApprovalState::Voided;
            }
        }
    }

    /// Only the exact approved action in the current actor's open turn can mint a host grant.
    pub fn consume(
        &mut self,
        actor: &str,
        turn: &str,
        module: &str,
        tool: &str,
        parameters: &Value,
    ) -> Option<Action> {
        let record = self.records.iter_mut().find(|r| {
            r.actor == actor
                && r.turn == turn
                && r.state == ApprovalState::Approved
                && r.action.as_ref().is_some_and(|a| {
                    a.module == module && a.tool == tool && a.parameters == *parameters
                })
        })?;
        record.state = ApprovalState::Used;
        record.action.clone()
    }

    pub fn views(&self, actor: &str) -> Vec<ApprovalView> {
        self.records
            .iter()
            .filter(|r| r.actor == actor)
            .map(|r| ApprovalView {
                id: r.id.to_string(),
                kind: r.kind,
                state: r.state,
                title: r.title.clone(),
                fields: r.fields.clone(),
                danger: r.danger,
                target: r.target.clone(),
                content: r.content.clone(),
            })
            .collect()
    }
}

/// Title of an agent permission card. Fixed text, never the agent's own `title`.
pub const PERMISSION_TITLE: &str = "Permission request";

/// Labelled values for an agent permission card. Everything here came from the agent, so it
/// only ever appears as a field value, hidden where it looks like a secret and capped in size.
pub fn permission_fields(tool: &str, input: &Value) -> Vec<CardField> {
    let mut fields = vec![field("Tool", tool)];
    let mut shown = false;
    for (label, keys) in [
        ("Command", &["command", "cmd"][..]),
        ("Path", &["path", "file_path", "filePath"][..]),
    ] {
        for key in keys {
            if let Some(text) = text_of(&input[*key]) {
                fields.push(field(label, &text));
                shown = true;
            }
        }
    }
    if !shown && !input.is_null() {
        fields.push(field("Details", &input.to_string()));
    }
    fields
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        _ => None,
    }
}

fn field(label: &str, value: &str) -> CardField {
    let value = moss_agents::redact::redact_line(value);
    let value = if value.chars().count() > FIELD_CAP {
        let cut: String = value.chars().take(FIELD_CAP).collect();
        format!("{cut}…")
    } else {
        value
    };
    CardField {
        label: label.into(),
        value,
    }
}

#[cfg(test)]
#[path = "chat_approvals_tests.rs"]
mod tests;
