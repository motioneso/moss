//! Shared secrets for the runner socket and the tool gateway.

use subtle::ConstantTimeEq;

/// 32 random bytes as hex.
pub fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    hex::encode(bytes)
}

/// Constant-time comparison, so timing never reveals how much of a guess was right.
pub fn same_secret(given: &str, expected: &str) -> bool {
    given.len() == expected.len() && bool::from(given.as_bytes().ct_eq(expected.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_long_and_distinct() {
        let (a, b) = (random_secret(), random_secret());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(same_secret(&a, &a.clone()));
        assert!(!same_secret(&a, &b));
        assert!(!same_secret(&a, &a[..63]));
    }
}
