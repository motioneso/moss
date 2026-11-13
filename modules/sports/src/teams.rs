//! The provider's team list for one competition. The provider arrives in a later part, so the
//! default list is empty, which the follow rules treat as an outage.
use crate::identity::Team;

pub trait TeamList {
    fn teams(&self, competition_key: &str) -> Vec<Team>;
}

/// No provider connected yet.
pub struct Unavailable;
impl TeamList for Unavailable {
    fn teams(&self, _competition_key: &str) -> Vec<Team> {
        Vec::new()
    }
}
