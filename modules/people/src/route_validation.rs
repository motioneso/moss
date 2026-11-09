//! The body schemas from the legacy Fastify People routes, including Ajv coercion.
//! Unknown members remain available to the handlers (Type.Object permits them).
use moss_module_sdk::{Response, RouteRequest};
use serde_json::{json, Value};

#[derive(Clone)]
enum Kind {
    String,
    Strings,
    Array(Box<Kind>, usize),
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
        ("POST", "/people/index/refresh") => vec![Field(
            "sourceRefs",
            true,
            Kind::Array(
                Box::new(Object(vec![
                    Field("source", true, Text),
                    Field("sourceRefHash", true, Text),
                    Field("sourceVersion", false, Text),
                    Field("reason", true, Text),
                ])),
                50,
            ),
        )],
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
        Strings | Kind::Array(_, _) => {
            if !value.is_array()
                && (value.is_string() || value.is_number() || value.is_boolean() || value.is_null())
            {
                *value = json!([value.clone()]);
            }
            let Some(items) = value.as_array_mut() else {
                return fail(errors, "must be array".into());
            };
            if let Kind::Array(_, max) = kind {
                if items.len() > *max {
                    return fail(errors, format!("must NOT have more than {max} items"));
                }
            }
            let item_kind = match kind {
                Kind::Array(item, _) => item.as_ref(),
                _ => &Text,
            };
            for (index, item) in items.iter_mut().enumerate() {
                if !check(item_kind, item, &format!("{path}/{index}"), errors) {
                    return false;
                }
            }
            true
        }
    }
}

// JS first rounds JSON numbers to binary64. Both languages choose a shortest
// round-tripping decimal, but Display breaks equal-distance ties upwards while
// JS chooses an even last digit. Format with explicit precision to get that
// tie rule, retaining the shortest digit count and JS's notation thresholds.
pub(crate) fn number_text(number: &serde_json::Number) -> std::string::String {
    let n = number.as_f64().unwrap_or(0.0);
    if n == 0.0 {
        return "0".into();
    }
    let shortest = n.abs().to_string();
    let significant: std::string::String = shortest
        .chars()
        .filter(char::is_ascii_digit)
        .skip_while(|c| *c == '0')
        .collect();
    let precision = significant.trim_end_matches('0').len() - 1;
    let mut rounded = format!("{:.*e}", precision, n.abs());
    // At powers of two the binary64 rounding interval is asymmetric. The
    // equally near even decimal can fall outside it; retain Display's valid
    // shortest candidate instead of changing the represented number.
    if rounded.parse::<f64>().ok() != Some(n.abs()) {
        rounded = format!("{:e}", n.abs());
    }
    // Finite nonzero f64 formatting always produces a mantissa and exponent.
    let (mantissa, exponent) = rounded.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    let digits = mantissa.replace('.', "");
    let sign = if n < 0.0 { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        format!(
            "{sign}{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    } else if exponent < 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-exponent - 1) as usize))
    } else {
        let point = exponent as usize + 1;
        if point >= digits.len() {
            format!("{sign}{digits}{}", "0".repeat(point - digits.len()))
        } else {
            format!("{sign}{}.{}", &digits[..point], &digits[point..])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::number_text;
    use serde_json::Number;

    #[test]
    fn numeric_contact_values_keep_javascript_notation_boundaries() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.25, "1.25"),
            (-1.25, "-1.25"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-1e-7, "-1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.0000000000000001e18, "1000000000000000100"),
            (2.0f64.powi(-24), "5.960464477539063e-8"),
            (-2.0f64.powi(-24), "-5.960464477539063e-8"),
            (f64::from_bits(1), "5e-324"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (f64::MAX, "1.7976931348623157e+308"),
        ] {
            assert_eq!(number_text(&Number::from_f64(value).unwrap()), expected);
        }
    }

    #[test]
    fn every_finite_power_of_two_keeps_its_numeric_value() {
        for exponent in -1074..=1023 {
            let bits = if exponent < -1022 {
                1u64 << (exponent + 1074)
            } else {
                ((exponent + 1023) as u64) << 52
            };
            for value in [f64::from_bits(bits), -f64::from_bits(bits)] {
                let text = number_text(&Number::from_f64(value).unwrap());
                assert_eq!(text.parse::<f64>().unwrap(), value, "{exponent}: {text}");
            }
        }
    }

    #[test]
    fn numeric_contact_values_use_javascript_even_decimal_ties() {
        // JavaScript String(Number) for these exact binary64 values. Rust's
        // shortest Display instead chooses the upper decimal at an equal tie.
        for (bits, expected) in [
            (0x430289fb4b135262, "652282746268236.2"),
            (0x430289fb4b135266, "652282746268236.8"),
            (0xc2ebf11414163f94, "-245777903432188.62"),
            (0x42e69640c0ebc804, "198676698324544.12"),
            (0x4304fa2c4355d902, "738070943677216.2"),
            (0x4311bacfa086eefd, "1247618879568831.2"),
            (0xc315dd1777ca3159, "-1538516843662422.2"),
        ] {
            assert_eq!(
                number_text(&Number::from_f64(f64::from_bits(bits)).unwrap()),
                expected
            );
        }
    }
}
