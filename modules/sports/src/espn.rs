//! Reads ESPN's public JSON. Every function takes the response body as data, so the parsers run
//! the same way on recorded fixtures and on live answers. The only network edge is `fetch_json`,
//! which goes through the host's fixed-host fetch port.
use crate::catalog::{self, Entry};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

pub const SITE_HOST: &str = "site.api.espn.com";
pub const CONTENT_HOST: &str = "content.core.api.espn.com";
pub const FETCH_HOSTS: [&str; 2] = [SITE_HOST, CONTENT_HOST];
/// Hosts that serve the crest and logo images the responses point at.
pub const IMAGE_HOSTS: [&str; 4] =
    ["a.espncdn.com", "s.espncdn.com", "s.secure.espncdn.com", "espnmedia-cdn.akamaized.net"];

const SITE_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
const CORE_BASE: &str = "https://site.api.espn.com/apis/v2/sports";

/// One team in a competition's list. `abbreviation` stays inside the module and the cache.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub team_key: String,
    pub competition_key: String,
    pub name: String,
    pub short_name: String,
    pub crest_url: Option<String>,
    pub source_team_id: Option<String>,
    pub abbreviation: Option<String>,
}

impl TeamRef {
    /// The shape the routes return, which leaves the abbreviation out.
    pub fn public(&self) -> Value {
        json!({
            "teamKey": self.team_key, "competitionKey": self.competition_key, "name": self.name,
            "shortName": self.short_name, "crestUrl": self.crest_url, "sourceTeamId": self.source_team_id,
        })
    }
}

/// Mirrors JavaScript's `encodeURIComponent`.
pub fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn entry(key: &str) -> Result<&'static Entry> {
    catalog::entry(key).ok_or_else(|| Error::new("Unknown competition"))
}

/// Teams come in pages of this size, because one page of the college leagues is larger than the
/// host's response cap. Leagues with fewer teams than this arrive in the first page.
pub const TEAMS_PAGE_SIZE: usize = 100;
const TEAMS_MAX_PAGES: usize = 12;

pub fn teams_url(competition_key: &str, page: usize) -> Result<String> {
    let e = entry(competition_key)?;
    Ok(format!(
        "{SITE_BASE}/{}/{}/teams?limit={TEAMS_PAGE_SIZE}&page={page}",
        e.espn_sport, e.espn_league
    ))
}

/// Fetches every page of a competition's teams and returns them in the one-page payload shape.
/// A page shorter than the page size is the last. A page that adds no new team stops the walk,
/// because some leagues ignore the page number and repeat the first page.
pub fn fetch_teams<H: Host + ?Sized>(host: &H, competition_key: &str) -> Result<Value> {
    let mut teams: Vec<Value> = vec![];
    let mut seen = std::collections::HashSet::<String>::new();
    for page in 1..=TEAMS_MAX_PAGES {
        let batch = fetch_team_page(host, &teams_url(competition_key, page)?)?;
        let size = batch.len();
        let mut added = 0;
        for team in batch {
            let fresh = match id_text(&team["team"]["id"]) {
                Some(id) => seen.insert(id),
                None => true,
            };
            if fresh {
                teams.push(team);
                added += 1;
            }
        }
        if size < TEAMS_PAGE_SIZE || added == 0 {
            break;
        }
    }
    Ok(json!({"sports": [{"leagues": [{"teams": teams}]}]}))
}

