//! better-auth 1.6.14 password hashes, as `@better-auth/utils/password` makes and checks them
//! on Node: `salt:key`, where the salt is 32 hex characters used as text, and the key is
//! scrypt (N=16384, r=16, p=1, 64 bytes) of the NFKC-normalized password, in lowercase hex.

use scrypt::{scrypt, Params};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

const LOG_N: u8 = 14;
const R: u32 = 16;
const P: u32 = 1;
const KEY_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum PasswordError {
    InvalidHash,
}

impl std::fmt::Display for PasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Invalid password hash")
    }
}

pub fn nfkc(password: &str) -> String {
    password.nfkc().collect()
}

fn derive_key(password: &str, salt: &str) -> [u8; KEY_LEN] {
    let params = Params::new(LOG_N, R, P, KEY_LEN).expect("fixed scrypt parameters are valid");
    let mut key = [0u8; KEY_LEN];
    scrypt(
        nfkc(password).as_bytes(),
        salt.as_bytes(),
        &params,
        &mut key,
    )
    .expect("output length matches the parameters");
    key
}

pub fn verify_password(hash: &str, password: &str) -> Result<bool, PasswordError> {
    // Like `hash.split(":")`: the first two parts count, anything after them is ignored.
    let mut parts = hash.split(':');
    let salt = parts.next().unwrap_or_default();
    let key = parts.next().unwrap_or_default();
    if salt.is_empty() || key.is_empty() {
        return Err(PasswordError::InvalidHash);
    }

    // Node compares lowercase hex text with `===`, so an uppercase stored key never matches.
    // The comparison here is constant time.
    let derived = hex::encode(derive_key(password, salt));
    Ok(derived.as_bytes().ct_eq(key.as_bytes()).into())
}

pub fn hash_password(password: &str) -> String {
    let salt = hex::encode(rand::random::<[u8; 16]>());
    let key = hex::encode(derive_key(password, &salt));
    format!("{salt}:{key}")
}
