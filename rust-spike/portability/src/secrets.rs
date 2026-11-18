//! AES-256-GCM credential envelopes (`packages/db/src/secret-cipher.ts`, `keyring.ts`) and
//! the nested family keys in the master key store (`packages/settings/src/master-key-store.ts`).

use std::collections::HashMap;

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::js;

pub type Env = HashMap<String, String>;

const AUTH_FAILURE: &str = "Unsupported state or unable to authenticate data";

#[derive(Debug, Clone)]
pub struct Keyring {
    pub current_key_id: String,
    /// Insertion order kept so lookups and candidates match the TypeScript `Map`.
    pub keys: Vec<(String, Vec<u8>)>,
    pub legacy_candidates: Vec<Vec<u8>>,
}

impl Keyring {
    fn key(&self, key_id: &str) -> Option<&[u8]> {
        self.keys.iter().find(|(id, _)| id == key_id).map(|(_, key)| key.as_slice())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub key_id: Option<String>,
    pub iv: String,
    pub tag: String,
    pub ciphertext: String,
}

#[derive(Debug)]
pub struct Decrypted {
    pub plaintext: Vec<u8>,
    pub value: Map<String, Value>,
    /// The payload held a lone surrogate, which Rust strings cannot carry.
    pub replaced_lone_surrogates: bool,
}

/// `resolveMossEnv`: the `MOSS_` name wins over the `JARVIS_` name, even when empty.
/// The rename carve-out list in `env.ts` covers none of the key names used here.
pub fn resolve_moss_env<'a>(env: &'a Env, jarvis_name: &str) -> Option<&'a str> {
    if let Some(rest) = jarvis_name.strip_prefix("JARVIS_") {
        if let Some(value) = env.get(&format!("MOSS_{rest}")) {
            return Some(value);
        }
    }
    env.get(jarvis_name).map(String::as_str)
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// `resolveKeyring`: each key is SHA-256 of its secret text.
pub fn resolve_keyring(
    key_env_var: &str,
    key_id_env_var: &str,
    keys_env_var: &str,
    dev_default: &str,
    env: &Env,
) -> Result<Keyring, String> {
    let current_secret = resolve_moss_env(env, key_env_var);
    let hardened = env.get("NODE_ENV").is_some_and(|name| name != "development" && name != "test");
    let rule = "in production (and any non-development/test NODE_ENV)";
    if hardened && current_secret.map_or(true, str::is_empty) {
        return Err(format!("{key_env_var} is required {rule}"));
    }
    if hardened && current_secret.is_some_and(|secret| secret.len() < 32) {
        return Err(format!("{key_env_var} must be at least 32 bytes of key material {rule}"));
    }

    // `??`, not `||`: an empty secret outside a hardened environment is used as is.
    let current_key = sha256(current_secret.unwrap_or(dev_default).as_bytes());
    let current_key_id = resolve_moss_env(env, key_id_env_var).unwrap_or("v1").to_string();
    let mut keys = vec![(current_key_id.clone(), current_key.clone())];
    let mut legacy_candidates = vec![current_key];

    if let Some(text) = resolve_moss_env(env, keys_env_var).filter(|text| !text.is_empty()) {
        let Value::Object(retired) = js::parse_json(text)?.0 else {
            return Err(format!("{keys_env_var} must be a JSON object of {{keyId: secret}}"));
        };
        for (id, secret) in js::entries(&retired) {
            let Some(secret) = secret.as_str().filter(|secret| !secret.is_empty()) else {
                return Err(format!("{keys_env_var} entry \"{id}\" must be a non-empty string secret"));
            };
            if *id == current_key_id {
                continue;
            }
            let key = sha256(secret.as_bytes());
            keys.push((id.clone(), key.clone()));
            legacy_candidates.push(key);
        }
    }

    Ok(Keyring { current_key_id, keys, legacy_candidates })
}

/// First 16 hex characters of SHA-256 of each legacy candidate, in try order.
pub fn fingerprints(keyring: &Keyring) -> Vec<String> {
    keyring.legacy_candidates.iter().map(|key| hex::encode(sha256(key))[..16].to_string()).collect()
}

enum OpenError {
    WrongKey,
    Other(String),
}

/// One AES-256-GCM open, with checks in Node's order: key, IV, tag, then authentication.
fn open(key: &[u8], iv: &[u8], tag: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, OpenError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| OpenError::Other("Invalid key length".to_string()))?;
    // Node also takes other IV lengths and tags cut to 4, 8 or 12 to 15 bytes. The app never
    // writes either, so the port refuses them rather than carry the weaker forms forward.
    if iv.len() != 12 {
        return Err(OpenError::Other(format!("GCM IV must be 12 bytes, got {}", iv.len())));
    }
    if tag.len() != 16 {
        return Err(OpenError::Other(format!("GCM tag must be 16 bytes, got {}", tag.len())));
    }
    let mut buffer = ciphertext.to_vec();
    cipher
        .decrypt_in_place_detached(Nonce::from_slice(iv), b"", &mut buffer, Tag::from_slice(tag))
        .map_err(|_| OpenError::WrongKey)?;
    Ok(buffer)
}

pub struct JsonSecretCipher {
    pub keyring: Keyring,
    pub label: String,
}

impl JsonSecretCipher {
    pub fn new(keyring: Keyring, label: &str) -> Self {
        Self { keyring, label: label.to_string() }
    }

    fn capitalized_label(&self) -> String {
        let mut chars = self.label.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
    }

