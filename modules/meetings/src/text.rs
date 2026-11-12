//! Text rules shared with the TypeScript app (JavaScript trim, byte limits, UUID shape).

/// JavaScript `String.prototype.trim` whitespace, which differs from Rust's `trim` at U+0085 and U+FEFF.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

/// Meeting text rule: no NUL, at most `max_bytes` UTF-8 bytes, and non-blank when required.
pub fn bounded(value: &str, max_bytes: usize, required: bool) -> bool {
    !value.contains('\0')
        && value.len() <= max_bytes
        && !(required && js_trim(value).is_empty())
}

pub fn is_uuid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Ajv counts string length in Unicode code points.
pub fn code_points(value: &str) -> usize {
    value.chars().count()
}

/// `Date.prototype.toISOString` form: `YYYY-MM-DDTHH:MM:SS.mmmZ`, four-digit year.
pub fn is_iso_millis(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            23 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
        && calendar_valid(value)
}

fn calendar_valid(value: &str) -> bool {
    let n = |a: usize, b: usize| value[a..b].parse::<u32>().unwrap_or(99);
    let (year, month, day) = (n(0, 4), n(5, 7), n(8, 10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day >= 1 && day <= days && n(11, 13) < 24 && n(14, 16) < 60 && n(17, 19) < 60
}

/// Recording type ids: `^[a-z][a-z0-9-]{0,63}$`.
pub fn is_type_id(value: &str) -> bool {
    let b = value.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}
