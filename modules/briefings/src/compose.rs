//! Writing the briefing text. The run job asks a `Composer` for the finished run. The
//! composition that calls a model through the router is a later part, so the only composer
//! here gathers the sources and returns the fixed fallback text without a model call.
use crate::external::NoContributors;
use crate::gather::gather;
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

/// Gathers the sources and answers with the fallback text, so no model is called. The saved
/// metadata names gaps, counts and reasons only, never any text a source returned.
pub struct StubComposer;

impl Composer for StubComposer {
    fn compose<H: Host + ?Sized>(&self, host: &H, subject: &Subject<'_>) -> Result<Composed> {
        let gathered = gather(host, subject, &NoContributors)?;
        let mut composed = fallback("no_model");
        if let (Some(into), Some(from)) = (composed.source_metadata.as_object_mut(), gathered.metadata().as_object()) {
            into.extend(from.clone());
        }
        Ok(composed)
    }
}
