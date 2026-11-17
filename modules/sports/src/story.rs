//! Headline composition for the overview: merging the league and club news lists, ranking the
//! top stories, picking the one featured story, and shaping stories for cards and the response.
//!
//! A headline is the JSON object `espn::parse_headlines` builds. Nothing here reads the network
//! or a person's data. A story the person asked to see less of is not filtered here.
use crate::catalog;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const TOP_STORIES_CAP: usize = 6;
const TEAM_STORY_LIMIT: usize = 3;
/// A story needs a followed club plus art (4 or more) to take the featured slot.
pub const BIG_STORY_WEIGHT: i32 = 4;

fn text<'a>(headline: &'a Value, key: &str) -> &'a str {
    headline[key].as_str().unwrap_or("")
}

fn team_keys(headline: &Value) -> Vec<&str> {
    headline["teamKeys"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

/// The link with its fragment removed and an http or https scheme, or nothing.
pub fn canonical_url(value: &str) -> Option<String> {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    let scheme_end = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return None;
    };
    let rest = &value[scheme_end..];
    let rest = rest.split('#').next().unwrap_or(rest);
    let host_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(host_end);
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let tail = if tail.is_empty() { "/" } else { tail };
    Some(format!("{}://{}{tail}", &lower[..scheme_end - 3], host.to_ascii_lowercase()))
}

/// Tags every ESPN headline with the key today's team list gives each club it names.
pub fn resolve_team_keys(headlines: Vec<Value>, teams: &[crate::espn::TeamRef]) -> Vec<Value> {
    headlines
        .into_iter()
        .map(|mut headline| {
            if text(&headline, "origin") == "custom" {
                return headline;
            }
            let keys: Vec<Value> = headline["sourceTeamIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| teams.iter().find(|t| t.source_team_id.as_deref() == Some(id)))
                .map(|t| json!(t.team_key))
                .collect();
            headline["teamKeys"] = Value::Array(keys);
            headline
        })
        .collect()
}

/// Adds `incoming`, or widens the club tags of the story that already has its link.
pub fn merge_scope(mut headlines: Vec<Value>, incoming: Value) -> Vec<Value> {
    let link = canonical_url(text(&incoming, "url"));
    let found = link.as_ref().and_then(|l| headlines.iter().position(|h| canonical_url(text(h, "url")).as_ref() == Some(l)));
    let Some(index) = found else {
        headlines.push(incoming);
        return headlines;
    };
    let mut keys: Vec<Value> = headlines[index]["teamKeys"].as_array().cloned().unwrap_or_default();
    let before = keys.len();
    for key in incoming["teamKeys"].as_array().into_iter().flatten() {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    if keys.len() != before {
        headlines[index]["teamKeys"] = Value::Array(keys);
    }
    headlines
}

/// One competition's stories, as the league news band lists them.
pub struct Group {
    pub competition_key: String,
    pub sport_key: &'static str,
    pub label: String,
    pub headlines: Vec<Value>,
}

/// A group per followed competition in order, with each link shown once across all groups.
pub fn compose_groups(keys: &[String], by_competition: &dyn Fn(&str) -> Vec<Value>) -> Vec<Group> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut groups = vec![];
    for key in keys {
        let Some(entry) = catalog::entry(key) else { continue };
        let headlines: Vec<Value> = by_competition(key)
            .into_iter()
            .filter(|h| canonical_url(text(h, "url")).is_some_and(|url| seen.insert(url)))
            .collect();
        if !headlines.is_empty() {
            groups.push(Group { competition_key: key.clone(), sport_key: entry.espn_sport, label: entry.label.to_owned(), headlines });
        }
    }
    groups
}

/// Each competition's lead story first, then followed-club stories in feed order, six at most.
pub fn rank_top_stories(groups: &[Group], followed: &HashSet<String>) -> Vec<Value> {
    let mut picked: Vec<Value> = vec![];
    let mut urls: HashSet<String> = HashSet::new();
    for group in groups {
        if let Some(lead) = group.headlines.first() {
            if urls.insert(text(lead, "url").to_owned()) {
                picked.push(lead.clone());
            }
        }
    }
    let mut rest: Vec<(i64, &Value)> = groups.iter().flat_map(|g| g.headlines.iter().enumerate().map(|(i, h)| (i as i64, h))).collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| text(b.1, "publishedAt").cmp(text(a.1, "publishedAt"))));
    for (_, headline) in rest {
        let competition = text(headline, "competitionKey");
        let about_followed = !competition.is_empty() && team_keys(headline).iter().any(|k| followed.contains(&format!("{competition}:{k}")));
        if about_followed && urls.insert(text(headline, "url").to_owned()) {
            picked.push(headline.clone());
        }
    }
    picked.truncate(TOP_STORIES_CAP);
    picked
}