    /// `parseEnvelope`: shape checks only, with the app's messages.
    pub fn parse_envelope(&self, json: &Value) -> Result<Envelope, String> {
        let malformed = |detail: String| format!("Malformed {} envelope: {detail}", self.label);
        let Value::Object(candidate) = json else {
            return Err(malformed("not a JSON object".to_string()));
        };
        let version = candidate.get("version");
        if version.and_then(Value::as_f64) != Some(1.0) {
            return Err(malformed(format!("unsupported version {}", js::to_js_string(version))));
        }
        let algorithm = candidate.get("algorithm");
        if algorithm.and_then(Value::as_str) != Some("aes-256-gcm") {
            return Err(malformed(format!("unsupported algorithm {}", js::to_js_string(algorithm))));
        }
        let key_id = match candidate.get("keyId") {
            None => None,
            Some(Value::String(id)) => Some(id.clone()),
            Some(_) => return Err(malformed("keyId must be a string when present".to_string())),
        };
        let field = |name: &str| match candidate.get(name) {
            Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
            _ => Err(malformed(format!("{name} must be a non-empty string"))),
        };
        Ok(Envelope { key_id, iv: field("iv")?, tag: field("tag")?, ciphertext: field("ciphertext")? })
    }

    /// `decryptJson`. An envelope with no key id tries each legacy candidate and moves on only
    /// when authentication fails; any other failure stops the search.
    pub fn decrypt_json(&self, envelope: &Envelope) -> Result<Decrypted, String> {
        let iv = js::base64_decode(&envelope.iv);
        let tag = js::base64_decode(&envelope.tag);
        let ciphertext = js::base64_decode(&envelope.ciphertext);

        let plaintext = match &envelope.key_id {
            None => {
                let mut opened = None;
                for candidate in &self.keyring.legacy_candidates {
                    match open(candidate, &iv, &tag, &ciphertext) {
                        Ok(plaintext) => {
                            opened = Some(plaintext);
                            break;
                        }
                        Err(OpenError::WrongKey) => continue,
                        Err(OpenError::Other(error)) => return Err(error),
                    }
                }
                opened.ok_or_else(|| {
                    format!("Legacy {} envelope: no key could authenticate it", self.label)
                })?
            }
            Some(key_id) => {
                let key = self
                    .keyring
                    .key(key_id)
                    .ok_or_else(|| format!("Unknown {} key id: {key_id}", self.label))?;
                open(key, &iv, &tag, &ciphertext).map_err(|error| match error {
                    OpenError::WrongKey => AUTH_FAILURE.to_string(),
                    OpenError::Other(error) => error,
                })?
            }
        };

        // `toString("utf8")` replaces bad bytes rather than failing.
        let (value, replaced_lone_surrogates) = js::parse_json(&String::from_utf8_lossy(&plaintext))?;
        let Value::Object(value) = value else {
            return Err(format!("{} payload must be a JSON object", self.capitalized_label()));
        };
        Ok(Decrypted { plaintext, value, replaced_lone_surrogates })
    }

    /// `encryptJson`: a fresh 12-byte IV, the current key, standard padded base64.
    pub fn encrypt_json(&self, value: &Map<String, Value>) -> Value {
        let key = self.keyring.key(&self.keyring.current_key_id).expect("keyring holds its current key");
        let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);
        let mut buffer = serde_json::to_vec(value).expect("JSON values serialize");
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut buffer)
            .expect("payload fits in one GCM message");
        json!({
            "version": 1,
            "algorithm": "aes-256-gcm",
            "keyId": self.keyring.current_key_id,
            "iv": STANDARD.encode(iv),
            "tag": STANDARD.encode(tag),
            "ciphertext": STANDARD.encode(buffer),
        })
    }
}

/// The family keyring from the stored instance setting (`{ value: envelope }`), sealed by
/// the master cipher. `None` matches the TypeScript "corrupt row reads as missing".
///
/// Only the store branch of `loadFamilyKeyring`. Its two other branches, an env key that
/// takes precedence and the development fallback, are plain `resolve_keyring` calls.
pub fn family_keyring_from_setting(setting: &Value, master: &JsonSecretCipher) -> Option<Keyring> {
    let stored = setting.get("value").filter(|value| !value.is_null())?;
    let payload = master.parse_envelope(stored).and_then(|e| master.decrypt_json(&e)).ok()?.value;
    let key_id = payload.get("keyId")?.as_str()?;
    let secret = payload.get("secret")?.as_str()?;
    let retired: Vec<(&str, &str)> = match payload.get("retired") {
        None => Vec::new(),
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(|entry| Some((entry.get("keyId")?.as_str()?, entry.get("secret")?.as_str()?)))
            .collect(),
        Some(_) => return None,
    };

    // Family secrets are hex of the raw key, used as is rather than hashed again.
    let current = js::hex_decode(secret);
    let mut keys = vec![(key_id.to_string(), current.clone())];
    let mut legacy_candidates = vec![current];
    for (id, secret) in retired {
        if keys.iter().any(|(existing, _)| existing == id) {
            continue;
        }
        let previous = js::hex_decode(secret);
        keys.push((id.to_string(), previous.clone()));
        legacy_candidates.push(previous);
    }
    Some(Keyring { current_key_id: key_id.to_string(), keys, legacy_candidates })
}

/// A family key store setting in the shape `generateFamilyKey` writes.
pub fn seal_family_setting(
    key_id: &str,
    secret: &[u8; 32],
    retired: &[(String, Vec<u8>)],
    master: &JsonSecretCipher,
) -> Value {
    let retired: Vec<Value> = retired
        .iter()
        .map(|(id, secret)| json!({ "keyId": id, "secret": hex::encode(secret) }))
        .collect();
    let payload = json!({ "keyId": key_id, "secret": hex::encode(secret), "retired": retired });
    json!({ "value": master.encrypt_json(payload.as_object().expect("payload is an object")) })
}
