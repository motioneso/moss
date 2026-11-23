//! Private activation metadata is sealed before entering the admin-readable catalog.
//! Both the serving catalog and trusted lifecycle reader use this same representation.
use crate::store::State;
use anyhow::{ensure, Result};
use safety_core::secret::{Secret, SecretCipher, SecretFields};
use serde_json::{json, Value};
use std::sync::Arc;
#[derive(Default)]
pub(crate) struct Codec(Option<Arc<SecretCipher>>);
impl Codec {
    pub(crate) fn new(cipher: Arc<SecretCipher>) -> Self {
        Self(Some(cipher))
    }
    pub(crate) fn encode(&self, state: &State) -> Result<Value> {
        let mut public = state.clone();
        let mut local = json!({"installed":{}, "retained":{}});
        for (name, entries) in [
            ("installed", &mut public.installed),
            ("retained", &mut public.retained),
        ] {
            for id in entries
                .keys()
                .filter(|id| id.starts_with("local."))
                .cloned()
                .collect::<Vec<_>>()
            {
                local[name][&id] = serde_json::to_value(entries.remove(&id).unwrap())?;
            }
        }
        let mut stored = serde_json::to_value(public)?;
        if local["installed"].as_object().unwrap().len()
            + local["retained"].as_object().unwrap().len()
            > 0
        {
            let cipher = self
                .0
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Local catalog needs host encryption"))?;
            stored["sealed_local"] =
                cipher.seal(&SecretFields::new().with("state", Secret::new(local.to_string())));
        }
        Ok(stored)
    }
    pub(crate) fn decode(&self, mut stored: Value) -> Result<State> {
        if let Some(sealed) = stored
            .as_object_mut()
            .and_then(|s| s.remove("sealed_local"))
        {
            let cipher = self
                .0
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Local catalog needs host encryption"))?;
            let opened = cipher
                .open(&sealed)
                .map_err(|_| anyhow::anyhow!("Cannot open local activation catalog"))?;
            let local: Value = serde_json::from_str(
                opened
                    .get("state")
                    .ok_or_else(|| anyhow::anyhow!("Invalid local catalog"))?
                    .expose_secret(),
            )?;
            for name in ["installed", "retained"] {
                for (id, entry) in local[name]
                    .as_object()
                    .ok_or_else(|| anyhow::anyhow!("Invalid local catalog"))?
                {
                    ensure!(id.starts_with("local."), "Invalid local catalog id");
                    stored[name][id] = entry.clone();
                }
            }
        }
        Ok(serde_json::from_value(stored)?)
    }
}