/// The few fields of one ESPN team page the module reads. Reading into this shape instead of a
/// loose tree keeps a multi-page college league inside the per-call instruction budget.
#[derive(serde::Deserialize, Default)]
struct PageShape {
    #[serde(default)]
    sports: Vec<SportShape>,
}
#[derive(serde::Deserialize, Default)]
struct SportShape {
    #[serde(default)]
    leagues: Vec<LeagueShape>,
}
#[derive(serde::Deserialize, Default)]
struct LeagueShape {
    #[serde(default)]
    teams: Vec<TeamEntryShape>,
}
#[derive(serde::Deserialize, Default)]
struct TeamEntryShape {
    #[serde(default)]
    team: TeamShape,
}
#[derive(serde::Deserialize, Default)]
struct TeamShape {
    id: Option<Value>,
    abbreviation: Option<Value>,
    #[serde(rename = "displayName")]
    display_name: Option<Value>,
    #[serde(rename = "shortDisplayName")]
    short_display_name: Option<Value>,
    #[serde(default)]
    logos: Vec<LogoShape>,
}
#[derive(serde::Deserialize, Default)]
struct LogoShape {
    href: Option<Value>,
}

/// One page of teams, cut down to the fields `parse_teams` reads.
fn fetch_team_page<H: Host + ?Sized>(host: &H, url: &str) -> Result<Vec<Value>> {
    let name = url.strip_prefix("https://").and_then(|r| r.split('/').next()).unwrap_or_default();
    let response = host.call("fetch", "get", name, json!({"url": url}))?;
    if !(200..300).contains(&response["status"].as_u64().unwrap_or(0)) {
        return Err(Error::new("ESPN answered with an error status"));
    }
    let body = response["body"].as_str().ok_or_else(|| Error::new("ESPN sent no body"))?;
    let page: PageShape = serde_json::from_str(body)?;
    let teams = page.sports.into_iter().next().and_then(|s| s.leagues.into_iter().next()).map(|l| l.teams);
    Ok(teams
        .unwrap_or_default()
        .into_iter()
        .map(|e| {
            let t = e.team;
            let logos: Vec<Value> = t.logos.into_iter().take(1).map(|l| json!({"href": l.href})).collect();
            json!({"team": {"id": t.id, "abbreviation": t.abbreviation, "displayName": t.display_name,
                "shortDisplayName": t.short_display_name, "logos": logos}})
        })
        .collect())
}

pub fn scoreboard_url(competition_key: &str, day: &str) -> Result<String> {
    let e = entry(competition_key)?;
    let ok = day.len() == 10
        && day.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if !ok {
        return Err(Error::new("Invalid day"));
    }
    Ok(format!("{SITE_BASE}/{}/{}/scoreboard?dates={}", e.espn_sport, e.espn_league, day.replace('-', "")))
}

pub fn standings_url(competition_key: &str) -> Result<String> {
    let e = entry(competition_key)?;
    Ok(format!("{CORE_BASE}/{}/{}/standings?level=3", e.espn_sport, e.espn_league))
}

/// `team` narrows the feed to one club; the numeric id is preferred over the short name.
pub fn headlines_url(competition_key: &str, team: Option<&str>) -> Result<String> {
    let e = entry(competition_key)?;
    let filter = match team {
        Some(t) if !t.is_empty() => format!("?team={}", encode_component(t)),
        _ => String::new(),
    };
    Ok(format!("{SITE_BASE}/{}/{}/news{filter}", e.espn_sport, e.espn_league))
}

/// One GET through the host. A non-success status is an error, like the old fetch helper.
pub fn fetch_json<H: Host + ?Sized>(host: &H, url: &str) -> Result<Value> {
    let name = url.strip_prefix("https://").and_then(|r| r.split('/').next()).unwrap_or_default();
    let response = host.call("fetch", "get", name, json!({"url": url}))?;
    let status = response["status"].as_u64().unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(Error::new("ESPN answered with an error status"));
    }
    let body = response["body"].as_str().ok_or_else(|| Error::new("ESPN sent no body"))?;
    Ok(serde_json::from_str(body)?)
}

// --- Small readers over loose JSON ---------------------------------------------------------

pub(crate) fn at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(value, |v, k| &v[*k])
}

pub(crate) fn text(value: &Value, path: &[&str]) -> Option<String> {
    at(value, path).as_str().map(str::to_owned)
}

/// An id that ESPN may send as a string or a number.
pub(crate) fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

// --- Teams ----------------------------------------------------------------------------------

