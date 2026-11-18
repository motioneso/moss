//! Tool-input readers. Each error names the key and the rule it broke, never the value, with
//! the same words the old Meals handlers used. Lengths count UTF-16 units, like the old code.
use serde_json::{Map, Value};

pub type Fields = Map<String, Value>;

#[derive(Debug, PartialEq)]
pub struct InputError {
    pub code: String,
    pub message: String,
}

pub type Checked<T> = std::result::Result<T, InputError>;

pub fn invalid<T>(message: impl Into<String>) -> Checked<T> {
    coded("invalid_input", message)
}

pub fn coded<T>(code: &str, message: impl Into<String>) -> Checked<T> {
    Err(InputError {
        code: code.into(),
        message: message.into(),
    })
}

/// The host adds the caller's id to tool input. It is dropped before any other check.
pub fn strip_envelope(raw: &Value) -> Checked<Fields> {
    let Some(map) = raw.as_object() else {
        return invalid("input must be an object");
    };
    let mut rest = map.clone();
    rest.remove("actorUserId");
    Ok(rest)
}

pub fn no_unknown_keys(input: &Fields, allowed: &[&str]) -> Checked<()> {
    match input.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => invalid(format!("unknown key: {key}")),
        None => Ok(()),
    }
}

fn string(input: &Fields, key: &str, required: bool) -> Checked<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) if required => invalid(format!("{key} is required")),
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => invalid(format!("{key} must be a string")),
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript trims these, including the byte order mark that Rust leaves alone.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub fn text(input: &Fields, key: &str, required: bool, max: usize) -> Checked<Option<String>> {
    let Some(value) = string(input, key, required)? else {
        return Ok(None);
    };
    let trimmed = trim(&value);
    if trimmed.is_empty() || units(trimmed) > max {
        return invalid(format!("{key} must be 1 to {max} characters"));
    }
    Ok(Some(trimmed.to_owned()))
}

/// Like `choice`, but a missing key is an error.
pub fn required_choice(input: &Fields, key: &str, allowed: &[&str]) -> Checked<String> {
    match choice(input, key, allowed)? {
        Some(value) => Ok(value),
        None => invalid(format!("{key} is required")),
    }
}

pub fn choice(input: &Fields, key: &str, allowed: &[&str]) -> Checked<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if allowed.contains(&text.as_str()) => Ok(Some(text.clone())),
        Some(_) => invalid(format!("{key} must be one of: {}", allowed.join(", "))),
    }
}

fn whole(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && n.abs() < 9e15)
            .map(|n| n as i64)
    })
}

/// A whole number in range. `Some(None)` is an explicit null that clears the field.
pub fn nullable_int(input: &Fields, key: &str, min: i64, max: i64) -> Checked<Option<Option<i64>>> {
    match input.get(key) {
        Some(Value::Null) => Ok(Some(None)),
        None => Ok(None),
        Some(value) => {
            let Some(n) = whole(value).filter(|_| value.is_number()) else {
                return invalid(format!("{key} must be an integer"));
            };
            if n < min {
                return invalid(format!("{key} must be at least {min}"));
            }
            if n > max {
                return invalid(format!("{key} must be at most {max}"));
            }
            Ok(Some(Some(n)))
        }
    }
}

pub fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn uuid(input: &Fields, key: &str, required: bool) -> Checked<Option<String>> {
    let value = string(input, key, required)?;
    if value.as_deref().is_some_and(|v| !is_uuid(v)) {
        return invalid(format!("{key} must be a uuid"));
    }
    Ok(value)
}

/// Trimmed entries, duplicates dropped without regard to case, in the order given.
pub fn text_list(
    input: &Fields,
    key: &str,
    (min, max, width): (usize, usize, usize),
    lowercase: bool,
) -> Checked<Option<Vec<String>>> {
    let Some(value) = input.get(key) else {
        return Ok(None);
    };
    let Some(items) = value.as_array() else {
        return invalid(format!("{key} must be an array of strings"));
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut out = vec![];
    for item in items {
        let Some(item) = item.as_str() else {
            return invalid(format!("{key} must be an array of strings"));
        };
        let trimmed = if lowercase {
            trim(item).to_lowercase()
        } else {
            trim(item).to_owned()
        };
        if trimmed.is_empty() || units(&trimmed) > width {
            return invalid(format!("{key} entries must be 1 to {width} characters"));
        }
        if seen.insert(trimmed.to_lowercase()) {
            out.push(trimmed);
        }
    }
    if out.len() < min || out.len() > max {
        return invalid(format!("{key} must hold {min} to {max} entries"));
    }
    Ok(Some(out))
}

/// The old pattern was `^[^\s@]+@[^\s@]+$`.
pub fn is_email(text: &str) -> bool {
    let mut parts = text.split('@');
    let (Some(a), Some(b), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let clean = |p: &str| !p.is_empty() && !p.chars().any(|c| c.is_whitespace() || c == '\u{feff}');
    clean(a) && clean(b)
}

/// The old pattern was `^([01]\d|2[0-3]):[0-5]\d$`.
pub fn is_clock_time(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!(
            (b[0], b[1]),
            (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
        )
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}
