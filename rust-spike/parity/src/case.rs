//! A parity case: seed rows, a list of steps, and the tables to compare afterwards. Cases are
//! plain JSON so they do not depend on either server's language.
//!
//! A step is one of
//! - an HTTP request: `method`, `path`, optional `as` (A, B, admin, anon), `headers`, and a
//!   JSON `body` or a `raw` text body;
//! - `wait_job`: the id of a queued job, read once the worker has finished it;
//! - `sql`: a statement run as a runtime `role` (app, worker or auth) for actor `as`, rolled back.
//!
//! An HTTP step may also `save_cookie` the cookies its response sets under a name, and send
//! saved ones with `cookie`. `compare` narrows the comparison to some JSON pointers, for replies
//! that differ by design, such as a fresh session token. `absent` lists text that must not appear
//! anywhere in the step's output on either server.
//!
//! Strings may hold `{{name}}` placeholders: the seed ids (`userA`, `sessionB`, ...), times
//! relative to the case start (`now`, `now+2d`, `now-3h`), or `step:/json/pointer` for a value
//! from an earlier step's output on the same server.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::canon::is_uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub name: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub seed: Vec<String>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub rows: Vec<String>,
    /// Where the case differs from the test it came from.
    #[serde(default)]
    pub note: Option<String>,
    /// Set by the loader: every id written into the case, which canonical labels leave alone.
    #[serde(skip)]
    pub known_ids: HashSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default, rename = "as")]
    pub actor: Option<String>,
    #[serde(default)]
    pub headers: Map<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default)]
    pub wait_job: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// A subset the step's output must contain, on both servers.
    #[serde(default)]
    pub expect: Option<Value>,
    /// Saves the cookies the response sets under this name, separately on each server.
    #[serde(default)]
    pub save_cookie: Option<String>,
    /// Sends the cookies saved under this name.
    #[serde(default)]
    pub cookie: Option<String>,
    /// JSON pointers into the output. When set, only these parts are compared between servers.
    #[serde(default)]
    pub compare: Option<Vec<String>>,
    /// Text that must not appear in the step's output on either server, ignoring case.
    #[serde(default)]
    pub absent: Vec<String>,
    /// Prints both servers' output and keeps it in the report, for a step that is observed
    /// rather than asserted.
    #[serde(default)]
    pub record: bool,
}

pub const SEED_IDS: &[(&str, &str)] = &[
    ("userA", "00000000-0000-4000-8000-000000000001"),
    ("userB", "00000000-0000-4000-8000-000000000002"),
    ("admin", "00000000-0000-4000-8000-000000000003"),
    ("userC", "00000000-0000-4000-8000-000000000091"),
    ("userD", "00000000-0000-4000-8000-000000000092"),
    ("sessionA", "40000000-0000-4000-8000-000000000001"),
    ("sessionB", "40000000-0000-4000-8000-000000000002"),
    ("sessionAdmin", "40000000-0000-4000-8000-000000000003"),
];

/// The user id behind an `as` name.
pub fn actor_user(actor: &str) -> Option<&'static str> {
    match actor {
        "A" => Some(SEED_IDS[0].1),
        "B" => Some(SEED_IDS[1].1),
        "admin" => Some(SEED_IDS[2].1),
        "C" => Some(SEED_IDS[3].1),
        "D" => Some(SEED_IDS[4].1),
        _ => None,
    }
}

/// The bearer token behind an `as` name. Users C and D have no seeded session.
pub fn actor_token(actor: &str) -> Option<&'static str> {
    match actor {
        "A" => Some(SEED_IDS[5].1),
        "B" => Some(SEED_IDS[6].1),
        "admin" => Some(SEED_IDS[7].1),
        _ => None,
    }
}

