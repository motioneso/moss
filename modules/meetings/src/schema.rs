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
    Int { min: i64, max: i64 },
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
        Kind::Text { min, max } => {
            let s = value.as_str().ok_or_else(|| format!("{at} must be string"))?;
            let n = code_points(s);
            if n > max {
                return Err(format!("{at} must NOT have more than {max} characters"));
            }
            if n < min {
                return Err(format!("{at} must NOT have fewer than {min} characters"));
            }
            Ok(())
        }
        Kind::Int { min, max } => {
            let n = value
                .as_i64()
                .or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
                .ok_or_else(|| format!("{at} must be integer"))?;
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
            if let (Kind::Int { .. }, Value::String(s)) = (kind, &*slot) {
                if let Ok(n) = s.parse::<i64>() {
                    *slot = Value::from(n);
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
