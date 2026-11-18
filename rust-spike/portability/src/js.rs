//! Node and JavaScript behaviours the app relies on without saying so.

use std::borrow::Cow;
use std::cmp::Ordering;

use serde_json::{Map, Value};

/// `Buffer.from(text, "base64")`.
///
/// Node reads only the low byte of each UTF-16 unit, accepts the standard and URL-safe
/// alphabets together, skips every other character and stops at the first `=`.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut held) = (0u32, 0u32);
    for unit in text.encode_utf16() {
        let value = match unit as u8 {
            c @ b'A'..=b'Z' => c - b'A',
            c @ b'a'..=b'z' => c - b'a' + 26,
            c @ b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

/// `Buffer.from(text, "hex")`.
///
/// Node reads the low byte of each UTF-16 unit in pairs and stops at the first pair that is
/// not two hex digits. An odd last unit is dropped.
pub fn hex_decode(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = Vec::with_capacity(units.len() / 2);
    for pair in units.chunks_exact(2) {
        match (hex_digit(pair[0] as u8), hex_digit(pair[1] as u8)) {
            (Some(high), Some(low)) => out.push(high << 4 | low),
            _ => break,
        }
    }
    out
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Membership in the regular-expression class `\s`, which is also what `trim` removes.
///
/// It differs from Rust's `char::is_whitespace`: U+FEFF is in, U+0085 is out.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The default `Array.prototype.sort` order for strings: UTF-16 code units.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `JSON.parse`. Lone surrogates become U+FFFD; the flag says whether that happened.
pub fn parse_json(text: &str) -> Result<(Value, bool), String> {
    let (text, replaced) = replace_lone_surrogate_escapes(text);
    serde_json::from_str(&text).map(|value| (value, replaced)).map_err(|error| error.to_string())
}

/// Rewrites `\uD800`-style escapes that do not form a pair, which `JSON.parse` accepts and
/// serde_json refuses.
fn replace_lone_surrogate_escapes(text: &str) -> (Cow<'_, str>, bool) {
    if !text.contains("\\u") {
        return (Cow::Borrowed(text), false);
    }
    let bytes = text.as_bytes();
    let unit_at = |at: usize| -> Option<u16> {
        let digits = text.get(at..at + 4)?;
        if bytes.get(at - 2..at)? != b"\\u" {
            return None;
        }
        u16::from_str_radix(digits, 16).ok()
    };
    let (mut out, mut copied, mut replaced) = (String::with_capacity(text.len()), 0, false);
    let (mut at, mut in_string) = (0, false);
    while at < bytes.len() {
        match (in_string, bytes[at]) {
            (false, b'"') | (true, b'"') => {
                in_string = !in_string;
                at += 1;
            }
            (true, b'\\') if bytes.get(at + 1) == Some(&b'u') => {
                let Some(unit) = unit_at(at + 2) else {
                    at += 2;
                    continue;
                };
                let paired = (0xd800..0xdc00).contains(&unit)
                    && unit_at(at + 8).is_some_and(|low| (0xdc00..0xe000).contains(&low));
                if paired {
                    at += 12;
                } else if (0xd800..0xe000).contains(&unit) {
                    out.push_str(&text[copied..at]);
                    out.push_str("\\ufffd");
                    at += 6;
                    copied = at;
                    replaced = true;
                } else {
                    at += 6;
                }
            }
            (true, b'\\') => at += 2,
            _ => at += 1,
        }
    }
    out.push_str(&text[copied..]);
    (Cow::Owned(out), replaced)
}

/// `Object.entries` order: array-index keys ascending, then the rest in insertion order.
pub fn entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for entry in object {
        match array_index(entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, entry)| entry).chain(named).collect()
}

fn array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

/// `String(value)`, where `None` is `undefined`. Matches JavaScript for integers up to 2^53
/// and ordinary decimals, which covers every value the envelope checks print.
pub fn to_js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(integer) if integer.unsigned_abs() <= 1 << 53 => integer.to_string(),
            _ => {
                let float = number.as_f64().unwrap_or(f64::NAN);
                if float == 0.0 {
                    // Covers -0, which JavaScript prints as "0".
                    "0".to_string()
                } else if float.fract() == 0.0 && float.abs() < 1e21 {
                    format!("{float:.0}")
                } else {
                    float.to_string()
                }
            }
        },
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogate_escapes_become_replacement_characters() {
        let (value, replaced) = parse_json(r#"{"a":"x\ud800y","b":"😀","c":"\\ud800"}"#)
            .unwrap();
        assert!(replaced);
        assert_eq!(value["a"], "x\u{fffd}y");
        assert_eq!(value["b"], "\u{1f600}");
        assert_eq!(value["c"], "\\ud800");
        assert!(!parse_json(r#"{"b":"😀"}"#).unwrap().1);
    }

    #[test]
    fn object_entries_put_array_indexes_first() {
        let (value, _) = parse_json(r#"{"k1":1,"7":2,"07":3,"4294967295":4,"0":5}"#).unwrap();
        let keys: Vec<&str> =
            entries(value.as_object().unwrap()).iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, ["0", "7", "k1", "07", "4294967295"]);
    }

    #[test]
    fn javascript_string_conversion() {
        let (value, _) = parse_json(r#"[2, 1.5, -0, null, true, "x", [1, null, "y"], {}]"#).unwrap();
        let printed: Vec<String> =
            value.as_array().unwrap().iter().map(|item| to_js_string(Some(item))).collect();
        assert_eq!(printed, ["2", "1.5", "0", "null", "true", "x", "1,,y", "[object Object]"]);
        assert_eq!(to_js_string(None), "undefined");
    }
}
