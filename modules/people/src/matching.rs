use crate::js_space;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn normalize_identity(kind: &str, raw: &str) -> String {
    let trimmed = raw.trim_matches(js_space);
    if matches!(kind, "email_address" | "source_identity") {
        trimmed.to_lowercase()
    } else {
        trimmed.into()
    }
}

/// ECMAScript sorts strings by UTF-16 code units, including non-BMP note paths.
pub fn candidate_signature(kind: &str, ids: &[String]) -> String {
    let mut ids = ids.to_vec();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let input = format!("{kind}:{}", ids.join("|"));
    format!("{:x}", Sha256::digest(input.as_bytes()))[..32].into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchEntry {
    pub normalized_value: String,
    pub display_value: String,
    pub identity_kind: String,
    pub signals: Vec<Value>,
    pub confidence: f64,
}

/// Keep first-seen order and display spelling, just like the TypeScript Map.
pub fn match_result(signals: &[Value]) -> Result<Vec<(String, MatchEntry)>, String> {
    let mut entries: Vec<(String, MatchEntry)> = Vec::new();
    for signal in signals {
        let field = |name: &str| {
            signal[name]
                .as_str()
                .ok_or_else(|| format!("Missing signal {name}"))
        };
        let identity_kind = field("identityKind")?;
        let normalized_value = field("normalizedValue")?;
        let confidence = signal["confidence"].as_f64().ok_or("Missing confidence")?;
        let key = format!("{identity_kind}:{normalized_value}");
        if let Some((_, entry)) = entries.iter_mut().find(|(k, _)| k == &key) {
            entry.signals.push(signal.clone());
            entry.confidence = (entry.confidence + confidence * 0.1).min(1.0);
        } else {
            entries.push((
                key,
                MatchEntry {
                    normalized_value: normalized_value.into(),
                    display_value: field("displayValue")?.into(),
                    identity_kind: identity_kind.into(),
                    signals: vec![signal.clone()],
                    confidence,
                },
            ));
        }
    }
    Ok(entries)
}
