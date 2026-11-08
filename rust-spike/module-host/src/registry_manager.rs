//! Persisted trusted registry settings and signed root transitions. Network failures retain
//! the last signed metadata; expiry and revocation checks still apply to cached catalogs.
use crate::{
    registry::{Catalog, Source},
    store::Installer,
    trust,
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryConfiguration {
    pub id: String,
    pub source: Source,
    pub root_key: String,
    pub first_party_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootTransition {
    pub registry: String,
    pub previous_fingerprint: String,
    pub next_key: String,
    pub serial: u64,
}
impl Installer {
    pub fn configure_registry(
        &self,
        access: &AccessContext,
        config: &RegistryConfiguration,
    ) -> Result<Catalog> {
        ensure!(
            crate::manifest::identifier(&config.id),
            "Invalid registry id"
        );
        let catalog = self.refresh(
            access,
            config.source.clone(),
            &config.root_key,
            &config.first_party_key,
            &config.id,
        )?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let seen = state
            .registries
            .get_mut(&config.id)
            .context("Registry is not trusted")?;
        seen.configuration = Some(config.clone());
        seen.removed = false;
        state.revision += 1;
        self.catalog.commit(revision, &state)?;
        Ok(catalog)
    }
    pub fn registries(&self, access: &AccessContext) -> Result<Vec<RegistryConfiguration>> {
        self.admin(access)?;
        Ok(self
            .catalog
            .load()?
            .registries
            .values()
            .filter(|r| !r.removed)
            .filter_map(|r| r.configuration.clone())
            .collect())
    }
    /// Removing a source retains replay and revocation history; it never resets trust.
    pub fn remove_registry(&self, access: &AccessContext, id: &str) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let seen = state
            .registries
            .get_mut(id)
            .context("Registry is not trusted")?;
        seen.removed = true;
        state.revision += 1;
        self.catalog.commit(revision, &state)
    }
    pub fn refresh_configured(
        &self,
        access: &AccessContext,
    ) -> Result<Vec<(String, Option<String>)>> {
        let mut report = Vec::new();
        for config in self.registries(access)? {
            let result = self.refresh(
                access,
                config.source,
                &config.root_key,
                &config.first_party_key,
                &config.id,
            );
            report.push((config.id,result.err().map(|_|"The registry could not be refreshed; saved signed metadata remains available".into())));
        }
        Ok(report)
    }
    pub fn saved_catalog(&self, access: &AccessContext, id: &str) -> Result<Catalog> {
        self.admin(access)?;
        ensure!(crate::manifest::identifier(id), "Invalid registry id");
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let folder = self.root.subdir("registries")?.subdir(id)?;
        let state = self.catalog.load()?;
        let config = state
            .registries
            .get(id)
            .and_then(|r| r.configuration.clone())
            .context("Registry is not configured")?;
        let mut seen = state
            .registries
            .get(id)
            .cloned()
            .context("Registry has not been trusted")?;
        let mut catalog = Catalog::fetch(
            Source::Folder(folder.path().into()),
            &config.root_key,
            &config.first_party_key,
            &mut seen,
        )?;
        catalog.source = config.source;
        catalog.assert_current(&state.registries[id])?;
        Ok(catalog)
    }
    pub fn rotate_root(
        &self,
        access: &AccessContext,
        document: &[u8],
        signature: &str,
    ) -> Result<()> {
        self.admin(access)?;
        let transition: RootTransition = serde_json::from_slice(document)?;
        ensure!(
            crate::manifest::identifier(&transition.registry),
            "Invalid registry id"
        );
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let folder = self
            .root
            .subdir("registries")?
            .subdir(&transition.registry)?;
        let mut state = self.catalog.load()?;
        let mut config = state
            .registries
            .get(&transition.registry)
            .and_then(|r| r.configuration.clone())
            .context("Registry is not configured")?;
        trust::verify(&config.root_key, document, signature)?;
        let revision = state.revision;
        let seen = state
            .registries
            .get_mut(&transition.registry)
            .context("Registry is not trusted")?;
        ensure!(
            seen.root_fingerprint.as_deref() == Some(&transition.previous_fingerprint)
                && transition.serial > seen.serial,
            "Stale registry root transition"
        );
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.decode(&transition.next_key)?;
        ensure!(key.len() == 32, "Invalid next root key");
        // Verify the new identity and index before committing the transition. Retain version
        // and revocation history, with the old index serial as the replay floor.
        let mut next = seen.clone();
        next.root_fingerprint = Some(trust::digest(&key));
        next.index_digest.clear();
        let catalog = Catalog::fetch(
            config.source.clone(),
            &transition.next_key,
            &config.first_party_key,
            &mut next,
        )?;
        ensure!(
            catalog.index.serial >= transition.serial && catalog.trust.identity.id == config.id,
            "Root transition index is too old"
        );
        config.root_key = transition.next_key.clone();
        next.configuration = Some(config.clone());
        *seen = next;
        state.revision += 1;
        self.catalog.commit(revision, &state)?;
        config.root_key = transition.next_key;
        catalog.save_metadata(folder.path())?;
        folder.write("configuration.json", &serde_json::to_vec(&config)?)?;
        Ok(())
    }
}
