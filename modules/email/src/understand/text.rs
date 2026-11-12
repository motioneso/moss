//! Small text helpers the sign-in code rule and the gate share. The old rules used
//! regular expressions with look-around, which the Rust regex crate lacks, so the
//! matching is written out by hand.

/// A run of word characters (letters, digits, underscore) in a character slice.
#[derive(Clone, Copy, Debug)]
pub struct Word {
    pub start: usize,
    pub end: usize,
}

pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

pub fn is_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

pub fn words(chars: &[char]) -> Vec<Word> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if is_word(chars[i]) {
            let start = i;
            while i < chars.len() && is_word(chars[i]) {
                i += 1;
            }
            out.push(Word { start, end: i });
        } else {
            i += 1;
        }
    }
    out
}

pub fn slice(chars: &[char], word: Word) -> String {
    chars[word.start..word.end].iter().collect()
}

/// True when any whole word of the text is in the list.
pub fn has_any_word(text: &str, list: &[&str]) -> bool {
    let chars: Vec<char> = text.chars().collect();
    words(&chars).into_iter().any(|w| list.contains(&slice(&chars, w).as_str()))
}

/// True when the phrase occurs with a word boundary on both ends.
pub fn has_phrase(text: &str, phrase: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = phrase.chars().collect();
    if needle.is_empty() || chars.len() < needle.len() {
        return false;
    }
    (0..=chars.len() - needle.len()).any(|i| {
        chars[i..i + needle.len()] == needle[..]
            && (i == 0 || !is_word(chars[i - 1]))
            && (i + needle.len() == chars.len() || !is_word(chars[i + needle.len()]))
    })
}

/// The lower-cased text of a character range.
pub fn text(chars: &[char], from: usize, to: usize) -> String {
    chars[from..to].iter().collect()
}

pub fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The bare lower-cased address of a `Name <address>` header value.
pub fn sender_address(from: &str) -> String {
    let inner = from
        .match_indices('<')
        .find_map(|(open, _)| {
            let rest = &from[open + 1..];
            rest.find('>').filter(|close| *close > 0).map(|close| &rest[..close])
        })
        .unwrap_or(from);
    inner.trim().to_lowercase()
}
