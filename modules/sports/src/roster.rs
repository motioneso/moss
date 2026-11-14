//! Team lists and club search over ESPN, with the install-wide cache in front.
use crate::catalog::{self, ENTRIES};
use crate::espn::{self, TeamRef};
use crate::identity::Team;
use crate::public_cache::{self as cache, Store};
use crate::teams::TeamList;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

/// Live roster fetches one search may make. Further uncached leagues are skipped.
pub const SEARCH_WARM_FILL_CAP: usize = 5;
pub const SEARCH_RESULT_CAP: usize = 30;

pub struct Roster {
    pub teams: Vec<TeamRef>,
    pub degraded: bool,
}

fn parse_cached(value: &Value) -> Option<Vec<TeamRef>> {
    serde_json::from_value(value.clone()).ok()
}

/// Reads one league from a loaded store, fetching and caching on a miss. A provider failure
/// returns an empty, degraded list and caches nothing.
fn fetch_into<H: Host + ?Sized>(host: &H, store: &mut Store, key: &str, now: i64) -> Roster {
    let fetched = espn::teams_url(key)
        .and_then(|url| espn::fetch_json(host, &url))
        .map(|data| espn::parse_teams(&data, key));
    match fetched {
        Ok(teams) => {
            if let Ok(value) = serde_json::to_value(&teams) {
                store.put(key, value, cache::TEAMS_TTL_MS, now);
            }
            Roster { teams, degraded: false }
        }
        Err(_) => Roster { teams: vec![], degraded: true },
    }
}

/// `GET /leagues/:competitionKey/teams`. A news-only competition has no ESPN roster.
pub fn league_teams<H: Host + ?Sized>(host: &H, key: &str) -> Result<Roster> {
    if catalog::entry(key).is_some_and(|e| e.news_feed_url.is_some()) {
        return Ok(Roster { teams: vec![], degraded: false });
    }
    let now = cache::now_ms(host)?;
    let mut store = Store::load(host, cache::TEAMS)?;
    if let Some(teams) = store.get(key, now).and_then(parse_cached) {
        return Ok(Roster { teams, degraded: false });
    }
    let roster = fetch_into(host, &mut store, key, now);
    store.save(host);
    Ok(roster)
}

pub struct Search {
    pub teams: Vec<TeamRef>,
    pub partial: bool,
    pub degraded: bool,
}

/// Club search across every league. Cached rosters are read for free. Uncached ones are fetched
/// live until `SEARCH_WARM_FILL_CAP` is spent, and the rest are skipped with `partial` set.
pub fn search<H: Host + ?Sized>(host: &H, query: &str) -> Result<Search> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return Ok(Search { teams: vec![], partial: false, degraded: false });
    }
    let now = cache::now_ms(host)?;
    let mut store = Store::load(host, cache::TEAMS)?;
    let (mut found, mut warmed, mut partial, mut degraded) = (vec![], 0, false, false);
    for entry in ENTRIES.iter().filter(|e| e.news_feed_url.is_none()) {
        let roster = match store.get(entry.key, now).and_then(parse_cached) {
            Some(teams) => teams,
            None if warmed >= SEARCH_WARM_FILL_CAP => {
                partial = true;
                continue;
            }
            None => {
                warmed += 1;
                let roster = fetch_into(host, &mut store, entry.key, now);
                degraded |= roster.degraded;
                roster.teams
            }
        };
        found.extend(
            roster
                .into_iter()
                .filter(|t| format!("{} {}", t.name, t.short_name).to_lowercase().contains(&q)),
        );
    }
    store.save(host);
    found.truncate(SEARCH_RESULT_CAP);
    Ok(Search { teams: found, partial, degraded })
}

pub fn roster_body(roster: &Roster) -> Value {
    json!({"teams": roster.teams.iter().map(TeamRef::public).collect::<Vec<_>>(), "degraded": roster.degraded})
}

pub fn search_body(found: &Search) -> Value {
    json!({
        "teams": found.teams.iter().map(TeamRef::public).collect::<Vec<_>>(),
        "partial": found.partial, "degraded": found.degraded,
    })
}

/// The team list the follow rules read. An outage reads as an empty list.
pub struct EspnTeams<'a, H: Host + ?Sized>(pub &'a H);
impl<H: Host + ?Sized> TeamList for EspnTeams<'_, H> {
    fn teams(&self, competition_key: &str) -> Vec<Team> {
        match league_teams(self.0, competition_key) {
            Ok(r) => r
                .teams
                .into_iter()
                .map(|t| Team {
                    team_key: t.team_key,
                    abbreviation: t.abbreviation,
                    name: t.name,
                    source_team_id: t.source_team_id,
                })
                .collect(),
            Err(_) => vec![],
        }
    }
}
