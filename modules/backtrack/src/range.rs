//! The time range a delete names. Both bounds or neither, the start before the end, and at most
//! 31 days between them.
use crate::clock::parse;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum Range {
    Everything,
    Between(DateTime<Utc>, DateTime<Utc>),
    Invalid(&'static str),
}

pub fn parse_range(body: &Value) -> Range {
    let map = match body {
        Value::Null => return Range::Everything,
        Value::Object(map) => map,
        _ => return Range::Invalid(crate::codes::RANGE_MESSAGES[0]),
    };
    if map.keys().any(|key| key != "from" && key != "to") {
        return Range::Invalid(crate::codes::RANGE_MESSAGES[0]);
    }
    match (map.get("from"), map.get("to")) {
        (None, None) => Range::Everything,
        (Some(_), None) | (None, Some(_)) => Range::Invalid(crate::codes::RANGE_MESSAGES[1]),
        (Some(from), Some(to)) => {
            let bound = |v: &Value| v.as_str().and_then(parse);
            let (Some(from), Some(to)) = (bound(from), bound(to)) else {
                return Range::Invalid(crate::codes::RANGE_MESSAGES[2]);
            };
            if from >= to {
                Range::Invalid(crate::codes::RANGE_MESSAGES[3])
            } else if to - from > Duration::days(31) {
                Range::Invalid(crate::codes::RANGE_MESSAGES[4])
            } else {
                Range::Between(from, to)
            }
        }
    }
}
