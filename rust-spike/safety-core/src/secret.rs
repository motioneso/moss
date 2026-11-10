//! Secrets in memory and at rest.
//!
//! [`Secret`] has no `Debug`, `Display`, `Serialize` or `Clone`, which the assertion below
//! checks at compile time, so it cannot reach a log line, a response body or a job payload by
//! accident. Reading it takes an explicit [`Secret::expose_secret`] call, which
//! `tools/check-safety-rules.sh` allows only in listed files. The memory is wiped on drop.
//!
//! [`SecretCipher`] seals secrets in the AES-256-GCM envelope the TypeScript server uses
//! (`packages/db/src/secret-cipher.ts`), with the same keys, so either server opens the other's.

use std::fmt;

use portability::secrets::{resolve_keyring, Env, JsonSecretCipher};
use serde_json::{Map, Value};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

pub struct Secret {
    value: String,
}

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self { value: value.into() }
    }

    pub fn expose_secret(&self) -> &str {
        &self.value
    }

    /// Compares in constant time.
    pub fn matches(&self, candidate: &str) -> bool {
        self.value.as_bytes().ct_eq(candidate.as_bytes()).into()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// Fails to compile if `$type` implements any of the traits. With one blanket impl the `_`
/// infers; a second impl, present only when the trait holds, makes it ambiguous.
macro_rules! assert_not_impl_any {
    ($type:ty: $($trait:path),+ $(,)?) => {
        const _: fn() = || {
            trait AmbiguousIfImpl<A> {
                fn some_item() {}
            }
            impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
            $({
                #[allow(dead_code)]
                struct Invalid;
                impl<T: ?Sized + $trait> AmbiguousIfImpl<Invalid> for T {}
            })+
            let _ = <$type as AmbiguousIfImpl<_>>::some_item;
        };
    };
}

assert_not_impl_any!(Secret: fmt::Debug, fmt::Display, serde::Serialize, Clone);
assert_not_impl_any!(SecretFields: fmt::Debug, fmt::Display, serde::Serialize, Clone);
assert_not_impl_any!(SecretCipher: fmt::Debug, fmt::Display, serde::Serialize, Clone);

/// Named secrets, as sealed together in one stored envelope.
#[derive(Default)]
pub struct SecretFields {
    fields: Vec<(String, Secret)>,
}

impl SecretFields {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, name: impl Into<String>, value: Secret) -> Self {
        self.fields.push((name.into(), value));
        self
    }

    pub fn get(&self, name: &str) -> Option<&Secret> {
        self.fields.iter().find(|(field, _)| field == name).map(|(_, secret)| secret)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.fields.iter().map(|(name, _)| name.as_str())
    }
}

/// Errors carry no secret text.
#[derive(Debug, PartialEq, Eq)]
pub enum CipherError {
    Config(String),
    Malformed,
    CannotOpen,
    NotText(String),
}

impl fmt::Display for CipherError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CipherError::Config(message) => write!(f, "secret key setup: {message}"),
            CipherError::Malformed => f.write_str("stored secret is not a sealed envelope"),
            CipherError::CannotOpen => f.write_str("stored secret could not be opened"),
            CipherError::NotText(name) => write!(f, "stored secret field {name} is not text"),
        }
    }
}

pub struct SecretCipher {
    inner: JsonSecretCipher,
}

impl SecretCipher {
    /// `createConnectorSecretCipher`.
    pub fn connectors(env: &Env) -> Result<Self, CipherError> {
        Self::from_env(
            [
                "JARVIS_CONNECTOR_SECRET_KEY",
                "JARVIS_CONNECTOR_SECRET_KEY_ID",
                "JARVIS_CONNECTOR_SECRET_KEYS",
            ],
            "jarv1s-development-connector-secret",
            "connector secret",
            env,
        )
    }

    /// `createAiSecretCipher`.
    pub fn ai(env: &Env) -> Result<Self, CipherError> {
        Self::from_env(
            ["JARVIS_AI_SECRET_KEY", "JARVIS_AI_SECRET_KEY_ID", "JARVIS_AI_SECRET_KEYS"],
            "jarv1s-development-ai-secret",
            "AI credential",
            env,
        )
    }

    fn from_env(
        names: [&str; 3],
        dev_default: &str,
        label: &str,
        env: &Env,
    ) -> Result<Self, CipherError> {
        let keyring = resolve_keyring(names[0], names[1], names[2], dev_default, env)
            .map_err(CipherError::Config)?;
        Ok(Self { inner: JsonSecretCipher::new(keyring, label) })
    }

    pub fn seal(&self, fields: &SecretFields) -> Value {
        let mut plain: Map<String, Value> = fields
            .fields
            .iter()
            .map(|(name, secret)| (name.clone(), Value::String(secret.expose_secret().to_owned())))
            .collect();
        let sealed = self.inner.encrypt_json(&plain);
        for value in plain.values_mut() {
            if let Value::String(text) = value {
                text.zeroize();
            }
        }
        sealed
    }

    pub fn open(&self, stored: &Value) -> Result<SecretFields, CipherError> {
        let envelope = self.inner.parse_envelope(stored).map_err(|_| CipherError::Malformed)?;
        let mut opened = self.inner.decrypt_json(&envelope).map_err(|_| CipherError::CannotOpen)?;
        opened.plaintext.zeroize();
        let mut fields = SecretFields::new();
        for (name, value) in std::mem::take(&mut opened.value) {
            match value {
                Value::String(text) => fields.fields.push((name, Secret::new(text))),
                _ => return Err(CipherError::NotText(name)),
            }
        }
        Ok(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "MOSS-SENTINEL-secret-0b9e";

    fn cipher() -> SecretCipher {
        SecretCipher::connectors(&Env::new()).unwrap()
    }

    #[test]
    fn sealed_envelopes_never_hold_the_plaintext() {
        let cipher = cipher();
        let sealed = cipher.seal(&SecretFields::new().with("refreshToken", Secret::new(SENTINEL)));
        assert!(!sealed.to_string().contains(SENTINEL), "{sealed}");
        let opened = cipher.open(&sealed).unwrap();
        assert!(opened.get("refreshToken").unwrap().matches(SENTINEL));
        assert_eq!(opened.names().collect::<Vec<_>>(), ["refreshToken"]);
    }

    #[test]
    fn errors_never_hold_the_plaintext() {
        let cipher = cipher();
        let mut sealed = cipher.seal(&SecretFields::new().with("token", Secret::new(SENTINEL)));
        sealed["tag"] = Value::String("AAAAAAAAAAAAAAAAAAAAAA==".into());
        let error = cipher.open(&sealed).err().unwrap();
        assert_eq!(error, CipherError::CannotOpen);
        assert!(!format!("{error} {error:?}").contains(SENTINEL));

        let not_text = cipher.inner.encrypt_json(
            &[("count".to_owned(), Value::from(3))].into_iter().collect::<Map<_, _>>(),
        );
        assert_eq!(cipher.open(&not_text).err().unwrap(), CipherError::NotText("count".into()));
    }

    #[test]
    fn production_refuses_the_development_key() {
        let env: Env = [("NODE_ENV".to_owned(), "production".to_owned())].into();
        assert!(matches!(SecretCipher::connectors(&env), Err(CipherError::Config(_))));
    }
}
