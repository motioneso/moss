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
