//! Input readers with the old Finance rules. A failure names the key and the limit, never the value.
use serde_json::{Map, Value};

pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
pub const CURRENCIES: [&str; 12] = [
    "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "CNY", "HKD", "SGD", "INR", "MXN",
];
pub const ACCOUNT_TYPES: [&str; 6] = ["checking", "savings", "cash", "credit", "loan", "asset"];

/// A refusal the person can fix. `code` is the stable error name.
#[derive(Debug, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}
pub fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}
pub fn invalid(message: impl Into<String>) -> Refusal {
    refuse("invalid_input", message)
}

/// JavaScript's trim set: Rust whitespace without U+0085, plus the byte order mark.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub fn string(input: &Map<String, Value>, key: &str, required: bool, max_bytes: Option<usize>) -> Result<Option<String>, Refusal> {
    match input.get(key) {
        None | Some(Value::Null) if required => Err(invalid(format!("{key} is required"))),
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => match max_bytes {
            Some(max) if text.len() > max => Err(invalid(format!("{key} exceeds {max} bytes of UTF-8"))),
            _ => Ok(Some(text.clone())),
        },
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}
pub fn required_string(input: &Map<String, Value>, key: &str, max_bytes: Option<usize>) -> Result<String, Refusal> {
    Ok(string(input, key, true, max_bytes)?.unwrap_or_default())
}

/// A number the old JavaScript reader called a safe integer, such as 5 or 5.0.
pub fn int(input: &Map<String, Value>, key: &str) -> Result<i64, Refusal> {
    let not_int = || invalid(format!("{key} must be an integer"));
    match input.get(key) {
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(Value::Number(n)) => {
            let value = match (n.as_i64(), n.as_f64()) {
                (Some(i), _) => i,
                (None, Some(f)) if f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64 => f as i64,
                _ => return Err(not_int()),
            };
            if value.abs() > MAX_SAFE {
                return Err(not_int());
            }
            Ok(value)
        }
        Some(_) => Err(not_int()),
    }
}
pub fn bool_(input: &Map<String, Value>, key: &str) -> Result<bool, Refusal> {
    match input.get(key) {
        None | Some(Value::Null) => Err(invalid(format!("{key} is required"))),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(invalid(format!("{key} must be a boolean"))),
    }
}

/// `manual:<uuid>`, where the id must be a version 4 UUID in lower case.
pub fn operation_id(input: &Map<String, Value>, key: &str) -> Result<String, Refusal> {
    let value = required_string(input, key, None)?;
    let b = value.as_bytes();
    let hex = |range: std::ops::Range<usize>| b[range].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    let ok = b.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
        && hex(0..8)
        && hex(9..13)
        && b[14] == b'4'
        && hex(15..18)
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && hex(20..23)
        && hex(24..36);
    if !ok {
        return Err(invalid(format!("{key} must be a UUID")));
    }
    Ok(format!("manual:{value}"))
}

pub fn is_calendar_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let year: u32 = value[0..4].parse().unwrap_or(0);
    if year == 0 {
        return false;
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (1..=12).contains(&month) && day >= 1 && day <= days[month as usize - 1]
}

/// A calendar date that is not after `today` (both in the person's zone).
pub fn date(input: &Map<String, Value>, key: &str, today: &str) -> Result<String, Refusal> {
    let value = required_string(input, key, None)?;
    if !is_calendar_date(&value) {
        return Err(invalid(format!("{key} must be a valid calendar date")));
    }
    if value.as_str() > today {
        return Err(refuse("future_date", "Posted entries cannot be in the future in your Moss timezone"));
    }
    Ok(value)
}

pub fn currency(input: &Map<String, Value>) -> Result<String, Refusal> {
    let value = required_string(input, "isoCurrency", None)?;
    if !CURRENCIES.contains(&value.as_str()) {
        return Err(refuse("unsupported_currency", "Choose a supported two-decimal currency"));
    }
    Ok(value)
}

/// The type and subtype the old code stored for each manual account type.
pub fn account_kind(kind: &str) -> (&'static str, String) {
    match kind {
        "checking" | "savings" => ("depository", kind.to_owned()),
        "credit" => ("credit", "credit card".to_owned()),
        "loan" => ("loan", "loan".to_owned()),
        _ => ("other", kind.to_owned()),
    }
}
