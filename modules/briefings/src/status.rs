//! The read state of one run. A stored row is ready. Without a row only the caller's own manual
//! job for that run counts, and a finished job without a row is gone. Nothing here waits or polls.
use crate::queue::{Job, JobState};

#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    Ready { latest: bool },
    Pending,
    Failed,
    NotFound,
}

pub struct Facts<'a> {
    /// The run row exists, belongs to the caller and belongs to this definition.
    pub row: bool,
    pub first_run_id: Option<&'a str>,
    pub run_id: &'a str,
    pub definition_id: &'a str,
    pub job: Option<&'a Job>,
}

pub fn resolve(facts: &Facts<'_>) -> Resolved {
    if facts.row {
        return Resolved::Ready { latest: facts.first_run_id == Some(facts.run_id) };
    }
    match facts.job {
        Some(job)
            if job.run_id.as_deref() == Some(facts.run_id)
                && job.definition_id.as_deref() == Some(facts.definition_id) =>
        {
            match job.state {
                JobState::Pending => Resolved::Pending,
                JobState::Completed => Resolved::NotFound,
                JobState::Failed => Resolved::Failed,
            }
        }
        _ => Resolved::NotFound,
    }
}
