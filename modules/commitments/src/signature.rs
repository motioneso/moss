//! The stable identity of a candidate, so a second sighting folds into the first.
use sha2::{Digest, Sha256};

pub struct SignatureInput<'a> {
    pub kind: &'a str,
    pub counterparty_label: Option<&'a str>,
    pub title: &'a str,
    pub due_local_date: Option<&'a str>,
    pub source_kind: &'a str,
    pub source_ref: &'a str,
}

/// Lower-cased, trimmed, with runs of whitespace folded to one space.
fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The first eight hex digits of the SHA-256 of the text.
pub fn sha8(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

pub fn candidate_signature(input: &SignatureInput) -> String {
    [
        input.kind.to_owned(),
        normalize(input.counterparty_label.unwrap_or("")),
        normalize(input.title),
        input.due_local_date.unwrap_or("").to_owned(),
        input.source_kind.to_owned(),
        sha8(input.source_ref),
    ]
    .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha8_matches_the_old_hash() {
        // sha256("abc") starts ba7816bf.
        assert_eq!(sha8("abc"), "ba7816bf");
    }

    #[test]
    fn signature_folds_case_and_spacing() {
        let one = SignatureInput { kind: "promise", counterparty_label: Some("  Sam  Lee "), title: "Send  The Report",
            due_local_date: Some("2026-11-20"), source_kind: "notes", source_ref: "n1" };
        let two = SignatureInput { counterparty_label: Some("sam lee"), title: "send the report", ..one_clone(&one) };
        assert_eq!(candidate_signature(&one), candidate_signature(&two));
        assert_eq!(candidate_signature(&one), "promise|sam lee|send the report|2026-11-20|notes|".to_owned() + &sha8("n1"));
    }

    fn one_clone<'a>(i: &SignatureInput<'a>) -> SignatureInput<'a> {
        SignatureInput { kind: i.kind, counterparty_label: i.counterparty_label, title: i.title,
            due_local_date: i.due_local_date, source_kind: i.source_kind, source_ref: i.source_ref }
    }
}