/// A story's weight: art 2, a summary 1, a followed club 2.
fn weight(headline: &Value, followed: &HashSet<String>) -> i32 {
    let competition = text(headline, "competitionKey");
    let mut total = 0;
    if headline["imageUrl"].as_str().is_some_and(|u| !u.is_empty()) {
        total += 2;
    }
    if !text(headline, "summary").is_empty() {
        total += 1;
    }
    if !competition.is_empty() && team_keys(headline).iter().any(|k| followed.contains(&format!("{competition}:{k}"))) {
        total += 2;
    }
    total
}

/// The single featured story, or nothing on a quiet day. Each league's first story gets 2 extra,
/// the heaviest wins, and the first found wins a tie.
pub fn select_feature<'a>(groups: &'a [Group], followed: &HashSet<String>) -> Option<&'a Value> {
    let mut best: Option<(i32, &Value)> = None;
    for group in groups {
        for (rank, headline) in group.headlines.iter().enumerate() {
            let w = weight(headline, followed) + if rank == 0 { 2 } else { 0 };
            if best.is_none_or(|(b, _)| w > b) {
                best = Some((w, headline));
            }
        }
    }
    best.filter(|(w, _)| *w >= BIG_STORY_WEIGHT).map(|(_, h)| h)
}

/// The story as the response carries it. The provider's club numbers stay behind.
pub fn public(headline: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "sportKey", "competitionKey", "competitionLabel", "title"] {
        out.insert(key.into(), headline[key].clone());
    }
    out.insert("url".into(), json!(canonical_url(text(headline, "url")).unwrap_or_default()));
    for key in ["publishedAt", "imageUrl"] {
        out.insert(key.into(), headline[key].clone());
    }
    out.insert("imageWidth".into(), Value::Null);
    out.insert("imageHeight".into(), Value::Null);
    for key in ["summary", "teamKeys", "publisherLabel", "publisherDomain"] {
        out.insert(key.into(), headline[key].clone());
    }
    Value::Object(out)
}

pub fn about_team<'a>(headlines: &'a [Value], team_key: &str) -> impl Iterator<Item = &'a Value> + 'a {
    let team_key = team_key.to_owned();
    headlines.iter().filter(move |h| team_keys(h).contains(&team_key.as_str()))
}

fn safe_href(url: &str) -> &str {
    if canonical_url(url).is_some() { url } else { "" }
}

/// Up to three stories about one club or league, newest first, each link once.
pub fn team_stories(headlines: &[&Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = headlines.to_vec();
    sorted.sort_by(|a, b| text(b, "publishedAt").cmp(text(a, "publishedAt")));
    let mut seen: HashSet<&str> = HashSet::new();
    sorted
        .into_iter()
        .filter(|h| seen.insert(text(h, "url")))
        .take(TEAM_STORY_LIMIT)
        .map(|h| {
            json!({
                "title": h["title"], "url": safe_href(text(h, "url")), "publishedAt": h["publishedAt"],
                "imageUrl": h["imageUrl"], "publisherLabel": h["publisherLabel"], "publisherDomain": h["publisherDomain"],
            })
        })
        .collect()
}
