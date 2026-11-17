//! Text helpers shared by sorting, rules, duplicates and revisions.
use crate::input::is_js_space;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const RULE_PAYEE_MAX_CHARS: usize = 200;

/// Lower case, drop digits and every non-letter non-space, collapse white space.
/// "Trader Joe's #123 " and "TRADER JOES 456" give the same key.
pub fn normalize_payee(name: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if is_js_space(c) {
            gap = true;
        } else if c.is_alphabetic() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}

/// First 32 hex characters of the sha256 of the text. Rule ids and write revisions use it.
pub fn hash32(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// ASCII-only lower case with white space runs collapsed, matching the database's own fold.
pub fn ascii_name(text: &str) -> String {
    let collapsed: Vec<&str> = text.split(|c: char| c.is_ascii_whitespace() || c == '\u{b}').filter(|p| !p.is_empty()).collect();
    collapsed.join(" ").to_ascii_lowercase()
}

/// A stand-in for the old row version. It changes whenever a field a writer may change changes.
pub fn revision(row: &Value, fields: &[&str]) -> String {
    let picked: Vec<&Value> = fields.iter().map(|f| &row[*f]).collect();
    hash32(&serde_json::to_string(&picked).unwrap_or_default())
}

pub fn is_hash32(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_calendar_month(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && &value[..4] != "0000"
        && matches!(&value[5..], "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12")
}

/// The first day of the month and of the next month, as the date text the table stores.
pub fn month_window(month: &str) -> (String, String) {
    let year: u32 = month[..4].parse().unwrap_or(0);
    let index: u32 = month[5..].parse().unwrap_or(0);
    let next = if index == 12 { format!("{:04}-01", year + 1) } else { format!("{year:04}-{:02}", index + 1) };
    (format!("{month}-01"), format!("{next}-01"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payee_keys_ignore_digits_punctuation_and_case() {
        assert_eq!(normalize_payee("Trader Joe's #123 "), "trader joes");
        assert_eq!(normalize_payee("TRADER JOES 456"), "trader joes");
        assert_eq!(normalize_payee("  A \t\n B  "), "a b");
        assert_eq!(normalize_payee("1234 #!"), "");
        assert_eq!(normalize_payee("Caf\u{e9} Z\u{fc}rich"), "caf\u{e9} z\u{fc}rich");
    }

    #[test]
    fn hashes_are_thirty_two_lowercase_hex_characters() {
        let h = hash32("trader joes");
        assert!(is_hash32(&h), "{h}");
        assert_eq!(h, hash32("trader joes"));
        assert_ne!(h, hash32("trader joe"));
    }

    #[test]
    fn names_fold_ascii_only() {
        assert_eq!(ascii_name("  Coffee \t SHOP "), "coffee shop");
        assert_eq!(ascii_name("\u{c9}CLAIR"), "\u{c9}clair");
    }

    #[test]
    fn months_and_windows() {
        assert!(is_calendar_month("2026-12") && !is_calendar_month("2026-13") && !is_calendar_month("0000-01"));
        assert_eq!(month_window("2026-12"), ("2026-12-01".into(), "2027-01-01".into()));
        assert_eq!(month_window("2026-02"), ("2026-02-01".into(), "2026-03-01".into()));
    }
}
