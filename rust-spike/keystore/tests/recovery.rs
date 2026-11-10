use keystore::recovery::{full_word, parse_words, split_pasted, RecoveryKey, UnknownWord, WordsError};

fn sheet(key: &RecoveryKey) -> Vec<String> {
    key.words().into_iter().map(str::to_string).collect()
}

#[test]
fn twenty_four_words_round_trip() {
    let key = RecoveryKey::generate();
    let words = sheet(&key);
    assert_eq!(words.len(), 24);
    assert_eq!(parse_words(&words).ok().map(|k| *k.bytes()), Some(*key.bytes()));
}

#[test]
fn key_name_is_short_and_stable() {
    let key = RecoveryKey::from_bytes([7; 32]);
    let id = key.id();
    assert_eq!(id, RecoveryKey::from_bytes([7; 32]).id());
    assert_ne!(id, RecoveryKey::from_bytes([8; 32]).id());
    assert!(id.len() == 9 && id.as_bytes()[4] == b'-', "{id}");
}

#[test]
fn four_letters_case_and_spaces_are_enough() {
    let key = RecoveryKey::generate();
    let typed: Vec<String> = sheet(&key)
        .iter()
        .enumerate()
        .map(|(i, word)| match i % 3 {
            0 => format!("  {}  ", word.to_uppercase()),
            1 if word.len() > 4 => word[..4].to_string(),
            _ => word.clone(),
        })
        .collect();
    assert_eq!(parse_words(&typed).ok().map(|k| *k.bytes()), Some(*key.bytes()));
    assert_eq!(full_word("aban"), Some("abandon"));
    assert_eq!(full_word("aba"), None, "three letters are not enough");
}

#[test]
fn a_typo_is_pinpointed_with_the_likely_word() {
    let key = RecoveryKey::from_bytes([7; 32]);
    let mut typed = sheet(&key);
    let at = typed.iter().position(|word| word.len() >= 5).unwrap();
    let intended = typed[at].clone();
    let mut typo = intended.clone();
    typo.pop();
    typo.push('q');
    typed[at] = typo.clone();
    assert_eq!(
        parse_words(&typed).err(),
        Some(WordsError::UnknownWords(vec![UnknownWord {
            position: at + 1,
            typed: typo,
            suggestion: Some(full_word(&intended).unwrap()),
        }]))
    );
}

#[test]
fn a_dropped_letter_still_gets_a_suggestion() {
    // "abandon" with its fourth letter dropped shares only three letters with it.
    let key = RecoveryKey::from_bytes([0; 32]);
    let mut typed = sheet(&key);
    assert_eq!(typed[0], "abandon");
    typed[0] = "abadon".to_string();
    let Some(WordsError::UnknownWords(unknown)) = parse_words(&typed).err() else { panic!() };
    assert_eq!(unknown[0].suggestion, Some("abandon"));
}

#[test]
fn missing_and_misplaced_words_are_refused() {
    let key = RecoveryKey::from_bytes([7; 32]);
    let mut short = sheet(&key);
    short[23] = String::new();
    assert_eq!(parse_words(&short).err(), Some(WordsError::WrongCount { filled: 23 }));

    let mut swapped = sheet(&key);
    let other = (1..24).find(|&i| swapped[i] != swapped[0]).unwrap();
    swapped.swap(0, other);
    assert_eq!(parse_words(&swapped).err(), Some(WordsError::DoNotFit));
}

#[test]
fn pasted_numbered_lists_split_into_words() {
    assert_eq!(
        split_pasted("1. abandon 2) ability,\n3 able; ABOUT"),
        ["abandon", "ability", "able", "ABOUT"]
    );
}
