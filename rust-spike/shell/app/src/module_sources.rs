//! Trusted host configuration; browsers select a source ID, never a path or key.
use anyhow::{ensure, Context, Result};
use moss_module_host::trust;
use moss_network::config::private_read;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub id: String,
    pub folder: Option<PathBuf>,
    pub url: Option<String>,
    pub root_key: String,
    pub first_party_key: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Configuration {
    Several(Registries),
    Legacy(Registry),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registries {
    registries: Vec<Registry>,
}
impl Registry {
    pub fn binding(&self) -> Result<String> {
        Ok(trust::digest(&serde_json::to_vec(self)?))
    }
}
pub fn read(instance: &Path) -> Result<Vec<Registry>> {
    let bytes = private_read(&instance.join(super::module_admin::REGISTRY_FILE))
        .map_err(|_| anyhow::anyhow!("No module registry is set up for this server"))?;
    decode(&bytes)
}
pub(crate) fn decode(bytes: &[u8]) -> Result<Vec<Registry>> {
    let config: Configuration =
        serde_json::from_slice(bytes).context("The module registry settings are not valid")?;
    let sources = match config {
        Configuration::Legacy(source) => vec![source],
        Configuration::Several(config) => config.registries,
    };
    ensure!(sources.len() <= 16, "Configure at most sixteen registries");
    let mut ids = BTreeSet::new();
    for source in &sources {
        ensure!(
            moss_module_host::manifest::identifier(&source.id) && ids.insert(&source.id),
            "Registry IDs must be valid and unique"
        );
        ensure!(
            source.folder.is_some() != source.url.is_some(),
            "Each registry needs one folder or URL"
        );
    }
    Ok(sources)
}
pub fn select(instance: &Path, id: Option<&str>) -> Result<Registry> {
    read(instance)?
        .into_iter()
        .find(|r| id.is_none_or(|id| r.id == id))
        .context("The source registry is not configured")
}

pub fn write(instance: &Path, sources: &[Registry]) -> Result<()> {
    let bytes = serde_json::to_vec(&serde_json::json!({"registries":sources}))?;
    decode(&bytes)?;
    moss_network::config::private_write(&instance.join(super::module_admin::REGISTRY_FILE), &bytes)
        .map_err(anyhow::Error::msg)
}
impl Registry {
    pub fn source(&self) -> Result<moss_module_host::registry::Source> {
        match (&self.folder, &self.url) {
            (Some(folder), None) => Ok(moss_module_host::registry::Source::Folder(folder.clone())),
            (None, Some(url)) => Ok(moss_module_host::registry::Source::Https {
                base: url.parse()?,
                allow_private: false,
                certificate_pem: None,
            }),
            _ => anyhow::bail!("Each registry needs one folder or URL"),
        }
    }
}
