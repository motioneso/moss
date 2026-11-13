//! Writing the briefing text. The run job asks a `Composer` for the finished run. The
//! composition that gathers sources and calls a model through the router is a later part, so
//! the only composer here returns the fixed fallback text and makes no model call.
use crate::run_job::Deadline;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

/// Stored when nothing could be gathered. The run table requires non-blank text.
pub const EMPTY_FALLBACK: &str = "Briefing did not produce visible source items.";

/// What a finished composition hands to the run job.
#[derive(Debug, Clone, PartialEq)]
pub struct Composed {
    pub status: &'static str,
    pub summary_text: String,
    pub source_metadata: Value,
}

/// The definition fields a composer may read.
pub struct Subject<'a> {
    pub definition_id: &'a str,
    pub briefing_type: &'a str,
    pub selected_tools: &'a [String],
    /// Composition checks this between steps so an overrun stops early.
    pub deadline: &'a Deadline,
}

pub trait Composer {
    fn compose<H: Host + ?Sized>(&self, host: &H, subject: &Subject<'_>) -> Result<Composed>;
}

/// The plain digest used when there is no model or the model fails. It carries no source text.
pub fn fallback(reason: &str) -> Composed {
    Composed {
        status: "succeeded",
        summary_text: EMPTY_FALLBACK.into(),
        source_metadata: json!({
            "aiModel": null,
            "gaps": [],
            "calendarSignals": [],
            "emailSignals": [],
            "degraded": true,
            "degradedReason": reason,
            "structuredPayload": {"version":1,"actionRows":[],"catchUp":null},
        }),
    }
}

/// Always answers with the fallback, so no source is read and no model is called.
pub struct StubComposer;

impl Composer for StubComposer {
    fn compose<H: Host + ?Sized>(&self, _host: &H, _subject: &Subject<'_>) -> Result<Composed> {
        Ok(fallback("no_model"))
    }
}