pub fn load_dir(dir: &Path, only: Option<&str>) -> Result<Vec<Case>, String> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(|error| format!("read {}: {error}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    let mut cases = Vec::new();
    for path in paths {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        let file: Vec<Case> = serde_json::from_str(&text)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        let known = uuids_in(&text);
        for mut case in file {
            check(&case).map_err(|error| format!("{}: {error}", path.display()))?;
            if only.is_some_and(|filter| !case.name.contains(filter)) {
                continue;
            }
            case.known_ids = known.clone();
            cases.push(case);
        }
    }
    Ok(cases)
}

/// A case with no steps and no tables would pass without comparing anything.
pub fn check(case: &Case) -> Result<(), String> {
    if case.steps.is_empty() && case.rows.is_empty() {
        return Err(format!("case {} compares nothing", case.name));
    }
    Ok(())
}

fn uuids_in(text: &str) -> HashSet<String> {
    let mut found: HashSet<String> =
        SEED_IDS.iter().map(|(_, id)| (*id).to_owned()).collect();
    for token in text.split(|ch: char| !(ch.is_ascii_hexdigit() || ch == '-')) {
        if is_uuid(token) {
            found.insert(token.to_ascii_lowercase());
        }
    }
    found
}

/// Placeholder values shared by both servers for one case.
pub struct Vars {
    pub start: DateTime<Utc>,
}

impl Vars {
    /// Fills placeholders in `text`. A string that is exactly one placeholder for a step value
    /// takes that value's JSON type.
    pub fn fill(&self, text: &str, outputs: &HashMap<String, Value>) -> Result<Value, String> {
        let trimmed = text.trim();
        if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.matches("{{").count() == 1
        {
            return self.lookup(&trimmed[2..trimmed.len() - 2], outputs);
        }
        let mut out = String::new();
        let mut rest = text;
        while let Some(open) = rest.find("{{") {
            out.push_str(&rest[..open]);
            let close = rest[open..].find("}}").ok_or_else(|| format!("unclosed placeholder in {text}"))?;
            let value = self.lookup(&rest[open + 2..open + close], outputs)?;
            match value {
                Value::String(text) => out.push_str(&text),
                other => out.push_str(&other.to_string()),
            }
            rest = &rest[open + close + 2..];
        }
        out.push_str(rest);
        Ok(Value::String(out))
    }

    pub fn fill_string(&self, text: &str, outputs: &HashMap<String, Value>) -> Result<String, String> {
        match self.fill(text, outputs)? {
            Value::String(text) => Ok(text),
            other => Ok(other.to_string()),
        }
    }

    /// Fills placeholders in every string inside `value`.
    pub fn fill_json(&self, value: &Value, outputs: &HashMap<String, Value>) -> Result<Value, String> {
        Ok(match value {
            Value::String(text) => self.fill(text, outputs)?,
            Value::Array(items) => Value::Array(
                items.iter().map(|item| self.fill_json(item, outputs)).collect::<Result<_, _>>()?,
            ),
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, item) in map {
                    out.insert(key.clone(), self.fill_json(item, outputs)?);
                }
                Value::Object(out)
            }
            other => other.clone(),
        })
    }

    fn lookup(&self, name: &str, outputs: &HashMap<String, Value>) -> Result<Value, String> {
        let name = name.trim();
        if let Some((_, id)) = SEED_IDS.iter().find(|(key, _)| *key == name) {
            return Ok(Value::String((*id).to_owned()));
        }
        if let Some(offset) = name.strip_prefix("now") {
            let time = self.start + parse_offset(offset)?;
            return Ok(Value::String(time.to_rfc3339_opts(SecondsFormat::Millis, true)));
        }
        if let Some((step, pointer)) = name.split_once(':') {
            let output = outputs.get(step).ok_or_else(|| format!("no output from step {step}"))?;
            return output
                .pointer(pointer)
                .cloned()
                .ok_or_else(|| format!("step {step} output has nothing at {pointer}"));
        }
        Err(format!("unknown placeholder {{{{{name}}}}}"))
    }
}

/// `""`, `+2d`, `-3h`, `+30m`, `+10s`.
fn parse_offset(text: &str) -> Result<Duration, String> {
    if text.is_empty() {
        return Ok(Duration::zero());
    }
    let (sign, rest) = match text.as_bytes()[0] {
        b'+' => (1, &text[1..]),
        b'-' => (-1, &text[1..]),
        _ => return Err(format!("bad time offset {text}")),
    };
    let (number, unit) = rest.split_at(rest.len().saturating_sub(1));
    let amount: i64 = number.parse().map_err(|_| format!("bad time offset {text}"))?;
    let duration = match unit {
        "d" => Duration::days(amount),
        "h" => Duration::hours(amount),
        "m" => Duration::minutes(amount),
        "s" => Duration::seconds(amount),
        _ => return Err(format!("bad time unit in {text}")),
    };
    Ok(duration * sign)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fills_placeholders() {
        let vars = Vars { start: "2026-11-07T12:00:00Z".parse().unwrap() };
        let outputs: HashMap<String, Value> =
            [("make".to_owned(), json!({"body": {"task": {"id": "t1", "priority": 3}}}))].into();
        assert_eq!(
            vars.fill("/api/tasks/{{make:/body/task/id}}", &outputs).unwrap(),
            json!("/api/tasks/t1")
        );
        assert_eq!(vars.fill("{{make:/body/task/priority}}", &outputs).unwrap(), json!(3));
        assert_eq!(vars.fill("{{now+2d}}", &outputs).unwrap(), json!("2026-11-09T12:00:00.000Z"));
        assert_eq!(
            vars.fill("owner {{userA}}", &outputs).unwrap(),
            json!("owner 00000000-0000-4000-8000-000000000001")
        );
        assert!(vars.fill("{{nope}}", &outputs).is_err());
    }

    #[test]
    fn a_case_must_compare_something() {
        let empty: Case = serde_json::from_value(json!({"name": "empty", "steps": []})).unwrap();
        assert!(check(&empty).is_err());

        let rows_only: Case =
            serde_json::from_value(json!({"name": "rows", "steps": [], "rows": ["app.tasks"]}))
                .unwrap();
        assert!(check(&rows_only).is_ok());

        let one_step: Case = serde_json::from_value(
            json!({"name": "step", "steps": [{"method": "GET", "path": "/api/tasks"}]}),
        )
        .unwrap();
        assert!(check(&one_step).is_ok());
    }

    #[test]
    fn every_case_file_loads_and_each_protection_filter_finds_its_case() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("cases");
        assert!(!load_dir(&dir, None).unwrap().is_empty());

        // The filters tools/remove-protections.sh passes to --only.
        for filter in [
            "safety: member isolation",
            "safety: admin",
            "safety: account lifecycle",
            "safety: account guardrails hold",
            "safety: the bootstrap owner",
            "safety: connectors",
            "safety: password",
        ] {
            assert_eq!(load_dir(&dir, Some(filter)).unwrap().len(), 1, "{filter}");
        }
    }
}
