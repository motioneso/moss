//! What a log line may carry. The names that mark a secret are the TypeScript log sanitizer's
//! (`packages/shared/src/log-sanitizer.ts`): a field or header whose name contains one, with
//! spaces, dots, dashes, underscores and quotes ignored, has its value replaced.

use serde_json::Value;

pub const REDACTED: &str = "[redacted]";

const SECRET_MARKERS: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "apikey",
    "privatekey",
    "accesskey",
    "signingkey",
    "encryptionkey",
    "authkey",
    "authorization",
    "cookie",
    "credential",
    "sessionid",
    "bearer",
];

/// Ordinary words that start with a marker ("secretary").
const BENIGN_AFTER_SECRET: &[&str] = &["ary", "ariat", "ive", "ively", "ion", "ions"];

/// Markers whose value runs to the end of the line, as in an HTTP header.
const LINE_VALUED: &[&str] = &["authorization", "cookie"];

fn ignored(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '.' | '_' | '-' | '\\' | '"' | '\'' | '`')
}

/// The first marker inside `flat` (already folded), honouring the benign words.
fn find_marker(flat: &str) -> Option<(usize, &'static str)> {
    let mut best: Option<(usize, &'static str)> = None;
    for marker in SECRET_MARKERS {
        for (at, _) in flat.match_indices(marker) {
            let rest = &flat[at + marker.len()..];
            if *marker == "secret"
                && BENIGN_AFTER_SECRET
                    .iter()
                    .any(|word| rest.starts_with(word))
            {
                continue;
            }
            if best.map_or(true, |(seen, _)| at < seen) {
                best = Some((at, marker));
            }
            break;
        }
    }
    best
}

/// Whether a field or header name names a secret ("api_key", "X-Auth-Token", "Set-Cookie").
pub fn is_secret_name(name: &str) -> bool {
    let flat: String = name
        .chars()
        .filter(|ch| !ignored(*ch))
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    find_marker(&flat).is_some()
}

/// A copy of `value` with the value of every secret-named field replaced, at any depth, and
/// every string passed through [`redact_text`].
pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let item = if is_secret_name(key) {
                        Value::String(REDACTED.into())
                    } else {
                        redact_json(item)
                    };
                    (key.clone(), item)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        Value::String(text) => Value::String(redact_text(text)),
        other => other.clone(),
    }
}

/// Free text with credentials masked: passwords in URLs (`scheme://user:pass@host`), values
/// after a secret name and `:` or `=`, the word after `Bearer`, and whole header values.
pub fn redact_text(text: &str) -> String {
    let text = mask_url_credentials(text);
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some((marker_end, marker)) = next_marker(rest) {
        out.push_str(&rest[..marker_end]);
        rest = &rest[marker_end..];
        // The rest of a longer name: "password_hash", "tokens".
        let name_tail = rest
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
            .unwrap_or(rest.len());
        out.push_str(&rest[..name_tail]);
        rest = &rest[name_tail..];
        let separator = separator_len(rest);
        let value_start = match separator {
            Some(len) => len,
            None if marker == "bearer" => rest.len() - rest.trim_start().len(),
            None => continue,
        };
        if value_start == 0 && marker == "bearer" {
            continue;
        }
        out.push_str(&rest[..value_start]);
        rest = &rest[value_start..];
        let value_len = if LINE_VALUED.contains(&marker) {
            rest.find(['\r', '\n']).unwrap_or(rest.len())
        } else {
            rest.find(|ch: char| {
                ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '&' | ',' | ';' | '}' | ']')
            })
            .unwrap_or(rest.len())
        };
        if value_len > 0 {
            out.push_str(REDACTED);
        }
        rest = &rest[value_len..];
    }
    out.push_str(rest);
    out
}

/// The byte offset just past the first marker in `text`, matching across ignored characters.
fn next_marker(text: &str) -> Option<(usize, &'static str)> {
    let mut flat = String::with_capacity(text.len());
    let mut ends = Vec::with_capacity(text.len());
    for (index, ch) in text.char_indices() {
        if ignored(ch) {
            continue;
        }
        flat.push(ch.to_ascii_lowercase());
        for _ in 0..ch.to_ascii_lowercase().len_utf8() {
            ends.push(index + ch.len_utf8());
        }
    }
    let (at, marker) = find_marker(&flat)?;
    Some((ends[at + marker.len() - 1], marker))
}

/// Quotes, spaces, then `:` or `=`, then spaces and quotes. Returns the length.
fn separator_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    let skip = |index: &mut usize, set: &[u8]| {
        while *index < bytes.len() && set.contains(&bytes[*index]) {
            *index += 1;
        }
    };
    skip(&mut index, b"\"'`\\ \t");
    if index < bytes.len() && (bytes[index] == b':' || bytes[index] == b'=') {
        index += 1;
        skip(&mut index, b"\"'`\\ \t");
        Some(index)
    } else {
        None
    }
}

fn mask_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let authority_start = scheme_end + 3;
        out.push_str(&rest[..authority_start]);
        rest = &rest[authority_start..];
        let authority_len = rest
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '"' | '\''))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_len];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(REDACTED);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &rest[authority_len..];
    }
    out.push_str(rest);
    out
}

/// A query string with the value of every secret-named parameter replaced.
pub fn redact_query(query: &str) -> String {
    query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, _)) if is_secret_name(name) => format!("{name}={REDACTED}"),
            Some((name, value)) => format!("{name}={}", redact_text(value)),
            None => pair.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SENTINEL: &str = "MOSS-SENTINEL-redact-7f3a";

    #[test]
    fn names_secret_fields_like_the_typescript_sanitizer() {
        for name in [
            "password",
            "api_key",
            "X-Auth-Token",
            "Set-Cookie",
            "clientSecret",
            "PASS WORD",
        ] {
            assert!(is_secret_name(name), "{name}");
        }
        for name in ["secretary", "email", "name", "status", "session"] {
            assert!(!is_secret_name(name), "{name}");
        }
    }

    #[test]
    fn json_values_under_secret_names_never_survive() {
        let body = json!({
            "email": "a@example.test",
            "password": SENTINEL,
            "nested": [{"apiKey": SENTINEL, "label": "kept"}],
            "note": format!("token={SENTINEL}"),
        });
        let redacted = redact_json(&body).to_string();
        assert!(!redacted.contains(SENTINEL), "{redacted}");
        assert!(redacted.contains("a@example.test") && redacted.contains("kept"));
    }

    #[test]
    fn free_text_credentials_never_survive() {
        let lines = [
            format!("connect postgres://moss:{SENTINEL}@db.internal/app failed"),
            format!("Authorization: Bearer {SENTINEL}"),
            format!("cookie: better-auth.session_token={SENTINEL}; Path=/"),
            format!("{{\"password\": \"{SENTINEL}\"}}"),
            format!("retry with api_key={SENTINEL}&page=2"),
            format!("password_hash={SENTINEL}"),
            format!("sent bearer {SENTINEL} upstream"),
        ];
        for line in lines {
            let redacted = redact_text(&line);
            assert!(!redacted.contains(SENTINEL), "{line} -> {redacted}");
        }
        assert_eq!(
            redact_text("the token was missing"),
            "the token was missing"
        );
        assert_eq!(
            redact_query(&format!("a=1&token={SENTINEL}")),
            "a=1&token=[redacted]"
        );
    }
}
