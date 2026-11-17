//! The top stories for a briefing, read through the News package's public api. News reads its
//! stored page and never fetches while a briefing is built.
use crate::gather::api;
use crate::gather_types::{Gap, Reason, Section};
use crate::trust::sanitize_external;
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const TOOL: &str = "news.topHeadlinesToday";

/// One line per story. No stored page leaves the section empty with a visible gap, and so
/// does a failed read.
pub fn section<H: Host + ?Sized>(host: &H, gaps: &mut Vec<Gap>) -> Section {
    let empty = Section::empty("news", "NEWS");
    let Ok(reply) = api(host, "news", "newsTopHeadlinesToday", json!({})) else {
        gaps.push(Gap { source: "news", reason: Reason::ToolFailed });
        return empty;
    };
    let lines: Vec<String> = reply["facts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(sanitize_external)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        gaps.push(Gap { source: "news", reason: Reason::Empty });
        return empty;
    }
    Section { key: "news", label: "NEWS", count: lines.len(), lines, raw: Vec::<Value>::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::{Error, Result};

    struct Reply(Result<Value>);
    impl Host for Reply {
        fn call(&self, port: &str, op: &str, resource: &str, _: Value) -> Result<Value> {
            assert_eq!((port, op, resource), ("api", "call", "news"));
            self.0.as_ref().map(Clone::clone).map_err(|_| Error::new("down"))
        }
    }

    #[test]
    fn stories_become_lines() {
        let mut gaps = vec![];
        let s = section(&Reply(Ok(json!({"facts": ["Rates rise \u{2014} Wire", "Storm hits \u{2014} Daily"]}))), &mut gaps);
        assert_eq!(s.lines.len(), 2);
        assert_eq!(s.count, 2);
        assert!(gaps.is_empty());
    }

    #[test]
    fn nothing_stored_or_a_failure_is_a_gap() {
        let mut gaps = vec![];
        assert!(section(&Reply(Ok(json!({"facts": []}))), &mut gaps).lines.is_empty());
        assert_eq!(gaps[0].reason, Reason::Empty);
        assert!(section(&Reply(Err(Error::new("x"))), &mut gaps).lines.is_empty());
        assert_eq!(gaps[1].reason, Reason::ToolFailed);
    }

    #[test]
    fn outside_text_is_cleaned() {
        let s = section(&Reply(Ok(json!({"facts": ["<b>Evil</b> story \u{2014} Src"]}))), &mut vec![]);
        assert!(!s.lines[0].contains("<b>"));
    }
}
