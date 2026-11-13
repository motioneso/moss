//! Every error code and fixed message the legacy Backtrack code can return.
//!
//! The code table in `tests/codes.rs` fails when this list and the legacy list differ.
use serde_json::{json, Value};

/// Codes a Mac can receive from the ingest route (the last three come from the Mac link check). Each has one status and one fixed message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Unavailable,
    Paused,
    Clock,
    NotLinked,
    PendingApproval,
    Deactivated,
}

pub const ALL: [Code; 6] =
    [Code::Unavailable, Code::Paused, Code::Clock, Code::NotLinked, Code::PendingApproval, Code::Deactivated];

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unavailable => "backtrack_unavailable",
            Code::Paused => "backtrack_paused",
            Code::Clock => "backtrack_clock",
            Code::NotLinked => "companion_credential_invalid",
            Code::PendingApproval => "account_pending_approval",
            Code::Deactivated => "account_deactivated",
        }
    }

    pub fn status(self) -> u16 {
        match self {
            Code::Unavailable | Code::Paused => 409,
            Code::Clock => 422,
            Code::NotLinked => 401,
            Code::PendingApproval | Code::Deactivated => 403,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Code::Unavailable => "Backtrack storage is not turned on for this Moss yet",
            Code::Paused => "Recording is paused from Moss",
            Code::Clock => "This Mac's clock looks wrong",
            Code::NotLinked => "This Mac is no longer linked",
            Code::PendingApproval => "Account is pending approval",
            Code::Deactivated => "Account has been deactivated",
        }
    }

    pub fn body(self) -> Value {
        json!({"error": self.message(), "code": self.as_str()})
    }
}

/// The `message` text of each 400 the delete route can return.
pub const RANGE_MESSAGES: [&str; 5] = [
    "Send a from and to, or nothing",
    "Send both from and to, or neither",
    "from and to must be timestamps",
    "from must be before to",
    "A range can span at most 31 days",
];