/// Builds a competition's team list. Abbreviations that repeat inside one list are not safe keys,
/// so those teams get `abbreviation.id`, and any key still repeated gets the id or position added.
pub fn parse_teams(data: &Value, competition_key: &str) -> Vec<TeamRef> {
    let empty = vec![];
    let teams = at(data, &["sports"])[0]["leagues"][0]["teams"].as_array().unwrap_or(&empty);
    let abbreviations: Vec<Option<String>> =
        teams.iter().map(|t| text(&t["team"], &["abbreviation"]).map(|a| a.to_lowercase())).collect();
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    for a in abbreviations.iter().flatten().filter(|a| !a.is_empty()) {
        *counts.entry(a.as_str()).or_default() += 1;
    }
    let count = |a: &str| counts.get(a).copied().unwrap_or(0);
    let mut refs: Vec<TeamRef> = teams
        .iter()
        .zip(&abbreviations)
        .map(|(entry, abbreviation)| {
            let team = &entry["team"];
            let id = id_text(&team["id"]).unwrap_or_default().to_lowercase();
            let ambiguous = abbreviation.as_deref().is_some_and(|a| count(a) > 1);
            let team_key = match abbreviation {
                Some(a) if ambiguous && !id.is_empty() => format!("{a}.{id}"),
                Some(a) => a.clone(),
                None => id.clone(),
            };
            let display = text(team, &["displayName"]);
            TeamRef {
                name: display.clone().unwrap_or_else(|| team_key.clone()),
                short_name: text(team, &["shortDisplayName"])
                    .or(display)
                    .unwrap_or_else(|| team_key.clone()),
                crest_url: text(&team["logos"][0], &["href"]),
                source_team_id: id_text(&team["id"]),
                abbreviation: abbreviation.clone(),
                team_key,
                competition_key: competition_key.to_owned(),
            }
        })
        .collect();
    let mut seen = std::collections::HashMap::<String, usize>::new();
    for r in &refs {
        *seen.entry(r.team_key.clone()).or_default() += 1;
    }
    for (index, r) in refs.iter_mut().enumerate() {
        if seen[&r.team_key] > 1 {
            let suffix = r.source_team_id.clone().unwrap_or_else(|| index.to_string()).to_lowercase();
            r.team_key = format!("{}.{suffix}", r.team_key);
        }
    }
    refs
}

// --- News list ------------------------------------------------------------------------------

pub fn parse_headlines(data: &Value, competition_key: &str) -> Result<Vec<Value>> {
    let e = entry(competition_key)?;
    let empty = vec![];
    let articles = data["articles"].as_array().unwrap_or(&empty);
    Ok(articles
        .iter()
        .enumerate()
        .map(|(index, a)| {
            let images = a["images"].as_array().unwrap_or(&empty);
            let url_of = |i: &&Value| i["url"].as_str().is_some_and(|u| !u.is_empty());
            let image = images
                .iter()
                .find(|i| i["type"] == "header" && url_of(i))
                .or_else(|| images.iter().find(url_of));
            let team_ids: Vec<String> = a["categories"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .filter(|c| c["type"] == "team")
                .filter_map(|c| id_text(&c["teamId"]))
                .collect();
            json!({
                "origin": "espn",
                "id": id_text(&a["id"]).unwrap_or_else(|| index.to_string()),
                "sportKey": e.espn_sport,
                "competitionKey": competition_key,
                "competitionLabel": e.label,
                "title": a["headline"].as_str().unwrap_or(""),
                "url": at(a, &["links", "web", "href"]).as_str().unwrap_or(""),
                "publishedAt": a["published"].as_str().unwrap_or(""),
                "imageUrl": image.and_then(|i| i["url"].as_str()),
                "summary": a["description"].as_str().unwrap_or(""),
                "teamKeys": [],
                "publisherLabel": "ESPN",
                "publisherDomain": "espn.com",
                "sourceTeamIds": team_ids,
            })
        })
        .collect())
}
