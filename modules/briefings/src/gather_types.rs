//! Shapes and caps shared by every gathered source.
use serde_json::{json, Value};

/// Most lines one section may keep.
pub const SECTION_ITEM_CAP: usize = 8;
/// Most characters one section may keep, counted over its lines.
pub const SECTION_CHAR_CAP: usize = 1200;
pub const COMPLETED_TASK_CAP: usize = 5;
pub const AWAITING_EMAIL_CAP: usize = 5;
pub const WORTH_KNOWING_CAP: usize = 2;
pub const COMPLETED_MARK: &str = "[completed since last briefing]";

/// Why a source gave nothing, or less than it could.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    ToolFailed,
    Truncated,
    Empty,
    /// The module that owns the source is not built in this app yet.
    Unwired,
    /// A connected account needs the person to sign in or grant access again.
    SourceAuth,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::ToolFailed => "tool_failed",
            Reason::Truncated => "truncated",
            Reason::Empty => "empty",
            Reason::Unwired => "unwired",
            Reason::SourceAuth => "source_auth",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gap {
    pub source: &'static str,
    pub reason: Reason,
}

impl Gap {
    pub fn to_json(&self) -> Value {
        json!({"source": self.source, "reason": self.reason.as_str()})
    }
}

/// One source's cleaned lines. `raw` keeps the module's own items for later steps.
#[derive(Debug, Clone, Default)]
pub struct Section {
    pub key: &'static str,
    pub label: &'static str,
    pub lines: Vec<String>,
    pub count: usize,
    pub raw: Vec<Value>,
}

impl Section {
    pub fn empty(key: &'static str, label: &'static str) -> Self {
        Self { key, label, ..Default::default() }
    }
}

/// Keeps the first lines that fit the item and character caps. The flag says something was cut.
pub fn cap_lines(lines: Vec<String>) -> (Vec<String>, bool) {
    cap_lines_to(lines, SECTION_ITEM_CAP)
}

/// As `cap_lines`, with the item cap chosen by the caller.
pub fn cap_lines_to(lines: Vec<String>, max_items: usize) -> (Vec<String>, bool) {
    let mut truncated = lines.len() > max_items;
    let mut kept = Vec::new();
    let mut total = 0;
    for line in lines.into_iter().take(max_items) {
        let size = line.chars().count();
        if total + size > SECTION_CHAR_CAP {
            truncated = true;
            break;
        }
        total += size;
        kept.push(line);
    }
    (kept, truncated)
}
