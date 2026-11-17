//! Request body checks that give the answers the old route schemas gave. The old server turned
//! numbers and booleans into text, wrapped single values into lists, dropped unknown fields and
//! reported the first failure.
use crate::taxonomy;
use serde_json::{Map, Value};

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !number.is_u64() && !number.is_i64() => {
            format!("{}", f as i64)
        }
        _ => number.to_string(),
    }
}

fn object(body: &Value) -> Result<&Map<String, Value>, String> {
    body.as_object().ok_or_else(|| "body must be object".to_owned())
}

fn required(map: &Map<String, Value>, name: &str) -> Result<(), String> {
    if map.contains_key(name) {
        Ok(())
    } else {
        Err(format!("body must have required property '{name}'"))
    }
}

/// A one-item list stands in for its item.
fn unwrap_single(value: &Value) -> &Value {
    match value.as_array() {
        Some(items) if items.len() == 1 && !items[0].is_array() && !items[0].is_object() => &items[0],
        _ => value,
    }
}

/// Text from a text field. Numbers and booleans become their text, null becomes empty.
fn coerce_text(value: &Value) -> Option<String> {
    match unwrap_single(value) {
        Value::String(t) => Some(t.clone()),
        Value::Number(n) => Some(js_number(n)),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn union(at: &str, failures: &[&str]) -> String {
    let mut parts: Vec<String> = failures.iter().map(|f| format!("{at} must {f}")).collect();
    parts.push(format!("{at} must match a schema in anyOf"));
    parts.join(", ")
}

/// A text field that may also be null. Absent stays absent.
fn nullable_text(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match map.get(name) {
        None => Ok(None),
        Some(value) => coerce_text(value)
            .map(Some)
            .ok_or_else(|| union(&format!("body/{name}"), &["be string", "be null"])),
    }
}

/// A whole number from 1 to 5, or null. Absent stays absent.
fn rating(map: &Map<String, Value>, name: &str) -> Result<Option<Option<i64>>, String> {
    let Some(value) = map.get(name) else { return Ok(None) };
    let at = format!("body/{name}");
    let value = unwrap_single(value);
    let whole: Option<i64> = match value {
        Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 1e15).map(|f| f as i64),
        Value::Bool(b) => Some(*b as i64),
        Value::Null => Some(0),
        Value::String(t) => t
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| !t.trim().is_empty() && f.fract() == 0.0 && f.abs() < 1e15)
            .map(|f| f as i64),
        _ => None,
    };
    match whole {
        Some(n) if (1..=5).contains(&n) => Ok(Some(Some(n))),
        // Zero, empty text, false and null all read as null in the second branch.
        Some(0) => Ok(Some(None)),
        Some(n) if n < 1 => Err(union(&at, &["be >= 1", "be null"])),
        Some(_) => Err(union(&at, &["be <= 5", "be null"])),
        None if matches!(value, Value::String(t) if t.is_empty()) => Ok(Some(None)),
        None => Err(union(&at, &["be integer", "be null"])),
    }
}

fn choice(map: &Map<String, Value>, name: &str, allowed: &[&str]) -> Result<Option<String>, String> {
    let Some(value) = map.get(name) else { return Ok(None) };
    let at = format!("body/{name}");
    let text = coerce_text(value).ok_or_else(|| format!("{at} must be string"))?;
    if allowed.contains(&text.as_str()) {
        Ok(Some(text))
    } else {
        Err(format!("{at} must be equal to one of the allowed values"))
    }
}

fn sensations(map: &Map<String, Value>) -> Result<Option<Vec<String>>, String> {
    let Some(value) = map.get("sensations") else { return Ok(None) };
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => return Err("body/sensations must be array".into()),
        scalar => vec![scalar],
    };
    items
        .iter()
        .enumerate()
        .map(|(i, item)| coerce_text(item).ok_or_else(|| format!("body/sensations/{i} must be string")))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Empty text and null mean no selection. Other text is trimmed.
fn trimmed(text: Option<String>) -> Option<Option<String>> {
    text.map(|t| if t.is_empty() { None } else { Some(t.trim().to_owned()) })
}

