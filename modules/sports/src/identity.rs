//! Which team a saved follow means. A follow means the team whose permanent provider id it
//! stored, and nothing else. A follow saved without one matches nothing until the person says
//! which team they meant.

/// One team from the provider's list for a competition.
#[derive(Clone, Debug, PartialEq)]
pub struct Team {
    pub team_key: String,
    pub abbreviation: Option<String>,
    pub name: String,
    pub source_team_id: Option<String>,
}

pub struct Saved<'a> {
    pub team_key: Option<&'a str>,
    pub source_team_id: Option<&'a str>,
}

#[derive(Debug, PartialEq)]
pub struct Resolved {
    pub team: Option<Team>,
    pub source_team_id: Option<String>,
    pub catalog_key: Option<String>,
    pub needs_choice: bool,
    pub candidates: Vec<Team>,
    pub team_list_loaded: bool,
}

/// Looks one saved follow up in today's team list.
pub fn resolve(saved: &Saved, teams: &[Team]) -> Resolved {
    let team_list_loaded = !teams.is_empty();
    if let Some(id) = saved.source_team_id {
        let team = teams.iter().find(|t| t.source_team_id.as_deref() == Some(id)).cloned();
        return Resolved {
            catalog_key: team.as_ref().map(|t| t.team_key.clone()),
            team,
            source_team_id: Some(id.to_owned()),
            needs_choice: false,
            candidates: Vec::new(),
            team_list_loaded,
        };
    }
    // The saved short name only orders the choices. Every team stays reachable.
    let answers = |t: &Team| {
        saved
            .team_key
            .is_some_and(|k| t.abbreviation.as_deref() == Some(k) || t.team_key == k)
    };
    let mut candidates: Vec<Team> = teams.iter().filter(|t| answers(t)).cloned().collect();
    candidates.extend(teams.iter().filter(|t| !answers(t)).cloned());
    Resolved {
        team: None,
        source_team_id: None,
        catalog_key: None,
        needs_choice: true,
        candidates,
        team_list_loaded,
    }
}

/// The identity handed to game and standings matching: a permanent id, or nothing.
pub fn match_target(resolved: &Resolved) -> Option<&str> {
    resolved.source_team_id.as_deref()
}

/// A game side or standings row belongs to the followed team only when both carry the same
/// permanent id. A row without one can no longer be claimed.
pub fn side_matches(side_source_team_id: Option<&str>, target: &str) -> bool {
    side_source_team_id == Some(target)
}
