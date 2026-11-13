//! Request body checks for definitions. Two layers match the old route.
//! First the framework schema step, which drops unknown keys and coerces scalar types.
//! Then the handler checks with their own messages.
use crate::{schedule, sources, text::js_trim};
use serde_json::{Map, Value};

pub type Failure = String;
const CADENCES: [&str; 3] = ["manual", "daily", "weekly"];
const TYPES: [&str; 3] = ["morning", "evening", "weekly_review"];
const KEYS: [&str; 6] = [
    "title",
    "briefingType",
    "cadence",
    "scheduleMetadata",
    "enabled",
    "selectedToolNames",
];

/// A validated body. Only the fields the caller sent are `Some`.
#[derive(Default, Debug)]
pub struct Definition {
    pub title: Option<String>,
    pub briefing_type: Option<String>,
    pub cadence: Option<String>,
    pub schedule_metadata: Option<Map<String, Value>>,
    pub enabled: Option<bool>,
    pub selected_tool_names: Option<Vec<String>>,
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

/// Coercion of a one-element array to its element, as the schema step does.
fn unwrap_single(value: &Value) -> &Value {
    match value {
        Value::Array(items) if items.len() == 1 => &items[0],
        other => other,
    }
}

fn coerce_text(path: &str, value: &Value) -> Result<String, Failure> {
    scalar_text(unwrap_single(value)).ok_or_else(|| format!("{path} must be string"))
}

fn coerce_choice(path: &str, value: &Value, allowed: &[&str]) -> Result<String, Failure> {
    let text = coerce_text(path, value)?;
    if allowed.contains(&text.as_str()) {
        Ok(text)
    } else {
        Err(format!("{path} must be equal to one of the allowed values"))
    }
}

fn coerce_bool(value: &Value) -> Result<bool, Failure> {
    let fail = || "body/enabled must be boolean".to_owned();
    match unwrap_single(value) {
        Value::Bool(b) => Ok(*b),
        Value::Null => Ok(false),
        Value::String(s) if s == "true" => Ok(true),
        Value::String(s) if s == "false" => Ok(false),
        Value::Number(n) if n.as_f64() == Some(1.0) => Ok(true),
        Value::Number(n) if n.as_f64() == Some(0.0) => Ok(false),
        _ => Err(fail()),
    }
}

/// Schema step. `create` requires a title.
fn schema_step(body: &Value, create: bool) -> Result<Map<String, Value>, Failure> {
    let object = body
        .as_object()
        .ok_or_else(|| "body must be object".to_owned())?;
    if create && !object.contains_key("title") {
        return Err("body must have required property 'title'".into());
    }
    let mut kept = Map::new();
    for key in KEYS {
        if let Some(value) = object.get(key) {
            kept.insert(key.to_owned(), value.clone());
        }
    }
    Ok(kept)
}

/// Whitespace-trimmed, non-empty text, as the handler's string reader.
fn read_string(field: &str, value: &Value) -> Result<String, Failure> {
    let text = coerce_text(&format!("body/{field}"), value)?;
    let trimmed = js_trim(&text);
    if trimmed.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(trimmed.to_owned())
}

fn tool_names(value: &Value) -> Result<Vec<String>, Failure> {
    let items: Vec<Value> = match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    };
    let mut names: Vec<String> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let text = coerce_text("body/selectedToolNames/0", item)
            .map_err(|_| format!("body/selectedToolNames/{index} must be string"))?;
        let trimmed = js_trim(&text);
        if trimmed.is_empty() {
            return Err(format!("selectedToolNames[{index}] must not be empty"));
        }
        if !names.iter().any(|n| n == trimmed) {
            names.push(trimmed.to_owned());
        }
    }
    if names.iter().any(|n| !sources::allowed(n)) {
        return Err("Briefings can only select declared read-risk assistant tools".into());
    }
    Ok(names)
}

fn check_schedule(cadence: Option<&str>, metadata: &Option<Map<String, Value>>) -> Result<(), Failure> {
    let Some(metadata) = metadata else { return Ok(()) };
    if let Some(zone) = metadata.get("timezone") {
        match zone.as_str() {
            Some(name) if schedule::valid_zone(name) => {}
            _ => return Err("invalid timezone".into()),
        }
    }
    if cadence == Some("weekly") && metadata.get("dayOfWeek").is_none_or(Value::is_null) {
        return Err("dayOfWeek required for weekly schedules".into());
    }
    Ok(())
}

/// Parses a create (`create = true`) or update body.
pub fn parse(body: &Value, create: bool) -> Result<Definition, Failure> {
    let fields = schema_step(body, create)?;
    let mut out = Definition::default();
    if let Some(v) = fields.get("briefingType") {
        out.briefing_type = Some(coerce_choice("body/briefingType", v, &TYPES)?);
    }
    if let Some(v) = fields.get("cadence") {
        out.cadence = Some(coerce_choice("body/cadence", v, &CADENCES)?);
    }
    if let Some(v) = fields.get("scheduleMetadata") {
        out.schedule_metadata = Some(
            v.as_object()
                .cloned()
                .ok_or_else(|| "body/scheduleMetadata must be object".to_owned())?,
        );
    }
    if let Some(v) = fields.get("enabled") {
        out.enabled = Some(coerce_bool(v)?);
    }
    if let Some(v) = fields.get("title") {
        coerce_text("body/title", v)?;
    }
    if let Some(v) = fields.get("selectedToolNames") {
        out.selected_tool_names = Some(tool_names(v)?);
    } else if create {
        let kind = out.briefing_type.as_deref().unwrap_or("morning");
        out.selected_tool_names = Some(sources::defaults(kind).into_iter().map(String::from).collect());
    }
    let cadence = out.cadence.clone().or_else(|| create.then(|| "manual".to_owned()));
    check_schedule(cadence.as_deref(), &out.schedule_metadata)?;
    if let Some(v) = fields.get("title") {
        out.title = Some(read_string("title", v)?);
    }
    Ok(out)
}

/// The body of a run-now request. No body is allowed. Unknown keys are dropped. The key is
/// checked by the schema step (length) and then by the handler (not blank after trimming).
pub fn parse_run_key(body: &Value) -> Result<Option<String>, Failure> {
    if body.is_null() {
        return Ok(None);
    }
    let object = body.as_object().ok_or_else(|| "body must be object".to_owned())?;
    let Some(value) = object.get("idempotencyKey") else { return Ok(None) };
    let text = coerce_text("body/idempotencyKey", value)?;
    match text.encode_utf16().count() {
        0 => return Err("body/idempotencyKey must NOT have fewer than 1 characters".into()),
        201.. => return Err("body/idempotencyKey must NOT have more than 200 characters".into()),
        _ => {}
    }
    let trimmed = js_trim(&text);
    if trimmed.is_empty() {
        return Err("idempotencyKey must not be empty".into());
    }
    Ok(Some(trimmed.to_owned()))
}
