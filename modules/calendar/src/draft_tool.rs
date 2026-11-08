//! Chat edits the saved draft only. Timing and provider effects belong to dialog execution.
use crate::{context, model, plans, Error, Result};
use chrono::DateTime;
use moss_module_sdk::Host;
use serde_json::{json, Value};

fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace()))
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(400, message)
}

fn actor_day(now: DateTime<chrono::FixedOffset>, saved_zone: &str) -> chrono::NaiveDate {
    // resolveEffectiveLocale validates the stored value before trimming it. IANA names
    // contain no surrounding whitespace, and the preference contract caps them at 100.
    let saved_zone = if saved_zone.len() <= 100 {
        saved_zone
    } else {
        ""
    };
    let zone = saved_zone
        .parse::<chrono_tz::Tz>()
        .ok()
        .or_else(|| {
            chrono_tz::TZ_VARIANTS
                .iter()
                .copied()
                .find(|zone| zone.name().eq_ignore_ascii_case(saved_zone))
        })
        .unwrap_or(chrono_tz::America::Los_Angeles);
    now.with_timezone(&zone).date_naive()
}

pub fn save(host: &impl Host, input: &Value) -> Result<Value> {
    let fields = input
        .as_object()
        .ok_or_else(|| invalid("Invalid plan-draft input"))?;
    for key in fields.keys() {
        if [
            "startsAt",
            "endsAt",
            "durationMinutes",
            "pendingChange",
            "actualPlacement",
            "kind",
            "position",
            "blocks",
            "move",
            "remove",
            "times",
            "placement",
        ]
        .contains(&key.as_str())
        {
            return Err(invalid(format!(
                "{key} is not accepted from chat; times and placement stay in the dialog"
            )));
        }
        if !["planId", "expectedRevision", "eveningIntent", "additions"].contains(&key.as_str()) {
            return Err(invalid(format!("{key} is not a plan-draft field")));
        }
    }
    let id = input["planId"]
        .as_str()
        .map(trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("planId is required"))?;
    let revision = input["expectedRevision"]
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n < f64::from(i32::MAX))
        .ok_or_else(|| invalid("expectedRevision must be a positive integer"))?
        as u32;
    let additions = match input.get("additions") {
        None => vec![],
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid("additions must be a list"))?
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let fields = entry
                    .as_object()
                    .ok_or_else(|| invalid(format!("additions[{index}] must be an object")))?;
                if fields.keys().any(|k| k != "taskId" && k != "title") {
                    return Err(invalid(format!(
                        "additions[{index}] must only carry taskId and title"
                    )));
                }
                let task = entry["taskId"]
                    .as_str()
                    .map(trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid(format!("additions[{index}] must reference a task")))?;
                // Reuse the existing draft title conversion, including scalar/array titles.
                let normalized = model::block(&json!({"kind":"focus","title":entry["title"]}), 0)?;
                Ok(json!({"taskId":task,"title":normalized["title"]}))
            })
            .collect::<Result<Vec<_>>>()?,
    };
    if let Some(intent) = input.get("eveningIntent") {
        model::merge_intent(&model::empty_intent(), Some(intent))?;
    }
    let plan = plans::get_by_id(host, id)?;
    let clock = context(host, "read", "call")?;
    let now = DateTime::parse_from_rfc3339(clock["now"].as_str().unwrap_or(""))
        .map_err(|_| Error::new(503, "Calendar clock is unavailable"))?;
    let locale = host.call("kv", "get", "calendar.chat-context", json!({}))?;
    let today = actor_day(now, locale["timezone"].as_str().unwrap_or(""));
    let tomorrow = today
        .succ_opt()
        .ok_or_else(|| invalid("Invalid chat day"))?;
    let day = plan["localDay"].as_str().unwrap_or("");
    if day != today.to_string() && day != tomorrow.to_string() {
        return Err(invalid(format!(
            "day plan for {day} is outside the current chat window"
        )));
    }
    let mut blocks = plan["blocks"]
        .as_array()
        .ok_or_else(|| Error::new(503, "Calendar blocks are unavailable"))?
        .iter()
        .map(|block| {
            json!({
                "id":block["id"],"kind":block["kind"],"taskId":block["taskId"],
                "title":block["title"],"pendingChange":block["pendingChange"]
            })
        })
        .collect::<Vec<_>>();
    for addition in &additions {
        if plan["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["taskId"] == addition["taskId"])
        {
            return Err(invalid(format!(
                "task {} already has a block in this plan",
                addition["taskId"].as_str().unwrap()
            )));
        }
        blocks.push(json!({"kind":"focus","taskId":addition["taskId"],"title":addition["title"],"pendingChange":null}));
    }
    let mut patch = std::collections::BTreeMap::from([("blocks".into(), json!(blocks))]);
    if let Some(intent) = input.get("eveningIntent") {
        patch.insert("eveningIntent".into(), intent.clone());
    }
    let saved = plans::save(
        host,
        plans::Save {
            plan_id: id.into(),
            local_day: day.into(),
            time_zone: plan["timeZone"].as_str().unwrap_or("").into(),
            expected_revision: revision,
            patch,
        },
    )?;
    let saved = &saved["plan"];
    Ok(json!({"data":{
        "planId":saved["id"],"revision":saved["revision"],"addedCount":additions.len(),
        "message":format!("Draft saved for review as revision {}. New tasks are untimed proposals; accept them in the Plan tomorrow dialog and its review to schedule anything.",saved["revision"])
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_day_validates_raw_preferences_and_uses_the_saved_zone() {
        let now = DateTime::parse_from_rfc3339("2026-11-08T01:00:00Z").unwrap();
        assert_eq!(actor_day(now, "Europe/London").to_string(), "2026-11-08");
        assert_eq!(actor_day(now, "europe/london").to_string(), "2026-11-08");
        for invalid in [" Europe/London", "Europe/London ", "", &"a".repeat(101)] {
            assert_eq!(actor_day(now, invalid).to_string(), "2026-11-07");
        }
    }
}
