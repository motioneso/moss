//! Masks secret-shaped text before an agent's error output is kept in a log.

/// Replaces long token-like words, `key=value` secrets and the word after "Bearer" with a marker.
pub fn redact_line(line: &str) -> String {
    let mut after_bearer = false;
    line.split_whitespace()
        .map(|w| {
            let core = w.trim_matches(|c: char| "\"'`,;()[]{}<>".contains(c));
            let lower = core.to_lowercase();
            let keyed = ["token", "secret", "password", "apikey", "api_key", "authorization", "bearer"]
                .iter()
                .any(|k| lower.contains(k) && (core.contains('=') || core.contains(':')));
            let tokenish = core.len() >= 20
                && core.chars().all(|c| c.is_ascii_alphanumeric() || "-_.=+/".contains(c))
                && core.chars().any(|c| c.is_ascii_digit() || c == '-' || c == '_')
                && core.chars().any(|c| c.is_ascii_alphabetic());
            let hide = keyed || tokenish || after_bearer;
            after_bearer = lower == "bearer";
            if hide {
                "[hidden]".to_string()
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::redact_line;

    #[test]
    fn hides_tokens_and_keyed_secrets() {
        let out = redact_line("auth failed token=abc sk-ant-oat01-AbCdEf0123456789xyzXYZ ok");
        assert_eq!(out, "auth failed [hidden] [hidden] ok");
    }

    #[test]
    fn hides_quoted_comma_ended_and_bearer_tokens() {
        let out = redact_line(r#"{"key": "sk-ant-oat01-AbCdEf0123456789xyz", next} Bearer abcdefgh"#);
        assert_eq!(out, r#"{"key": [hidden] next} Bearer [hidden]"#);
    }

    #[test]
    fn keeps_plain_words_and_paths() {
        assert_eq!(redact_line("cannot read /srv/notes.md"), "cannot read /srv/notes.md");
    }
}
