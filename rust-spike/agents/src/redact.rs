//! Masks secret-shaped text before an agent's error output is shown or kept.

/// Replaces long token-like words and `key=value` secrets with a marker.
pub fn redact_line(line: &str) -> String {
    line.split(' ')
        .map(|w| {
            let lower = w.to_lowercase();
            let keyed = ["token", "secret", "password", "apikey", "api_key", "authorization", "bearer"]
                .iter()
                .any(|k| lower.contains(k) && (w.contains('=') || w.contains(':')));
            let tokenish = w.len() >= 24
                && w.chars().all(|c| c.is_ascii_alphanumeric() || "-_.=+/".contains(c))
                && w.chars().any(|c| c.is_ascii_digit())
                && w.chars().any(|c| c.is_ascii_alphabetic());
            if keyed || tokenish {
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
    fn keeps_plain_words_and_paths() {
        assert_eq!(redact_line("cannot read /srv/notes.md"), "cannot read /srv/notes.md");
    }
}
