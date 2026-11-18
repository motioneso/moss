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
                        let source=item["source"].as_str().ok_or_else(|| invalid("Unknown correction source"))?;
                        if !["briefing","planner","actor"].contains(&source) { return Err(invalid("Unknown correction source")); }
                        json!({"note":text(&item["note"])?,"source":source,"taskId":nullable_text(&item["taskId"])?})
                    },
                    _=> {
                        let decision=item["decision"].as_str().ok_or_else(|| invalid("Unknown commitment decision"))?;
                        if !["commit","defer","drop"].contains(&decision) { return Err(invalid("Unknown commitment decision")); }
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
// JavaScript prints ordinary numbers in decimal and switches to an exponent outside
// [1e-6, 1e21). Rust Display keeps decimal form, so retain the old title conversion.
fn number_title(number: &serde_json::Number) -> String {
    let value = number.as_f64().unwrap();
    if value == 0.0 {
        return "0".into();
    }
    let plain = value.to_string();
    if (1e-6..1e21).contains(&value.abs()) {
        return plain;
    }
    let unsigned = plain.trim_start_matches('-');
    let dot = unsigned.find('.').unwrap_or(unsigned.len());
    let first = unsigned
        .bytes()
        .position(|b| b.is_ascii_digit() && b != b'0')
        .unwrap();
    let exponent = dot as isize - first as isize - isize::from(first < dot);
    let digits: String = unsigned.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_start_matches('0').trim_end_matches('0');
    let mut mantissa = digits[..1].to_owned();
    if digits.len() > 1 {
        mantissa.push('.');
        mantissa.push_str(&digits[1..]);
    }
    format!(
        "{}{mantissa}e{exponent:+}",
        if value < 0.0 { "-" } else { "" }
    )
}
// The existing draft model uses String(title), including for JSON scalar/array inputs.
fn title_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => number_title(value),
        Value::Array(values) => values
            .iter()
            .map(title_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub fn block(value: &Value, position: usize) -> Result<Value> {
    if !value.is_object() || value.get("actualPlacement").is_some() {
        return Err(invalid("blocks must not set actualPlacement"));
    }
    let kind = value["kind"]
        .as_str()
        .ok_or_else(|| invalid("Unknown block kind"))?;
    if ![
        "focus",
        "meeting",
        "prep",
        "break",
        "personal",
        "unscheduled",
    ]
    .contains(&kind)
    {
        return Err(invalid("Unknown block kind"));
    }
    if let Some(p) = value.get("position") {
        if p.as_u64().is_none() {
            return Err(invalid("Invalid block position"));
        }
    }
    let title = title_string(&value["title"]);
    let title =
        title.trim_matches(|c: char| c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace()));
    let title = (!title.is_empty()).then_some(title);
    let pending = &value["pendingChange"];
    let pending = if pending.is_null() {
        Value::Null
    } else {
        let kind = pending["kind"]
            .as_str()
            .ok_or_else(|| invalid("Unknown pending change kind"))?;
        match kind {
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
        json!({"id":value["id"],"kind":kind,"task_id":nullable_text(&value["taskId"])?,"title":title,"position":position,"pending_change":pending}),
    )
}

/// The existing persona name projection, without persona text. Mirrors sanitizePersonaName.
pub fn assistant_name(value: &serde_json::Value) -> String {
    let Some(raw) = value.as_str() else {
        return "Moss".into();
    };
    // JavaScript \s differs from Unicode White_Space at U+0085 and U+FEFF.
    let space = |c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}';
    let cleaned: String = raw
        .chars()
        .filter_map(|c| {
            if c.is_control() {
                Some(' ')
            } else if "<>#`*_~[]{}|".contains(c) {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    let collapsed = cleaned
        .split(space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    // Persisted names are already limited by the original persona writer. Bound legacy rows too.
    let units: Vec<_> = collapsed.encode_utf16().take(80).collect();
    let bounded = String::from_utf16_lossy(&units);
    let name = bounded.trim_end_matches(space);
    if name.is_empty() {
        "there".into()
    } else {
        name.into()
    }
}
