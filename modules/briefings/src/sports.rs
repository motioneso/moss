//! Today's facts for the person's followed teams, read through the Sports package's public api.
//! Sports reads the person's own follows and the stored scoreboards.
use crate::gather::api;
use crate::gather_types::{Gap, Reason, Section};
use crate::trust::sanitize_external;
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const TOOL: &str = "sports.followedFactsToday";

/// One line per fact. A failed read or an empty answer leaves the section empty with a visible gap.
pub fn section<H: Host + ?Sized>(host: &H, zone: &str, gaps: &mut Vec<Gap>) -> Section {
    let empty = Section::empty("sports", "SPORTS");
    let Ok(reply) = api(host, "sports", "sportsFollowedFactsToday", json!({"timeZone": zone})) else {
        gaps.push(Gap { source: "sports", reason: Reason::ToolFailed });
        return empty;
    };
    let lines: Vec<String> = reply["facts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|fact| sanitize_external(&fact["text"]))
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        gaps.push(Gap { source: "sports", reason: Reason::Empty });
        return empty;
    }
    Section { key: "sports", label: "SPORTS", count: lines.len(), lines, raw: Vec::<Value>::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::{Error, Result};

    struct Reply(Result<Value>);
    impl Host for Reply {
        fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
            assert_eq!((port, op, resource), ("api", "call", "sports"));
            assert_eq!(params["name"], "sportsFollowedFactsToday");
            assert_eq!(params["parameters"]["timeZone"], "America/Chicago");
            self.0.as_ref().map(Clone::clone).map_err(|_| Error::new("down"))
        }
    }

    #[test]
    fn facts_become_lines() {
        let mut gaps = vec![];
        let facts = json!({"facts": [{"competitionKey":"nhl","text":"Bruins play today at 7:00 PM."},{"competitionKey":"eng.1","text":"2 Premier League games play today."}]});
        let s = section(&Reply(Ok(facts)), "America/Chicago", &mut gaps);
        assert_eq!((s.key, s.lines.len(), s.count), ("sports", 2, 2));
        assert!(gaps.is_empty());
    }

    #[test]
    fn nothing_or_a_failure_is_a_gap() {
        let mut gaps = vec![];
        assert!(section(&Reply(Ok(json!({"facts": []}))), "America/Chicago", &mut gaps).lines.is_empty());
        assert_eq!(gaps[0].reason, Reason::Empty);
        assert!(section(&Reply(Err(Error::new("x"))), "America/Chicago", &mut gaps).lines.is_empty());
        assert_eq!(gaps[1].reason, Reason::ToolFailed);
    }

    #[test]
    fn outside_text_is_cleaned() {
        let s = section(&Reply(Ok(json!({"facts": [{"text":"<b>Evil</b> fact"}]}))), "America/Chicago", &mut vec![]);
        assert!(!s.lines[0].contains("<b>"));
    }
}
