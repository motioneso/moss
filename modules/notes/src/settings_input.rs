//! Match the existing Fastify/Ajv Settings schemas, including their coercions.
//! This only prepares a path; the account-bound vault still admits the folder.
use serde_json::{json, Value};

pub(crate) fn validation(message: &str) -> moss_module_sdk::Response {
    // Moss's API error handler projects validation errors to this shape.
    moss_module_sdk::Response::new(400, json!({"error":message}))
}

fn null_coercion(value: &Value) -> bool {
    value == false || value == "" || value.as_f64() == Some(0.)
}
fn singleton(value: &Value) -> &Value {
    match value.as_array() {
        Some(values) if values.len() == 1 => &values[0],
        _ => value,
    }
}
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::Bool(v) => Some(v.to_string()),
        Value::Number(v) => {
            // JavaScript numbers use binary64, fixed notation in [1e-6,1e21),
            // and an explicit plus sign for a positive scientific exponent.
            let n = v.as_f64()?;
            Some(if n == 0. {
                "0".into()
            } else if (1e-6..1e21).contains(&n.abs()) {
                n.to_string()
            } else {
                let text = format!("{n:e}");
                let (mantissa, exponent) = text.split_once('e')?;
                format!(
                    "{mantissa}e{}{exponent}",
                    if exponent.starts_with('-') { "" } else { "+" }
                )
            })
        }
        Value::Null => Some(String::new()),
        _ => None,
    }
}

pub(crate) fn folder_path(body: &Value) -> Result<Value, &'static str> {
    if body.is_null() || null_coercion(singleton(body)) {
        return Ok(Value::Null);
    }
    let object = body.as_object().ok_or("body must be object,null")?;
    let value = object.get("path").unwrap_or(&Value::Null);
    if value.is_null() || value.is_string() {
        return Ok(value.clone());
    }
    // Ajv's union-type coercion unwraps one array item only while coercing it;
    // a singleton containing an already typed string is still invalid, except
    // that the empty string coerces to null. Preserve this legacy behavior.
    let value = singleton(value);
    if let Some(text) = scalar_text(value) {
        Ok(json!(text))
    } else if value == "" {
        Ok(Value::Null)
    } else {
        Err("body/path must be string,null")
    }
}

pub(crate) fn query_path(value: Option<&Value>) -> Result<Value, &'static str> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    let value = singleton(value);
    if value.is_string() {
        return Ok(value.clone());
    }
    scalar_text(value)
        .map(|s| json!(s))
        .ok_or("querystring/path must be string")
}
