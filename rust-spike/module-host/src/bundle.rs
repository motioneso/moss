//! The release compiles these values into its bootstrap. Never deserialize an allowlist
//! from a downloaded folder or accept this entry point from a guest/browser request.
use crate::{
    archive::Package,
    store::{Activation, Installer},
    trust,
};
use access_context::AccessContext;
use anyhow::{ensure, Result};

pub struct BundledPackage<'a> {
    pub id: &'a str,
    pub digest: &'a str,
    pub signature: &'a str,
}
impl Installer {
    /// Fresh first-party bootstrap only. Once an index has been observed, all new
    /// installations use normal registry policy, even when bundled bytes are available.
    /// The key, registry and entry must come from the release-compiled allowlist.
    pub fn install_bundled(
        &self,
        access: &AccessContext,
        registry: &str,
        first_party_key: &str,
        entry: &BundledPackage<'_>,
        bytes: &[u8],
    ) -> Result<()> {
        self.admin(access)?;
        let package = Package::read(bytes, entry.digest, &self.moss)?;
        ensure!(
            package.manifest.id == entry.id && !entry.id.contains('.'),
            "Wrong bundled module"
        );
        trust::verify(first_party_key, entry.digest.as_bytes(), entry.signature)?;
        let trust = trust::TrustedRegistry::bundled(registry, first_party_key)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let state = self.catalog.load()?;
        ensure!(
            state.registries.is_empty(),
            "Use the registry after its first refresh"
        );
        ensure!(
            !state.installed.contains_key(entry.id) && !state.retained.contains_key(entry.id),
            "Bundle bootstrap cannot replace an existing module"
        );
        for (id, range) in &package.manifest.requires {
            ensure!(
                state
                    .installed
                    .get(id)
                    .is_some_and(|m| range.matches(&m.manifest.version)),
                "A required module is missing or incompatible"
            );
        }
        self.activate(
            access,
            package,
            bytes,
            &trust,
            "first-party",
            Activation {
                approved: true,
                pin_override: None,
            },
        )
    }
}

pub struct BundleItem<'a> {
    pub package: BundledPackage<'a>,
    pub bytes: &'a [u8],
    pub default: bool,
}
/// Values and package bytes are embedded in the stand-in bootstrap executable.
pub struct Bundle<'a> {
    pub registry: &'a str,
    pub first_party_key: &'a str,
    pub packages: &'a [BundleItem<'a>],
}
impl Bundle<'_> {
    pub fn bootstrap(&self, installer: &Installer, access: &AccessContext) -> Result<()> {
        use std::collections::{BTreeMap, BTreeSet};
        installer.admin(access)?;
        let mut packages = BTreeMap::new();
        // Validate every package, including optional ones, before writing any bytes.
        for item in self.packages {
            let package = Package::read(item.bytes, item.package.digest, &installer.moss)?;
            ensure!(
                package.manifest.id == item.package.id && !item.package.id.contains('.'),
                "Wrong bundled module"
            );
            trust::verify(
                self.first_party_key,
                item.package.digest.as_bytes(),
                item.package.signature,
            )?;
            crate::sql::check(&package, &installer.inventory)?;
            if let Some(wasm) = package.files.get("code/module.wasm") {
                installer.host.validate(wasm, &package.manifest)?;
            }
            ensure!(
                packages.insert(item.package.id, (item, package)).is_none(),
                "Repeated bundled module"
            );
        }
        let mut ordered = Vec::new();
        let mut available = BTreeMap::new();
        let mut remaining: BTreeSet<_> = packages
            .iter()
            .filter(|(_, (item, _))| item.default)
            .map(|(id, _)| *id)
            .collect();
        while !remaining.is_empty() {
            let id = remaining.iter().copied().find(|id| {
                packages[id].1.manifest.requires.iter().all(|(dep, range)| {
                    available
                        .get(dep.as_str())
                        .is_some_and(|v| range.matches(v))
                })
            });
            let id = id.ok_or_else(|| {
                anyhow::anyhow!("Default bundle dependencies are missing, incompatible or cyclic")
            })?;
            remaining.remove(id);
            available.insert(id, packages[id].1.manifest.version.clone());
            ordered.push(id);
        }
        {
            let _fence = installer
                .fence
                .write()
                .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
            let _disk = installer.disk_lock(true)?;
            let state = installer.catalog.load()?;
            ensure!(
                state.registries.is_empty(),
                "Use the registry after its first refresh"
            );
            let blobs = installer.root.subdir("blobs/sha256")?;
            for (item, _) in packages.values() {
                match blobs.read(item.package.digest) {
                    Ok(bytes) => ensure!(
                        trust::digest(&bytes) == item.package.digest,
                        "The cached package has changed"
                    ),
                    Err(vault::VaultError::NotFound(_)) => {
                        blobs.write(item.package.digest, item.bytes)?
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        for id in ordered {
            let item = packages[id].0;
            // Resume an interrupted bootstrap only when that exact compiled digest is active.
            if installer
                .catalog
                .load()?
                .installed
                .get(id)
                .is_some_and(|old| {
                    old.digest == item.package.digest
                        && old.publisher_public_key == self.first_party_key
                })
            {
                continue;
            }
            installer.install_bundled(
                access,
                self.registry,
                self.first_party_key,
                &item.package,
                item.bytes,
            )?;
        }
        Ok(())
    }
}

use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleEntry {
    pub id: String,
    pub version: semver::Version,
    pub digest: String,
    pub publisher_key: String,
    pub signature: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleManifest {
    pub registry: String,
    pub index_digest: String,
    pub serial: u64,
    pub signing_key: String,
    pub default: Vec<BundleEntry>,
    pub optional: Vec<BundleEntry>,
}
