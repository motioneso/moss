//! The body schemas from the legacy Fastify People routes, including Ajv coercion.
//! Unknown members remain available to the handlers (Type.Object permits them).
use moss_module_sdk::{Response, RouteRequest};
use serde_json::{json, Value};

#[derive(Clone)]
enum Kind {
    String,
    Strings,
    Object(Vec<Field>),
    AnyOf(Vec<Kind>),
    Literal(&'static str),
    Null,
}
#[derive(Clone)]
struct Field(&'static str, bool, Kind);
use Kind::{AnyOf, Literal, Null, Object, String as Text, Strings};

fn schema(method: &str, path: &str) -> Option<Kind> {
    let fields = match (method, path) {
        ("POST", "/people") => vec![
            Field("displayName", true, Text),
            Field("aliases", false, Strings),
            Field("emails", false, Strings),
            Field("phones", false, Strings),
        ],
        ("PATCH", "/people/:id") => vec![
            Field("displayName", false, Text),
            Field(
                "status",
                false,
                AnyOf(vec![Literal("active"), Literal("archived")]),
            ),
        ],
        ("POST", "/people/:id/merge") => vec![Field("secondaryPersonId", true, Text)],
        ("POST", "/people/:id/split-identity") => vec![
            Field("identityId", true, Text),
            Field("targetPersonId", false, Text),
            Field("newPersonDisplayName", false, Text),
        ],
        ("PUT", "/people/notes-settings") => vec![Field("folder", true, AnyOf(vec![Text, Null]))],
        _ => return None,
    };
    Some(Object(fields))
}

pub fn validate(request: &mut RouteRequest) -> Option<Response> {
    let schema = schema(&request.method, &request.path)?;
    let mut errors = vec![];
    let mut body = request.body.clone();
    if check(&schema, &mut body, "body", &mut errors) {
        request.body = body;
        None
    } else {
        Some(Response::new(400, json!({"error":errors.join(", ")})))
    }
}
fn unwrap_single(value: &mut Value) {
    if let Value::Array(items) = value {
        if items.len() == 1 {
            *value = items.remove(0);
        }
    }
}
fn string(value: &mut Value) -> bool {
    unwrap_single(value);
    *value = match value {
        Value::String(_) => return true,
        Value::Bool(v) => Value::String(v.to_string()),
        Value::Number(v) => Value::String(number_text(v)),
        Value::Null => Value::String(std::string::String::new()),
        _ => return false,
    };
    true
}
fn check(
    kind: &Kind,
    value: &mut Value,
    path: &str,
    errors: &mut Vec<std::string::String>,
) -> bool {
    let fail = |errors: &mut Vec<std::string::String>, message: std::string::String| {
        errors.push(format!("{path} {message}"));
        false
    };
    match kind {
        AnyOf(branches) => {
            let start = errors.len();
            for branch in branches {
                if check(branch, value, path, errors) {
                    errors.truncate(start);
                    return true;
                }
            }
            fail(errors, "must match a schema in anyOf".into())
        }
        Text | Literal(_) => {
            if !string(value) {
                return fail(errors, "must be string".into());
            }
            if let Literal(expected) = kind {
                if value.as_str() != Some(expected) {
                    return fail(errors, "must be equal to constant".into());
                }
            }
            true
        }
        Null => {
            unwrap_single(value);
            if value.is_null()
                || *value == json!("")
                || *value == json!(false)
                || *value == json!(0)
            {
                *value = Value::Null;
                true
            } else {
                fail(errors, "must be null".into())
            }
        }
        Object(fields) => {
            let Some(object) = value.as_object_mut() else {
                return fail(errors, "must be object".into());
            };
            for Field(name, required, _) in fields {
                if *required && !object.contains_key(*name) {
                    return fail(errors, format!("must have required property '{name}'"));
                }
            }
            for Field(name, _, kind) in fields {
                if let Some(value) = object.get_mut(*name) {
                    if !check(kind, value, &format!("{path}/{name}"), errors) {
                        return false;
                    }
                }
            }
            true
        }
        Strings => {
            if !value.is_array()
                && (value.is_string() || value.is_number() || value.is_boolean() || value.is_null())
            {
                *value = json!([value.clone()]);
            }
            let Some(items) = value.as_array_mut() else {
                return fail(errors, "must be array".into());
            };
            for (index, item) in items.iter_mut().enumerate() {
                if !check(&Text, item, &format!("{path}/{index}"), errors) {
                    return false;
                }
            }
            true
        }
    }
}

// JS first rounds JSON numbers to binary64 and uses scientific notation outside
// [1e-6, 1e21). Rust Display supplies shortest digits; retain JS exponent spelling.
pub(crate) fn number_text(number: &serde_json::Number) -> std::string::String {
    let n = number.as_f64().unwrap_or(0.0);
    if n == 0.0 {
        return "0".into();
    }
    let raw = n.abs().to_string();
    let decimal = raw.find('.').unwrap_or(raw.len());
    let mut digits: std::string::String = raw.chars().filter(char::is_ascii_digit).collect();
    let first = digits.find(|c| c != '0').unwrap_or(0);
    let exponent = decimal as i32 - first as i32 - 1;
    digits = digits[first..].trim_end_matches('0').to_owned();
    let sign = if n < 0.0 { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        let tail = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            std::string::String::new()
        };
        format!(
            "{sign}{}{tail}e{}{exponent}",
            &digits[..1],
            if exponent >= 0 { "+" } else { "" }
        )
    } else {
        format!("{sign}{raw}")
    }
}
