//! The weather line for a morning briefing, read through the Weather package's public api.
use crate::gather::api;
use crate::gather_types::{Gap, Reason, Section};
use crate::trust::sanitize_external;
use moss_module_sdk::Host;
use serde_json::{json, Value};

fn degrees(value: &Value, unit: &Value) -> String {
    format!("{}\u{b0}{}", value.as_i64().map_or_else(|| value.to_string(), |n| n.to_string()), if unit == "metric" { "C" } else { "F" })
}

/// One line for today's weather. No known place leaves the section empty, and a failed read
/// leaves it empty with a visible gap.
pub fn section<H: Host + ?Sized>(host: &H, gaps: &mut Vec<Gap>) -> Section {
    let empty = Section::empty("weather", "WEATHER");
    let Ok(reply) = api(host, "weather", "weatherToday", json!({})) else {
        gaps.push(Gap { source: "weather", reason: Reason::ToolFailed });
        return empty;
    };
    let w = &reply["data"];
    if !w.is_object() {
        return empty;
    }
    let unit = &w["unit"];
    let place = sanitize_external(&w["location"]);
    let now = format!(
        "{} now, {} (feels like {})",
        sanitize_external(&w["condition"]),
        degrees(&w["temp"], unit),
        degrees(&w["feelsLike"], unit)
    );
    let outlook = w["today"].is_object().then(|| {
        format!(
            "today {}, high {}, low {}",
            sanitize_external(&w["today"]["condition"]),
            degrees(&w["today"]["high"], unit),
            degrees(&w["today"]["low"], unit)
        )
    });
    let mut parts = vec![];
    if !place.is_empty() {
        parts.push(format!("{place}:"));
    }
    parts.push(now);
    if let Some(outlook) = outlook {
        parts.push(format!("; {outlook}"));
    }
    let line = parts.join(" ").replace(" ;", ";");
    Section { key: "weather", label: "WEATHER", lines: vec![line], count: 1, raw: vec![] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::{Error, Result};

    struct Reply(Result<Value>);
    impl Host for Reply {
        fn call(&self, port: &str, op: &str, resource: &str, _: Value) -> Result<Value> {
            assert_eq!((port, op, resource), ("api", "call", "weather"));
            self.0.as_ref().map(Clone::clone).map_err(|_| Error::new("down"))
        }
    }

    #[test]
    fn a_reading_becomes_one_line() {
        let data = json!({"data": {"location": "Seattle, Washington, United States", "unit": "imperial", "condition": "Overcast", "temp": 50, "feelsLike": 47,
            "today": {"condition": "Rain", "high": 55, "low": 44}}});
        let mut gaps = vec![];
        let s = section(&Reply(Ok(data)), &mut gaps);
        assert_eq!(s.lines, ["Seattle, Washington, United States: Overcast now, 50\u{b0}F (feels like 47\u{b0}F); today Rain, high 55\u{b0}F, low 44\u{b0}F"]);
        assert!(gaps.is_empty());
    }

    #[test]
    fn no_place_is_an_empty_section_and_a_failure_is_a_gap() {
        let mut gaps = vec![];
        assert!(section(&Reply(Ok(json!({"data": null}))), &mut gaps).lines.is_empty());
        assert!(gaps.is_empty());
        assert!(section(&Reply(Err(Error::new("x"))), &mut gaps).lines.is_empty());
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].reason, Reason::ToolFailed);
    }

    #[test]
    fn outside_text_is_cleaned() {
        let data = json!({"data": {"location": "<b>Evil</b>", "unit": "metric", "condition": "Clear", "temp": 1, "feelsLike": 0}});
        let s = section(&Reply(Ok(data)), &mut vec![]);
        assert!(!s.lines[0].contains("<b>") && s.lines[0].contains("1\u{b0}C"));
    }
}
