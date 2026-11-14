//! What an added source may cover: a whole sport, or one followed league or team. The checks
//! match the old scope rules, including the limit of twenty targets and no repeats.
use crate::catalog;
use serde_json::{json, Value};

pub const ASSIGNMENT_LIMIT: usize = 20;
pub const SPORT_KEYS: [&str; 5] = ["football", "hockey", "soccer", "baseball", "basketball"];

pub fn sport_label(key: &str) -> &'static str {
    match key {
        "football" => "Football",
        "hockey" => "Hockey",
        "soccer" => "Soccer",
        "baseball" => "Baseball",
        _ => "Basketball",
    }
}

/// A sport the catalog actually has leagues for.
pub fn is_sport_key(key: &str) -> bool {
    SPORT_KEYS.contains(&key) && catalog::ENTRIES.iter().any(|entry| entry.espn_sport == key)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Sport(String),
    Follow(String),
}

impl Target {
    /// The key two targets are compared on.
    pub fn key(&self) -> String {
        match self {
            Target::Sport(key) => format!("sport:{key}"),
            Target::Follow(id) => format!("follow:{id}"),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Target::Sport(key) => json!({"kind":"sport","sportKey":key}),
            Target::Follow(id) => json!({"kind":"follow","followId":id}),
        }
    }

    pub fn from_json(value: &Value) -> Option<Target> {
        match value["kind"].as_str()? {
            "sport" => Some(Target::Sport(value["sportKey"].as_str()?.to_owned())),
            "follow" => Some(Target::Follow(value["followId"].as_str()?.to_owned())),
            _ => None,
        }
    }
}

pub fn has_valid_targets(targets: &[Target]) -> bool {
    if targets.len() > ASSIGNMENT_LIMIT {
        return false;
    }
    let mut keys: Vec<String> = targets.iter().map(Target::key).collect();
    keys.sort();
    keys.dedup();
    keys.len() == targets.len()
        && targets.iter().all(|target| match target {
            Target::Sport(key) => is_sport_key(key),
            Target::Follow(id) => !id.is_empty(),
        })
}

/// The sport a followed competition belongs to.
pub fn sport_of_competition(competition_key: &str) -> Option<&'static str> {
    catalog::entry(competition_key).map(|entry| entry.espn_sport)
}
