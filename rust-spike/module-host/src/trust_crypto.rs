//! Shared registry and app-feed cryptographic primitives.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn verify(key: &str, bytes: &[u8], signature: &str) -> Result<()> {
    let key = STANDARD
        .decode(key)
        .context("The signing key is not valid")?;
    let sig = STANDARD
        .decode(signature.trim())
        .context("The signature is not valid")?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(bytes, &sig)
        .map_err(|_| anyhow::anyhow!("The signature does not match; nothing was installed"))
}
