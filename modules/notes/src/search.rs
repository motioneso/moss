//! Legacy search projection and input coercion. Indexed memory belongs to core;
//! the guest cannot choose an account, source kind, SQL or embedding model.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    tool: String,
    parameters: Parameters,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parameters {
    #[serde(default)]
    query: Value,
    #[serde(default = "undefined")]
    limit: Value,
}
fn undefined() -> Value {
    json!({})
}
fn trim(s: &str) -> &str {
    s.trim_matches(crate::blocks::js_whitespace)
}
// Array ToPrimitive used by Number(array); null elements stringify as empty.
fn array_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(v) => v.iter().map(array_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}
fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.,
        Value::Bool(v) => u8::from(*v) as f64,
        Value::Number(v) => v.as_f64().unwrap_or(f64::NAN),
        Value::Array(_) => number(&Value::String(array_string(value))),
        Value::String(s) => {
            let s = trim(s);
            if s.is_empty() {
                return 0.;
            }
            for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
                if s.to_ascii_lowercase().starts_with(prefix) {
                    let digits = &s[2..];
                    if digits.is_empty() {
                        return f64::NAN;
                    }
                    return digits
                        .chars()
                        .try_fold(0., |n, c| {
                            c.to_digit(radix).map(|d| n * radix as f64 + d as f64)
                        })
                        .unwrap_or(f64::NAN);
                }
            }
            s.parse().unwrap_or(f64::NAN)
        }
        Value::Object(_) => f64::NAN,
    }
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: Request = serde_json::from_str(payload)?;
    if request.tool != "notes.search" {
        return Err(Error::new("Unknown Notes search tool"));
    }
    let query = request.parameters.query.as_str().map(trim).unwrap_or("");
    if query.is_empty() {
        return Ok(json!({"data":{"chunks":[]}}).to_string());
    }
    let parsed = number(&request.parameters.limit);
    let limit = if parsed.is_finite() {
        parsed.trunc().clamp(1., 20.) as u32
    } else {
        8
    };
    let result = host.call(
        "vault",
        "index.search",
        "source",
        json!({"query":query,"limit":limit}),
    )?;
    let chunks = result["chunks"]
        .as_array()
        .ok_or_else(|| Error::new("Notes search is unavailable"))?;
    let mut projected = Vec::new();
    for chunk in chunks {
        let path = chunk["sourcePath"]
            .as_str()
            .ok_or_else(|| Error::new("Invalid Notes search result"))?;
        let text = chunk["text"]
            .as_str()
            .ok_or_else(|| Error::new("Invalid Notes search result"))?;
        let start = chunk["lineStart"]
            .as_u64()
            .ok_or_else(|| Error::new("Invalid Notes search result"))?;
        let end = chunk["lineEnd"]
            .as_u64()
            .filter(|n| *n >= start)
            .ok_or_else(|| Error::new("Invalid Notes search result"))?;
        projected.push(json!({"sourcePath":path,"lineStart":start,"lineEnd":end,"text":text}));
    }
    Ok(json!({"data":{"chunks":projected}}).to_string())
}
