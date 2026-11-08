use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publisher {
    pub key: String,
    pub prefix: String,
    #[serde(default)]
    pub replaces: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryIdentity {
    pub id: String,
    pub name: String,
    pub root_fingerprint: String,
    pub index_keys: BTreeMap<String, String>,
    pub publishers: BTreeMap<String, Publisher>,
    #[serde(default)]
    pub lifted_revocations: BTreeSet<String>,
}
#[derive(Clone)]
pub struct TrustedRegistry {
    pub identity: RegistryIdentity,
    first_party_key: String,
}
impl TrustedRegistry {
    /// Root trust is supplied by the host's approved configuration, never by the download.
    pub fn open(
        bytes: &[u8],
        signature: &str,
        root_key: &str,
        first_party_key: &str,
    ) -> Result<Self> {
        verify(root_key, bytes, signature)?;
        let identity: RegistryIdentity = serde_json::from_slice(bytes)?;
        ensure!(
            identity.root_fingerprint == digest(&STANDARD.decode(root_key)?),
            "The registry root key has changed"
        );
        for publisher in identity.publishers.values() {
            ensure!(
                publisher.prefix.is_empty() && publisher.key == first_party_key
                    || crate::manifest::identifier(&publisher.prefix)
                        && !publisher.prefix.contains('.'),
                "A registry cannot assign first-party module names"
            );
            ensure!(
                STANDARD.decode(&publisher.key)?.len() == 32,
                "The publisher key is invalid"
            );
        }
        Ok(Self {
            identity,
            first_party_key: first_party_key.into(),
        })
    }
    pub fn publisher(&self, key_id: &str, module_id: &str) -> Result<&Publisher> {
        let key = self
            .identity
            .publishers
            .get(key_id)
            .context("The publisher is not trusted by this registry")?;
        let allowed = if !module_id.contains('.') {
            key.key == self.first_party_key && key.prefix.is_empty()
        } else {
            !key.prefix.is_empty() && module_id.starts_with(&(key.prefix.clone() + "."))
        };
        ensure!(allowed, "The publisher cannot sign this module name");
        Ok(key)
    }
    pub fn verify_package(
        &self,
        key_id: &str,
        module_id: &str,
        digest: &str,
        signature: &str,
    ) -> Result<()> {
        ensure!(valid_digest(digest), "The package digest is invalid");
        verify(
            &self.publisher(key_id, module_id)?.key,
            digest.as_bytes(),
            signature,
        )
    }
}
