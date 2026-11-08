//! Normalisation and comparison of what the two servers produced.
//!
//! Each server makes its own ids and timestamps, so raw output never matches. Ids a case did not
//! seed get labels in order of first appearance, and timestamps near the case start become
//! `<now>`. Everything else compares exactly.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value};

/// How far from the case start a timestamp counts as "made during the case".
const NOW_WINDOW_MINUTES: i64 = 10;

pub struct Canon {
    labels: HashMap<String, String>,
    known: HashSet<String>,
    start: DateTime<Utc>,
}

impl Canon {
    pub fn new(start: DateTime<Utc>, known: &HashSet<String>) -> Self {
        Canon { labels: HashMap::new(), known: known.clone(), start }
    }

    pub fn value(&mut self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.string(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.value(item)).collect()),
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, item) in map {
                    out.insert(key.clone(), self.value(item));
                }
                Value::Object(out)
            }
            Value::Number(_) => json_numbers(value),
            other => other.clone(),
        }
    }

    /// Rows compare as a set. Labels are handed out in an order that does not depend on the
    /// order Postgres returned the rows in.
    pub fn rows(&mut self, rows: &[Value]) -> Vec<Value> {
        let mut ordered: Vec<&Value> = rows.iter().collect();
        ordered.sort_by_cached_key(|row| shape(row).to_string());
        let mut out: Vec<Value> = ordered.into_iter().map(|row| self.value(row)).collect();
        out.sort_by_cached_key(|row| row.to_string());
        out
    }

    fn string(&mut self, text: &str) -> String {
        if is_uuid(text) {
            let key = text.to_ascii_lowercase();
            if self.known.contains(&key) {
                return key;
            }
            let next = format!("<id:{}>", self.labels.len() + 1);
            return self.labels.entry(key).or_insert(next).clone();
        }
        if let Some(time) = parse_time(text) {
            let near = (time - self.start).abs() < Duration::minutes(NOW_WINDOW_MINUTES);
            if near && !self.known.contains(text) {
                return "<now>".to_owned();
            }
        }
        text.to_owned()
    }
}

/// JavaScript writes integral numbers as `1`; PostgreSQL JSONB may spell them
/// `1.0`. Normalize only exactly representable integral floats. All other values,
/// including large integer tokens, IDs and timestamps, remain unchanged.
pub fn json_numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) if n.is_f64() => {
            let number = n.as_f64().unwrap();
            if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                Value::from(number as i64)
            } else {
                value.clone()
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(json_numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, value)|
            (key.clone(), json_numbers(value))).collect()),
        _ => value.clone(),
    }
}

/// A row with ids and timestamps blanked, used only to order rows before labelling.
fn shape(value: &Value) -> Value {
    match value {
        Value::String(text) if is_uuid(text) => Value::String("U".into()),
        Value::String(text) if parse_time(text).is_some() => Value::String("T".into()),
        Value::Array(items) => Value::Array(items.iter().map(shape).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(key, item)| (key.clone(), shape(item))).collect())
        }
        other => other.clone(),
    }
}

pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    if text.len() < 20 || text.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    DateTime::parse_from_rfc3339(text).ok().map(|time| time.with_timezone(&Utc))
}

/// Paths where the two values differ, at most `limit` of them.
pub fn diff(ts: &Value, rs: &Value, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    walk("", ts, rs, &mut out, limit);
    out
}

fn walk(path: &str, ts: &Value, rs: &Value, out: &mut Vec<String>, limit: usize) {
    if out.len() >= limit || ts == rs {
        return;
    }
    match (ts, rs) {
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in left {
                let here = format!("{path}/{key}");
                match right.get(key) {
                    Some(other) => walk(&here, value, other, out, limit),
                    None => out.push(format!("{here}: only TypeScript has it ({})", short(value))),
                }
            }
            for (key, value) in right {
                if !left.contains_key(key) && out.len() < limit {
                    out.push(format!("{path}/{key}: only Rust has it ({})", short(value)));
                }
            }
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (a, b)) in left.iter().zip(right).enumerate() {
                walk(&format!("{path}/{index}"), a, b, out, limit);
            }
        }
        (Value::Array(left), Value::Array(right)) => out.push(format!(
            "{path}: TypeScript has {} items, Rust has {}",
            left.len(),
            right.len()
        )),
        _ => out.push(format!("{path}: TypeScript {} vs Rust {}", short(ts), short(rs))),
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 160 {
        format!("{}...", &text[..text.floor_char_boundary(157)])
    } else {
        text
    }
}

/// Whether `actual` contains everything `expected` names. Objects may carry extra keys; arrays
/// and scalars must match exactly.
pub fn contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(have), Value::Object(want)) => want
            .iter()
            .all(|(key, value)| have.get(key).is_some_and(|found| contains(found, value))),
        (Value::Array(have), Value::Array(want)) => {
            have.len() == want.len() && have.iter().zip(want).all(|(a, b)| contains(a, b))
        }
        _ => actual == expected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integral_json_floats_match_javascript_without_rounding_large_integers() {
        let mut canon = Canon::new(Utc::now(), &HashSet::new());
        assert_eq!(canon.value(&json!([1.0, -0.0, 0.75])), json!([1, 0, 0.75]));
        assert_ne!(canon.value(&json!(9007199254740992_u64)),
            canon.value(&json!(9007199254740993_u64)));
    }

    #[test]
    fn labels_new_ids_and_keeps_known_ones() {
        let start = Utc::now();
        let known: HashSet<String> = ["00000000-0000-4000-8000-000000000001".to_owned()].into();
        let mut canon = Canon::new(start, &known);
        let made = "8b7c8f0e-1a2b-4c3d-9e8f-0123456789ab";
        let value = json!({
            "a": made,
            "b": "00000000-0000-4000-8000-000000000001",
            "c": [made, start.to_rfc3339()],
            "d": "2001-01-01T00:00:00.000Z",
        });
        assert_eq!(
            canon.value(&value),
            json!({
                "a": "<id:1>",
                "b": "00000000-0000-4000-8000-000000000001",
                "c": ["<id:1>", "<now>"],
                "d": "2001-01-01T00:00:00.000Z",
            })
        );
    }

    #[test]
    fn reports_where_values_differ() {
        let found = diff(&json!({"a": 1, "b": [1, 2]}), &json!({"a": 2, "b": [1], "c": 0}), 10);
        assert_eq!(found.len(), 3);
        assert!(contains(&json!({"a": 1, "b": {"c": 2, "d": 3}}), &json!({"b": {"c": 2}})));
        assert!(!contains(&json!({"a": [1, 2]}), &json!({"a": [1]})));
    }
}