pub struct CheckinInput {
    pub feeling_core: String,
    pub feeling_secondary: Option<Option<String>>,
    pub sensations: Option<Vec<String>>,
    pub intensity: Option<Option<i64>>,
    pub energy: Option<Option<i64>>,
    pub note: Option<Option<String>>,
    pub identified_via: Option<String>,
}

const PATH_ERROR: &str = "feelingSecondary/feelingTertiary must form a valid path under feelingCore";

/// A new check-in (`create`) or a change to one. A change leaves omitted fields as they were.
pub fn checkin(body: &Value, create: bool) -> Result<CheckinInput, String> {
    let map = object(body)?;
    required(map, "feelingCore")?;
    let feeling_core = choice(map, "feelingCore", &taxonomy::CORES)?.unwrap_or_default();
    let secondary = trimmed(nullable_text(map, "feelingSecondary")?);
    let tertiary = trimmed(nullable_text(map, "feelingTertiary")?);
    let sensations = sensations(map)?;
    let intensity = rating(map, "intensity")?;
    let energy = rating(map, "energy")?;
    let note = trimmed(nullable_text(map, "note")?);
    let identified_via = if create { choice(map, "identifiedVia", &["wheel", "assisted"])? } else { None };
    let secondary_label = secondary.as_ref().and_then(|s| s.as_deref());
    let tertiary_label = tertiary.as_ref().and_then(|s| s.as_deref());
    if !taxonomy::valid_path(&feeling_core, secondary_label, tertiary_label) {
        return Err(PATH_ERROR.into());
    }
    Ok(CheckinInput { feeling_core, feeling_secondary: secondary, sensations, intensity, energy, note, identified_via })
}

/// The consent answer. The old schema read "true", 1, "false", 0 and null as booleans.
pub fn consent(body: &Value) -> Result<bool, String> {
    let map = object(body)?;
    required(map, "granted")?;
    match unwrap_single(&map["granted"]) {
        Value::Bool(b) => Ok(*b),
        Value::Null => Ok(false),
        Value::String(t) if t == "true" => Ok(true),
        Value::String(t) if t == "false" => Ok(false),
        Value::Number(n) if n.as_f64() == Some(1.0) => Ok(true),
        Value::Number(n) if n.as_f64() == Some(0.0) => Ok(false),
        _ => Err("body/granted must be boolean".into()),
    }
}

pub const EXPORT_CATEGORIES: [&str; 4] = ["checkins", "medications", "therapyNotes", "insights"];

pub struct ExportInput {
    pub from: String,
    pub to: String,
    pub categories: Vec<String>,
}

fn date_text(map: &Map<String, Value>, name: &str) -> Result<String, String> {
    let at = format!("body/{name}");
    let text = coerce_text(&map[name]).ok_or_else(|| format!("{at} must be string"))?;
    let shaped = text.len() == 10
        && text.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if shaped {
        Ok(text)
    } else {
        Err(format!("{at} must match pattern \"^\\d{{4}}-\\d{{2}}-\\d{{2}}$\""))
    }
}

/// An export request as the old route schema read it. A single category stands for a one-item
/// list, and unknown fields are dropped.
pub fn export_request(body: &Value) -> Result<ExportInput, String> {
    let map = object(body)?;
    for name in ["from", "to", "categories"] {
        required(map, name)?;
    }
    let from = date_text(map, "from")?;
    let to = date_text(map, "to")?;
    let items: Vec<&Value> = match &map["categories"] {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => return Err("body/categories must be array".into()),
        scalar => vec![scalar],
    };
    let mut categories = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("body/categories/{i}");
        let text = coerce_text(item).ok_or_else(|| format!("{at} must be string"))?;
        if !EXPORT_CATEGORIES.contains(&text.as_str()) {
            return Err(format!("{at} must be equal to one of the allowed values"));
        }
        categories.push(text);
    }
    if categories.is_empty() {
        return Err("body/categories must NOT have fewer than 1 items".into());
    }
    Ok(ExportInput { from, to, categories })
}
