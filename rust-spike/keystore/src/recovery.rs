//! The owner's recovery key: 256 random bits written down as 24 words from the BIP39 English
//! list. The last word carries an 8-bit checksum, so most copying mistakes are caught. The words
//! are the key itself. There is no passphrase and no stretching, because the key is already random.

use bip39::{Language, Mnemonic};
use sha2::{Digest, Sha256};

pub const WORD_COUNT: usize = 24;
const ID_DOMAIN: &[u8] = b"moss:recovery-key-id:v1\0";

/// No `Debug` or `Display`, so the key cannot end up in a log line.
pub struct RecoveryKey([u8; 32]);

impl RecoveryKey {
    pub fn generate() -> Self {
        Self(rand::random())
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn words(&self) -> Vec<&'static str> {
        Mnemonic::from_entropy(&self.0).expect("32 bytes is a valid length").words().collect()
    }

    /// A short name for the key, shown at setup and at recovery, so the owner can match a
    /// sheet to a computer. It reveals nothing useful about the key.
    pub fn id(&self) -> String {
        let digest = Sha256::new().chain_update(ID_DOMAIN).chain_update(self.0).finalize();
        let hex = hex::encode_upper(&digest[..4]);
        format!("{}-{}", &hex[..4], &hex[4..])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownWord {
    /// Counted from 1, as on the owner's sheet.
    pub position: usize,
    pub typed: String,
    pub suggestion: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WordsError {
    WrongCount { filled: usize },
    /// Every word not on the list, so the owner sees all typos at once.
    UnknownWords(Vec<UnknownWord>),
    /// Every word is on the list, but the checksum in the last word does not fit.
    DoNotFit,
}

fn word_list() -> &'static [&'static str; 2048] {
    Language::English.word_list()
}

/// The full word for an exact word, or for its first four letters or more. No two words on
/// the list share their first four letters. Case and surrounding spaces do not matter.
pub fn full_word(typed: &str) -> Option<&'static str> {
    let typed = typed.trim().to_ascii_lowercase();
    if let Some(index) = Language::English.find_word(&typed) {
        return Some(word_list()[usize::from(index)]);
    }
    if typed.len() < 4 {
        return None;
    }
    let mut matches = word_list().iter().filter(|word| word.starts_with(&typed));
    let first = matches.next()?;
    matches.next().is_none().then_some(*first)
}

/// A likely intended word: the one sharing the first four letters, or the only one a single
/// typo away.
fn suggest(typed: &str) -> Option<&'static str> {
    let typed = typed.trim().to_ascii_lowercase();
    if let Some(start) = typed.get(..4) {
        if let Some(word) = word_list().iter().find(|word| word.get(..4) == Some(start)) {
            return Some(word);
        }
    }
    let mut close = word_list().iter().filter(|word| one_typo_apart(&typed, word));
    let first = close.next()?;
    close.next().is_none().then_some(*first)
}

/// One letter changed, added, dropped, or two neighbours swapped.
fn one_typo_apart(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a == b {
        return false;
    }
    if a.len() == b.len() {
        let differ: Vec<usize> = (0..a.len()).filter(|&i| a[i] != b[i]).collect();
        return differ.len() == 1
            || (differ.len() == 2
                && differ[1] == differ[0] + 1
                && a[differ[0]] == b[differ[1]]
                && a[differ[1]] == b[differ[0]]);
    }
    let (long, short) = if a.len() > b.len() { (a, b) } else { (b, a) };
    if long.len() != short.len() + 1 {
        return false;
    }
    let skip = (0..short.len()).find(|&i| long[i] != short[i]).unwrap_or(short.len());
    long[skip + 1..] == short[skip..]
}

/// Reads the 24 words as typed, one per box.
pub fn parse_words(typed: &[String]) -> Result<RecoveryKey, WordsError> {
    let filled = typed.iter().filter(|word| !word.trim().is_empty()).count();
    if typed.len() != WORD_COUNT || filled != WORD_COUNT {
        return Err(WordsError::WrongCount { filled });
    }
    let mut words = Vec::with_capacity(WORD_COUNT);
    let mut unknown = Vec::new();
    for (index, word) in typed.iter().enumerate() {
        match full_word(word) {
            Some(full) => words.push(full),
            None => unknown.push(UnknownWord {
                position: index + 1,
                typed: word.trim().to_string(),
                suggestion: suggest(word),
            }),
        }
    }
    if !unknown.is_empty() {
        return Err(WordsError::UnknownWords(unknown));
    }
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &words.join(" "))
        .map_err(|_| WordsError::DoNotFit)?;
    let bytes: [u8; 32] = mnemonic.to_entropy().try_into().map_err(|_| WordsError::DoNotFit)?;
    Ok(RecoveryKey(bytes))
}

/// Splits pasted text into words, dropping the numbers of a numbered list such as "1. abandon".
pub fn split_pasted(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .map(|token| token.trim_matches(|c: char| !c.is_alphabetic()))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}
