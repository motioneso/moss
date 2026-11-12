//! Request checks that mirror Fastify's Ajv messages for the Meetings route schemas.
//! Messages join as `<data var><path> <message>` and the first failure wins.
use crate::text::{code_points, is_uuid};
use moss_module_sdk::RouteRequest;
use serde_json::{Map, Value};

pub type Failure = String;

#[derive(Clone, Copy)]
pub enum Kind {
    Uuid,
    Text { min: usize, max: usize },
    /// Text that also holds a non-whitespace character (the old schema's `\S` pattern).
    Ident { min: usize, max: usize },
    Int { min: i64, max: i64 },
    /// `format: "date-time"`.
    DateTime,
    /// The recording type id pattern `^[a-z][a-z0-9-]{0,63}$`.
    TypeId,
    Enum(&'static [&'static str]),
    /// `const` for an integer.
    IntConst(i64),
    /// Any JSON object. Its contents are checked elsewhere.
    Object,
    /// Present and checked elsewhere.
    Any,
}

fn object<'a>(var: &str, value: &'a Value) -> Result<&'a Map<String, Value>, Failure> {
    value.as_object().ok_or_else(|| format!("{var} must be object"))
}

fn check(var: &str, name: &str, kind: Kind, value: &Value) -> Result<(), Failure> {
    let at = format!("{var}/{name}");
    match kind {
        Kind::Uuid => match value.as_str() {
            Some(s) if is_uuid(s) => Ok(()),
            Some(_) => Err(format!("{at} must match format \"uuid\"")),
            None => Err(format!("{at} must be string")),
        },
        Kind::Text { min, max } | Kind::Ident { min, max } => {
            let s = value.as_str().ok_or_else(|| format!("{at} must be string"))?;
            let n = code_points(s);
            if n > max {
                return Err(format!("{at} must NOT have more than {max} characters"));
            }
            if n < min {
                return Err(format!("{at} must NOT have fewer than {min} characters"));
            }
            if matches!(kind, Kind::Ident { .. }) && crate::text::js_trim(s).is_empty() {
                return Err(format!("{at} must match pattern \"\\S\""));
            }
            Ok(())
        }
        Kind::Any => Ok(()),
        Kind::Object => match value {
            Value::Object(_) => Ok(()),
            _ => Err(format!("{at} must be object")),
        },
        Kind::IntConst(expected) => {
            let n = int_value(value).ok_or_else(|| format!("{at} must be integer"))?;
            if n == expected {
                Ok(())
            } else {
                Err(format!("{at} must be equal to constant"))
            }
        }
        Kind::DateTime => match value.as_str() {
            Some(s) if chrono::DateTime::parse_from_rfc3339(&crate::text::with_colon_offset(s)).is_ok() => Ok(()),
            Some(_) => Err(format!("{at} must match format \"date-time\"")),
            None => Err(format!("{at} must be string")),
        },
        Kind::TypeId => match value.as_str() {
            Some(s) if crate::text::is_type_id(s) => Ok(()),
            Some(_) => Err(format!("{at} must match pattern \"^[a-z][a-z0-9-]{{0,63}}$\"")),
            None => Err(format!("{at} must be string")),
        },
        Kind::Enum(allowed) => match value {
            Value::String(s) if allowed.contains(&s.as_str()) => Ok(()),
            Value::Array(_) | Value::Object(_) => Err(format!("{at} must be string")),
            _ => Err(format!("{at} must be equal to one of the allowed values")),
        },
        Kind::Int { min, max } => {
            let n = int_value(value).ok_or_else(|| format!("{at} must be integer"))?;
            if n > max {
                return Err(format!("{at} must be <= {max}"));
            }
            if n < min {
                return Err(format!("{at} must be >= {min}"));
            }
            Ok(())
        }
    }
}

/// Validates an object with no additional properties. Integer strings are coerced like Ajv's
/// `coerceTypes`, so a query-string number passes and is rewritten in place.
pub fn strict_object(
    var: &str,
    value: &mut Value,
    required: &[&str],
    props: &[(&str, Kind)],
    min_properties: usize,
) -> Result<(), Failure> {
    let map = object(var, value)?;
    if map.len() < min_properties {
        return Err(format!("{var} must NOT have fewer than {min_properties} items"));
    }
    for name in required {
        if !map.contains_key(*name) {
            return Err(format!("{var} must have required property '{name}'"));
        }
    }
    if map.keys().any(|k| !props.iter().any(|(p, _)| p == k)) {
        return Err(format!("{var} must NOT have additional properties"));
    }
    let map = value.as_object_mut().expect("checked object");
    for (name, kind) in props {
        if let Some(slot) = map.get_mut(*name) {
            // Ajv unwraps a one-item array only where the schema wants a scalar.
            if let (false, Value::Array(items)) = (matches!(kind, Kind::Any), &*slot) {
                if items.len() == 1 {
                    *slot = items[0].clone();
                }
            }
            if let (Kind::Int { .. } | Kind::IntConst(_), Value::String(s)) = (kind, &*slot) {
                // Ajv leaves an empty string alone, so it fails as a non-integer.
                if let Some(f) = crate::js::js_number(s).filter(|_| !s.is_empty()) {
                    // Whole numbers past i64 still fail the range check, as Ajv's number does.
                    if f.is_infinite() || (f.fract() == 0.0 && f.abs() >= 9.2e18) {
                        *slot = Value::from(if f > 0.0 { i64::MAX } else { i64::MIN });
                    } else if f.fract() == 0.0 {
                        *slot = Value::from(f as i64);
                    }
                }
            }
            check(var, name, *kind, slot)?;
        }
    }
    Ok(())
}

pub fn id_params(request: &RouteRequest) -> Result<String, Failure> {
    let mut params = Value::Object(
        request
            .params
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    );
    strict_object("params", &mut params, &["id"], &[("id", Kind::Uuid)], 0)?;
    Ok(request.params["id"].clone())
}

/// An integer JSON number, including a whole-valued float such as `1.0` or `1e0`.
pub fn int_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}
