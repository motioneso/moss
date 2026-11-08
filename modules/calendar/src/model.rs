use crate::{Error, Result};
use serde_json::{json, Value};

pub fn invalid(message: &str) -> Error {
    Error::new(400, message)
}
pub fn day_zone(day: &str, zone: &str) -> Result<(String, String)> {
    let day = day.trim();
    let zone = zone.trim();
    if day.len() != 10 || chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err() {
        return Err(invalid("localDay must be a real YYYY-MM-DD date"));
    }
    if zone.len() > 64 || zone.parse::<chrono_tz::Tz>().is_err() {
        return Err(invalid("timeZone must be a valid IANA name"));
    }
    Ok((day.into(), zone.into()))
}
pub fn empty_intent() -> Value {
    json!({"priorityTaskIds":[],"capacity":null,"notes":null,"corrections":[],"commitments":[]})
}
pub fn text(value: &Value) -> Result<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid("Expected non-empty text"))
}
pub fn merge_intent(current: &Value, patch: Option<&Value>) -> Result<Value> {
    let Some(patch) = patch else {
        return Ok(current.clone());
    };
    if patch.is_null() {
        return Ok(empty_intent());
    }
    if !patch.is_object() {
        return Err(invalid("eveningIntent must be an object"));
    }
    let mut out = if current.is_object() {
        current.clone()
    } else {
        empty_intent()
    };
    for field in ["priorityTaskIds", "corrections", "commitments"] {
        if let Some(value) = patch.get(field) {
            let values = value
                .as_array()
                .ok_or_else(|| invalid("Intent lists must be arrays"))?;
            let mut items = vec![];
            for item in values {
                items.push(match field {
                    "priorityTaskIds"=>json!(text(item)?),
                    "corrections"=> {
                        let source=text(&item["source"])?;
                        if !["briefing","planner","actor"].contains(&source.as_str()) { return Err(invalid("Unknown correction source")); }
                        json!({"note":text(&item["note"])?,"source":source,"taskId":nullable_text(&item["taskId"])?})
                    },
                    _=> {
                        let decision=text(&item["decision"])?;
                        if !["commit","defer","drop"].contains(&decision.as_str()) { return Err(invalid("Unknown commitment decision")); }
                        json!({"taskId":text(&item["taskId"])?,"decision":decision})
                    }
                });
            }
            out[field] = json!(items);
        }
    }
    if let Some(v) = patch.get("capacity") {
        if !v.is_null() && !["light", "normal", "full"].contains(&v.as_str().unwrap_or("")) {
            return Err(invalid("capacity must be light, normal or full"));
        }
        out["capacity"] = v.clone();
    }
    if let Some(v) = patch.get("notes") {
        out["notes"] = nullable_text(v)?;
    }
    Ok(out)
}
pub fn nullable_text(v: &Value) -> Result<Value> {
    if v.is_null() {
        Ok(Value::Null)
    } else {
        Ok(json!(text(v)?))
    }
}
pub fn block(value: &Value, position: usize) -> Result<Value> {
    if !value.is_object() || value.get("actualPlacement").is_some() {
        return Err(invalid("blocks must not set actualPlacement"));
    }
    let kind = text(&value["kind"])?;
    if ![
        "focus",
        "meeting",
        "prep",
        "break",
        "personal",
        "unscheduled",
    ]
    .contains(&kind.as_str())
    {
        return Err(invalid("Unknown block kind"));
    }
    if let Some(p) = value.get("position") {
        if p.as_u64().is_none() {
            return Err(invalid("Invalid block position"));
        }
    }
    let pending = &value["pendingChange"];
    let pending = if pending.is_null() {
        Value::Null
    } else {
        let kind = text(&pending["kind"])?;
        match kind.as_str() {
            "remove" => json!({"kind":"remove"}),
            "add" | "move" => {
                let stamp = text(&pending["startsAt"])?;
                let parsed = chrono::DateTime::parse_from_rfc3339(&stamp)
                    .map_err(|_| invalid("pendingChange.startsAt must be an ISO instant"))?;
                if !(stamp.ends_with('Z') && (stamp.len() == 20 || stamp.len() == 24))
                    || parsed.to_rfc3339_opts(
                        if stamp.len() == 20 {
                            chrono::SecondsFormat::Secs
                        } else {
                            chrono::SecondsFormat::Millis
                        },
                        true,
                    ) != stamp
                {
                    return Err(invalid("pendingChange.startsAt must be an ISO instant"));
                }
                let duration = pending["durationMinutes"]
                    .as_u64()
                    .filter(|n| (5..=720).contains(n))
                    .ok_or_else(|| invalid("durationMinutes must be between 5 and 720"))?;
                json!({"kind":kind,"startsAt":stamp,"durationMinutes":duration})
            }
            _ => return Err(invalid("Unknown pending change kind")),
        }
    };
    Ok(
        json!({"id":value["id"],"kind":kind,"task_id":nullable_text(&value["taskId"])?,"title":nullable_text(&value["title"])?,"position":position,"pending_change":pending}),
    )
}
