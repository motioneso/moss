//! Secret masking for screen text, applied before anything is stored.
//!
//! The patterns match the legacy `redactSecrets` (without its fail-closed mode). The `regex`
//! crate runs in linear time, and the URL password mask is a single hand-written pass.
use regex::Regex;
use std::sync::LazyLock;

const MASK: &str = "[redacted]";
const HEADER: &str = r"(?:Authorization|Set-Cookie|Cookie)";

/// Quoted header values, one pattern per quote character because the engine has no backreference.
static QUOTED_HEADER: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    ["\"", "'"].map(|q| {
        Regex::new(&format!(r#"(?i)((?-u:\b){HEADER}["']?\s*[:=]\s*{q})(?:\\.|[^\\\r\n{q}])*"#)).expect("pattern")
    })
});
static BARE_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"(?i)((?-u:\b){HEADER}["']?\s*[:=]\s*)[^\r\n"'][^\r\n]*"#)).expect("pattern")
});

const NAMES: &str = r"(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)";

/// Patterns whose whole match is replaced.
static WHOLE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)JARVIS_MCP_TOKEN=\S+".to_owned(),
        r"(?i)Bearer\s+\S+".to_owned(),
        r"jst_[A-Za-z0-9_-]+".to_owned(),
        r"(?i)(?-u:\b)sk-(?:(?:ant|proj|live|test)[-_])?[A-Za-z0-9][A-Za-z0-9_-]+(?-u:\b)".to_owned(),
        r"(?i)(?-u:\b)(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}(?-u:\b)".to_owned(),
        r"(?i)(?-u:\b)(?:ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}(?-u:\b)".to_owned(),
    ]
    .iter()
    .map(|p| Regex::new(p).expect("pattern"))
    .collect()
});
static QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)([?&]{NAMES}=)[^&#\s]+")).expect("pattern"));
static ENV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH(?:ORIZATION)?|CLIENT[_-]?SECRET|PASSWORD|SECRET|TOKEN|KEY)=[^&\s}]+")
        .expect("pattern")
});
/// A JSON-ish field. One pattern per quote style so the closing quote can match the opening one.
static FIELD: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    ["\"", "'", ""].map(|q| {
        Regex::new(&format!(r#"(?i)(["']?{NAMES}["']?\s*:\s*){q}[^"'\s,}}]+{q}"#)).expect("pattern")
    })
});

/// Masks the password in `scheme://user:password@host`, keeping scheme, user and host.
/// The password runs to the last `@` of the authority, so a password that holds `@` is covered.
fn mask_url_credentials(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut from) = (0usize, 0usize);
    while let Some(found) = text[from..].find("://") {
        let marker = from + found;
        from = marker + 3;
        let mut start = marker;
        while start > 0 && marker - start < 32 && matches!(bytes[start - 1], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'.' | b'-') {
            start -= 1;
        }
        while start < marker && !bytes[start].is_ascii_alphabetic() {
            start += 1;
        }
        if start == marker {
            continue;
        }
        let mut end = from;
        while end < text.len() && !is_authority_end(text, end) {
            end += text[end..].chars().next().map_or(1, char::len_utf8);
        }
        let authority = &text[from..end];
        if let (Some(at), Some(colon)) = (authority.find('@'), authority.find(':')) {
            if colon < at {
                let last = authority.rfind('@').unwrap_or(at);
                out.push_str(&text[copied..from + colon + 1]);
                out.push_str(MASK);
                copied = from + last;
            }
        }
        from = end;
    }
    out.push_str(&text[copied..]);
    out
}

fn is_authority_end(text: &str, index: usize) -> bool {
    text[index..].chars().next().is_some_and(|c| matches!(c, '/' | '?' | '#') || c.is_whitespace())
}

/// Replaces secret-bearing text with a fixed marker. Empty input gives empty output.
pub fn redact(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut out = text.to_owned();
    for pattern in QUOTED_HEADER.iter() {
        out = pattern.replace_all(&out, format!("${{1}}{MASK}")).into_owned();
    }
    out = BARE_HEADER.replace_all(&out, format!("${{1}}{MASK}")).into_owned();
    out = mask_url_credentials(&out);
    for pattern in &WHOLE[..6] {
        out = pattern.replace_all(&out, MASK).into_owned();
    }
    out = QUERY.replace_all(&out, format!("${{1}}{MASK}")).into_owned();
    out = ENV.replace_all(&out, MASK).into_owned();
    for (index, pattern) in FIELD.iter().enumerate() {
        let q = ["\"", "'", ""][index];
        out = pattern.replace_all(&out, format!("${{1}}{q}{MASK}{q}")).into_owned();
    }
    out
}
