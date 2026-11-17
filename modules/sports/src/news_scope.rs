//! Which ESPN feeds the person's coverage setting lets the overview read.
use crate::catalog;
use crate::followed::Follow;
use serde_json::Value;

/// A sport, one competition of it, or one club of that competition.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub sport: &'a str,
    pub competition: Option<&'a str>,
    pub team: Option<&'a str>,
}

/// An assignment covers a request for the same sport, and for anything inside it.
fn covers(assigned: &Scope, wanted: &Scope) -> bool {
    if assigned.sport != wanted.sport {
        return false;
    }
    let Some(competition) = assigned.competition else { return true };
    if wanted.competition != Some(competition) {
        return false;
    }
    match assigned.team {
        None => true,
        Some(team) => wanted.team == Some(team),
    }
}

/// True when the coverage is on and either default or names something that covers `wanted`.
pub fn allows(coverage: &Value, follows: &[Follow], wanted: &Scope) -> bool {
    if coverage["enabled"].as_bool() != Some(true) {
        return false;
    }
    if coverage["usesDefaultCoverage"].as_bool() == Some(true) {
        return true;
    }
    coverage["assignments"].as_array().into_iter().flatten().any(|target| match target["kind"].as_str() {
        Some("sport") => target["sportKey"].as_str().is_some_and(|sport| covers(&Scope { sport, competition: None, team: None }, wanted)),
        Some("follow") => {
            let Some(follow) = follows.iter().find(|f| Some(f.id.as_str()) == target["followId"].as_str()) else { return false };
            let Some(entry) = catalog::entry(&follow.competition_key) else { return false };
            let assigned = Scope { sport: entry.espn_sport, competition: Some(&follow.competition_key), team: follow.team_key.as_deref() };
            covers(&assigned, wanted)
        }
        _ => false,
    })
}

/// The scope of a whole competition.
pub fn competition(key: &str) -> Option<Scope<'_>> {
    catalog::entry(key).map(|e| Scope { sport: e.espn_sport, competition: Some(key), team: None })
}

/// The scope of one club in a competition.
pub fn team<'a>(key: &'a str, team_key: &'a str) -> Option<Scope<'a>> {
    catalog::entry(key).map(|e| Scope { sport: e.espn_sport, competition: Some(key), team: Some(team_key) })
}
