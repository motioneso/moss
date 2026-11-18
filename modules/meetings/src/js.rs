//! JavaScript string and number behaviours the TypeScript app relied on.
use serde_json::Value;
use std::cmp::Ordering;

pub const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `String.prototype.length`, which counts UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The order of JavaScript's `<` on strings (UTF-16 code units).
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `Number.isSafeInteger` on a JSON value. Whole-valued floats such as `1.0` count.
pub fn safe_int(value: &Value) -> Option<i64> {
    let n = match value.as_i64() {
        Some(n) => n,
        None => {
            let f = value.as_f64()?;
            if f.fract() != 0.0 || f.abs() > MAX_SAFE as f64 {
                return None;
            }
            f as i64
        }
    };
    (n.abs() <= MAX_SAFE).then_some(n)
}

/// Replaces a lone UTF-16 surrogate escape with U+FFFD so the text parses as Rust JSON. One
/// unit becomes one unit, so JavaScript lengths and offsets are unchanged.
pub fn lossy_surrogates(json: &str) -> String {
    let b = json.as_bytes();
    let hex = |at: usize| -> Option<u32> {
        let s = json.get(at..at + 4)?;
        u32::from_str_radix(s, 16).ok().filter(|_| s.bytes().all(|c| c.is_ascii_hexdigit()))
    };
    let mut out = String::with_capacity(json.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            let end = json[i..].find('\\').map_or(b.len(), |n| i + n);
            out.push_str(&json[i..end]);
            i = end;
            continue;
        }
        if b.get(i + 1) == Some(&b'u') {
            if let Some(unit) = hex(i + 2) {
                if (0xd800..0xdc00).contains(&unit)
                    && b.get(i + 6) == Some(&b'\\')
                    && b.get(i + 7) == Some(&b'u')
                    && hex(i + 8).is_some_and(|low| (0xdc00..0xe000).contains(&low))
                {
                    out.push_str(&json[i..i + 12]);
                    i += 12;
                    continue;
                }
                if (0xd800..0xe000).contains(&unit) {
                    out.push_str("\\ufffd");
                    i += 6;
                    continue;
                }
                out.push_str(&json[i..i + 6]);
                i += 6;
                continue;
            }
        }
        let end = (i + 2).min(b.len());
        out.push_str(json.get(i..end).unwrap_or("\\"));
        i = end;
    }
    out
}

/// What JavaScript `Number(text)` gives for the text forms a query string can carry.
pub fn js_number(text: &str) -> Option<f64> {
    let t = crate::text::js_trim(text);
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return (!digits.is_empty())
                .then(|| u128::from_str_radix(digits, radix).ok().map(|n| n as f64))
                .flatten();
        }
    }
    let (sign, rest) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if rest == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if !digits(whole) || !digits(fraction) || (whole.is_empty() && fraction.is_empty()) {
        return None;
    }
    if let Some(e) = exponent {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        if e.is_empty() || !digits(e) {
            return None;
        }
    }
    rest.parse::<f64>().ok().map(|n| sign * n)
}
