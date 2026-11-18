//! A disposable authenticated native-code cache. The trusted host key is held separately
//! from cache files. Unauthenticated or incompatible bytes are rebuilt from verified Wasm.
use anyhow::Result;
use ring::hmac;
use safety_core::secret::Secret;
use std::{
    hash::{Hash, Hasher},
    path::Path,
};
use wasmtime::{component::Component, Engine};
pub(crate) struct Compiled {
    root: vault::Root,
    key: Secret,
    engine: String,
}
impl Compiled {
    pub(crate) fn new(path: &Path, key: Secret, engine: &Engine) -> Result<Self> {
        anyhow::ensure!(
            key.expose_secret().len() >= 32,
            "A host cache key needs at least thirty-two bytes"
        );
        let root = vault::Root::create(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700))?;
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        engine.precompile_compatibility_hash().hash(&mut h);
        Ok(Self {
            root,
            key,
            engine: format!("{:x}", h.finish()),
        })
    }
    fn name(&self, hash: &str) -> String {
        format!("{}-{hash}", self.engine)
    }
    fn key(&self) -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, self.key.expose_secret().as_bytes())
    }
    pub(crate) fn load(&self, engine: &Engine, hash: &str) -> Option<Component> {
        let name = self.name(hash);
        let bytes = self.root.read(&name).ok()?;
        if bytes.len() < 32 {
            return None;
        }
        let (tag, code) = bytes.split_at(32);
        let mut message = name.into_bytes();
        message.extend_from_slice(code);
        hmac::verify(&self.key(), &message, tag).ok()?;
        // SAFETY: only this engine's serialized output is signed by the trusted host cache
        // key. Both the exact Wasm digest and engine compatibility id are authenticated.
        // Verification and deserialization use the same owned bytes, without a file race.
        unsafe { Component::deserialize(engine, code).ok() }
    }
    pub(crate) fn save(&self, hash: &str, component: &Component) -> Result<()> {
        let name = self.name(hash);
        let code = component.serialize()?;
        let mut message = name.as_bytes().to_vec();
        message.extend_from_slice(&code);
        let mut bytes = hmac::sign(&self.key(), &message).as_ref().to_vec();
        bytes.extend_from_slice(&code);
        self.root.write(&name, &bytes)?;
        Ok(())
    }
}
