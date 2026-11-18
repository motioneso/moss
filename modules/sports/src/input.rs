//! Request body checks that give the answers the old route schema gave. The old server coerced
//! numbers and booleans to text, dropped unknown fields and reported the first failure.
use serde_json::Value;

const OBJECT: &str = "body must be object";

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !number.is_u64() && !number.is_i64() => {
            format!("{}", f as i64)
        }
        _ => number.to_string(),
    }
}

/// A text field as the old schema read it. `nullable` fields keep a null.
fn text_field(
    body: &serde_json::Map<String, Value>,
    name: &str,
    nullable: bool,
    max: usize,
) -> Result<Option<String>, String> {
    let at = format!("body/{name}");
    let text = match body.get(name) {
        None => return Ok(None),
        Some(Value::Null) if nullable => return Ok(None),
        Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => {
            return Err(format!("{at} must be {}", if nullable { "string,null" } else { "string" }))
        }
    };
    if !nullable && text.is_empty() {
        return Err(format!("{at} must NOT have fewer than 1 characters"));
    }
    if text.chars().count() > max {
        return Err(format!("{at} must NOT have more than {max} characters"));
    }
    Ok(Some(text))
}

fn object(body: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    body.as_object().ok_or_else(|| OBJECT.to_owned())
}

/// `{competitionKey, teamKey?}` for a new follow.
pub fn new_follow(body: &Value) -> Result<(String, Option<String>), String> {
    let map = object(body)?;
    if !map.contains_key("competitionKey") {
        return Err("body must have required property 'competitionKey'".into());
    }
    let competition = text_field(map, "competitionKey", false, 100)?.unwrap_or_default();
    let team = text_field(map, "teamKey", true, 100)?;
    Ok((competition, team))
}

/// `{sourceTeamId}` for choosing which team an older follow meant.
pub fn chosen_team(body: &Value) -> Result<String, String> {
    let map = object(body)?;
    if !map.contains_key("sourceTeamId") {
        return Err("body must have required property 'sourceTeamId'".into());
    }
    Ok(text_field(map, "sourceTeamId", false, 100)?.unwrap_or_default())
}
