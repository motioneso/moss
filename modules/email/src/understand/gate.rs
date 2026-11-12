//! The first-pass gate. A "maybe owed" answer stays "maybe owed" unless a bulk
//! advert from an unknown sender was called noise, and security or sign-in wording
//! always keeps the closer look.
use super::text::has_any_word;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Nothing,
    WorthKnowing,
    MaybeOwed,
}

impl Gate {
    pub fn parse(value: &str) -> Option<Gate> {
        match value {
            "nothing" => Some(Gate::Nothing),
            "worth_knowing" => Some(Gate::WorthKnowing),
            "maybe_owed" => Some(Gate::MaybeOwed),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Gate::Nothing => "nothing",
            Gate::WorthKnowing => "worth_knowing",
            Gate::MaybeOwed => "maybe_owed",
        }
    }
}

const OBLIGATIONS: [&str; 4] = ["needs_reply", "needs_action", "time_sensitive_info", "waiting_on_someone"];
const MIN_BODY_CHARS: usize = 40;

/// Decodes apostrophe entities, folds curly apostrophes and strips common accents.
pub fn normalize_for_veto(text: &str) -> String {
    let mut out = text.to_string();
    for entity in ["&#8217;", "&#8216;", "&rsquo;", "&lsquo;", "&#39;", "&#x27;", "&apos;"] {
        out = replace_ignore_case(&out, entity, "'");
    }
    out.chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{02bc}' | '`' => '\'',
            other => fold_accent(other),
        })
        .collect()
}

fn replace_ignore_case(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
        return text.replace(needle, with);
    }
    let mut out = String::new();
    let mut at = 0;
    while let Some(found) = lower[at..].find(needle) {
        out.push_str(&text[at..at + found]);
        out.push_str(with);
        at += found + needle.len();
    }
    out.push_str(&text[at..]);
    out
}

fn fold_accent(c: char) -> char {
    match c {
        'à'..='å' => 'a', 'À'..='Å' => 'A', 'ç' => 'c', 'Ç' => 'C',
        'è'..='ë' => 'e', 'È'..='Ë' => 'E', 'ì'..='ï' => 'i', 'Ì'..='Ï' => 'I',
        'ñ' => 'n', 'Ñ' => 'N', 'ò'..='ö' => 'o', 'Ò'..='Ö' => 'O',
        'ù'..='ü' => 'u', 'Ù'..='Ü' => 'U', 'ý' | 'ÿ' => 'y', 'Ý' => 'Y',
        other => other,
    }
}

/// `first`, then any run of whitespace, hyphens or underscores, then `second`.
fn joined(text: &str, first: &str, second: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text[from..].find(first) {
        let after = from + found + first.len();
        let rest = text[after..].trim_start_matches(|c: char| c.is_whitespace() || c == '-' || c == '_');
        if rest.starts_with(second) {
            return true;
        }
        from += found + first.len().max(1);
    }
    false
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

fn looks_like_security_alert(subject: &str, body: &str) -> bool {
    let text = normalize_for_veto(&format!("{subject}\n{body}")).to_lowercase();
    text.contains("secur")
        || joined(&text, "sign", "in")
        || joined(&text, "signed", "in")
        || joined(&text, "log", "in")
        || joined(&text, "logged", "in")
        || contains_any(&text, &["password", "passcode", "verif"])
        || joined(&text, "two", "step")
        || joined(&text, "two", "factor")
        || joined(&text, "2", "step")
        || has_any_word(&text, &["2fa", "mfa", "pin"])
        || contains_any(
            &text,
            &[
                "device", "recover", "account", "suspicious", "unusual", "unrecognize",
                "unrecognise", "fraud", "unauthorized", "unauthorised", "was this you",
                "wasn't you", "was not you", "didn't sign in", "did not sign in", "passkey",
                "forward", "authenticat", "someone", "locked", "suspend", "compromis",
                "breach", "access", "email address", "phone number", "connexion", "anmeld",
                "sicherheit", "seguridad", "sesion",
            ],
        )
}

/// What a "maybe owed" first-pass answer is allowed to become.
pub fn resolve_maybe_owed(
    category: Option<&str>,
    bulk: bool,
    known_sender: bool,
    subject: &str,
    body: &str,
) -> Gate {
    if category.is_some_and(|c| OBLIGATIONS.contains(&c)) {
        return Gate::MaybeOwed;
    }
    if looks_like_security_alert(subject, body) || body.trim().chars().count() < MIN_BODY_CHARS {
        return Gate::MaybeOwed;
    }
    if bulk && !known_sender && category == Some("noise") {
        return Gate::Nothing;
    }
    Gate::MaybeOwed
}

/// Applies the gate to a sanitized result. `nothing` keeps no summary and a bare noise
/// verdict, `worth_knowing` keeps the summary under an fyi verdict, and `maybe_owed`
/// flags the message for the thread judgement.
pub fn apply(
    result: super::extract::Extract,
    known_sender: bool,
    subject: &str,
    body: &str,
) -> super::extract::Extract {
    use serde_json::json;
    let Some(gate) = result.gate else {
        return result;
    };
    let resolved = if gate == Gate::MaybeOwed {
        resolve_maybe_owed(
            result.category(),
            result.signals.get("bulk") == Some(&json!(true)),
            known_sender,
            subject,
            body,
        )
    } else {
        gate
    };
    let mut signals = result.signals.clone();
    match resolved {
        Gate::Nothing => {
            signals.remove("pendingJudgement");
            signals.insert("actionability".into(), json!({"category":"noise"}));
            super::extract::Extract { summary: None, gate: Some(resolved), signals }
        }
        Gate::WorthKnowing => {
            signals.insert("actionability".into(), json!({"category":"fyi"}));
            super::extract::Extract { summary: result.summary, gate: Some(resolved), signals }
        }
        Gate::MaybeOwed => {
            let category = result.category().map(String::from);
            signals.remove("actionability");
            if let Some(c) = category.filter(|c| c == "needs_reply" || c == "needs_action") {
                signals.insert("actionability".into(), json!({"category":c}));
            }
            signals.insert("pendingJudgement".into(), json!(true));
            super::extract::Extract { summary: None, gate: Some(resolved), signals }
        }
    }
}
