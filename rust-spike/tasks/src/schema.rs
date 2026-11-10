//! Request-schema checks with Fastify's default Ajv behaviour.
//!
//! Fastify validates each request against the route's JSON schema before the handler runs,
//! with `coerceTypes: "array"`, `removeAdditional: true` and `allErrors: false`. Coercion
//! rewrites the value in place, and a value coerced inside a failed `anyOf` branch stays
//! coerced for the next branch, exactly as Ajv leaves it. Messages use Ajv's wording and
//! Fastify's `<dataVar><instancePath> <message>` join.

use serde_json::{Map, Number, Value};

#[derive(Clone, Debug)]
pub enum Schema {
    Object(ObjectSchema),
    String {
        allowed: Option<&'static [&'static str]>,
        pattern: Option<Pattern>,
    },
    Integer {
        minimum: Option<i64>,
        maximum: Option<i64>,
    },
    Boolean,
    Null,
    AnyOf(Vec<Schema>),
}

#[derive(Clone, Debug)]
pub struct ObjectSchema {
    pub required: &'static [&'static str],
    pub properties: Vec<(&'static str, Schema)>,
    pub additional_properties: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Pattern {
    pub source: &'static str,
    pub test: fn(&str) -> bool,
}

impl Schema {
    pub fn string() -> Self {
        Self::String {
            allowed: None,
            pattern: None,
        }
    }

    pub fn one_of_strings(allowed: &'static [&'static str]) -> Self {
        Self::String {
            allowed: Some(allowed),
            pattern: None,
        }
    }

    pub fn nullable(inner: Schema) -> Self {
        Self::AnyOf(vec![inner, Schema::Null])
    }

    pub fn object(
        required: &'static [&'static str],
        properties: Vec<(&'static str, Schema)>,
    ) -> Self {
        Self::Object(ObjectSchema {
            required,
            properties,
            additional_properties: false,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ValidationFailure {
    pub message: String,
}

struct Issue {
    path: String,
    message: String,
}

/// Validates and coerces `value` in place. `data_var` is `body`, `params` or `querystring`.
pub fn validate(
    schema: &Schema,
    value: &mut Value,
    data_var: &str,
) -> Result<(), ValidationFailure> {
    let mut issues = Vec::new();
    if check(schema, value, "", &mut issues) {
        return Ok(());
    }
    let message = issues
        .iter()
        .map(|issue| format!("{data_var}{} {}", issue.path, issue.message))
        .collect::<Vec<_>>()
        .join(", ");
    Err(ValidationFailure { message })
}

fn check(schema: &Schema, value: &mut Value, path: &str, issues: &mut Vec<Issue>) -> bool {
    let issue = |issues: &mut Vec<Issue>, message: String| {
        issues.push(Issue {
            path: path.to_owned(),
            message,
        });
        false
    };
    match schema {
        Schema::AnyOf(branches) => {
            let mark = issues.len();
            for branch in branches {
                if check(branch, value, path, issues) {
                    issues.truncate(mark);
                    return true;
                }
            }
            issue(issues, "must match a schema in anyOf".into())
        }
        Schema::Null => {
            if coerce_null(value) {
                true
            } else {
                issue(issues, "must be null".into())
            }
        }
        Schema::Boolean => {
            if coerce_boolean(value) {
                true
            } else {
                issue(issues, "must be boolean".into())
            }
        }
        Schema::Integer { minimum, maximum } => {
            if !coerce_integer(value) {
                return issue(issues, "must be integer".into());
            }
            let number = value.as_f64().unwrap_or_default();
            if let Some(max) = maximum {
                if number > *max as f64 {
                    return issue(issues, format!("must be <= {max}"));
                }
            }
            if let Some(min) = minimum {
                if number < *min as f64 {
                    return issue(issues, format!("must be >= {min}"));
                }
            }
            true
        }
        Schema::String { allowed, pattern } => {
            if !coerce_string(value) {
                return issue(issues, "must be string".into());
            }
            let text = value.as_str().unwrap_or_default();
            if let Some(allowed) = allowed {
                if !allowed.contains(&text) {
                    return issue(issues, "must be equal to one of the allowed values".into());
                }
            }
            if let Some(pattern) = pattern {
                if !(pattern.test)(text) {
                    return issue(issues, format!("must match pattern \"{}\"", pattern.source));
                }
            }
            true
        }
        Schema::Object(object) => {
            let Value::Object(map) = value else {
                return issue(issues, "must be object".into());
            };
            for name in object.required {
                if !map.contains_key(*name) {
                    return issue(issues, format!("must have required property '{name}'"));
                }
            }
            if !object.additional_properties {
                map.retain(|key, _| object.properties.iter().any(|(name, _)| name == key));
            }
            for (name, property) in &object.properties {
                if let Some(child) = map.get_mut(*name) {
                    let child_path = format!("{path}/{name}");
                    if !check(property, child, &child_path, issues) {
                        return false;
                    }
                }
            }
            true
        }
    }
}

/// Ajv's `coerceTypes: "array"` unwraps a one-item array when a scalar is expected.
fn unwrap_single(value: &mut Value) {
    if let Value::Array(items) = value {
        if items.len() == 1 && !items[0].is_array() && !items[0].is_object() {
            let item = items.remove(0);
            *value = item;
        }
    }
}

fn coerce_string(value: &mut Value) -> bool {
    unwrap_single(value);
    let coerced = match value {
        Value::String(_) => return true,
        Value::Number(number) => Value::String(js_number_string(number)),
        Value::Bool(flag) => Value::String(flag.to_string()),
        Value::Null => Value::String(String::new()),
        _ => return false,
    };
    *value = coerced;
    true
}

fn coerce_integer(value: &mut Value) -> bool {
    unwrap_single(value);
    let coerced = match value {
        Value::Number(number) => return number.as_f64().is_some_and(|n| n.fract() == 0.0),
        Value::String(text) => match parse_js_number(text) {
            Some(n) if n.fract() == 0.0 => json_number(n),
            _ => return false,
        },
        Value::Bool(flag) => Value::Number(Number::from(u8::from(*flag))),
        Value::Null => Value::Number(Number::from(0)),
        _ => return false,
    };
    *value = coerced;
    true
}

fn coerce_boolean(value: &mut Value) -> bool {
    unwrap_single(value);
    let coerced = match value {
        Value::Bool(_) => return true,
        Value::String(text) if text == "true" => Value::Bool(true),
        Value::String(text) if text == "false" => Value::Bool(false),
        Value::Number(number) if number.as_f64() == Some(1.0) => Value::Bool(true),
        Value::Number(number) if number.as_f64() == Some(0.0) => Value::Bool(false),
        Value::Null => Value::Bool(false),
        _ => return false,
    };
    *value = coerced;
    true
}

fn coerce_null(value: &mut Value) -> bool {
    unwrap_single(value);
    let empty = match value {
        Value::Null => return true,
        Value::String(text) => text.is_empty(),
        Value::Number(number) => number.as_f64() == Some(0.0),
        Value::Bool(flag) => !*flag,
        _ => false,
    };
    if empty {
        *value = Value::Null;
    }
    empty
}

/// Ajv coerces a string to a number only when it is non-empty and `data == +data` holds.
fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if text.is_empty() || trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::Number(Number::from(n as i64))
    } else {
        Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `String(number)` for the integral and simple decimal values requests carry.
fn js_number_string(number: &Number) -> String {
    match number.as_f64() {
        Some(n) if n.fract() == 0.0 && n.abs() < 1e21 => format!("{}", n as i64),
        Some(n) => format!("{n}"),
        None => number.to_string(),
    }
}

/// Helpers for handlers, which read the coerced body the way TypeScript reads `request.body`.
pub fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn priority_body() -> Schema {
        Schema::object(
            &["title"],
            vec![
                ("title", Schema::string()),
                (
                    "priority",
                    Schema::nullable(Schema::Integer {
                        minimum: Some(1),
                        maximum: Some(5),
                    }),
                ),
            ],
        )
    }

    #[test]
    fn reports_missing_required_first() {
        let mut body = json!({ "priority": 9 });
        let failure = validate(&priority_body(), &mut body, "body").unwrap_err();
        assert_eq!(failure.message, "body must have required property 'title'");
    }

    #[test]
    fn joins_any_of_branch_errors() {
        let mut body = json!({ "title": "x", "priority": 9 });
        let failure = validate(&priority_body(), &mut body, "body").unwrap_err();
        assert_eq!(
            failure.message,
            "body/priority must be <= 5, body/priority must be null, body/priority must match a schema in anyOf"
        );
    }

    #[test]
    fn coerces_like_ajv() {
        let mut body = json!({ "title": 12, "priority": "3", "extra": true });
        validate(&priority_body(), &mut body, "body").unwrap();
        assert_eq!(body, json!({ "title": "12", "priority": 3 }));

        // A zero fails the integer branch, then coerces to null in the second branch.
        let mut zero = json!({ "title": "x", "priority": 0 });
        validate(&priority_body(), &mut zero, "body").unwrap();
        assert_eq!(zero, json!({ "title": "x", "priority": null }));
    }

    #[test]
    fn rejects_non_object_body() {
        let mut body = Value::Null;
        let failure = validate(&priority_body(), &mut body, "body").unwrap_err();
        assert_eq!(failure.message, "body must be object");
    }
}
