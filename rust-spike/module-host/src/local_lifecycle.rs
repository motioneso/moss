//! Builder-only activation uses the same stage, snapshot, migration and commit as downloads.
#[cfg(unix)]
use crate::local_packages::{LocalPackages, Signature};
use crate::{
    activation::Origin,
    archive::Package,
    store::{Activation, Installer},
};
use access_context::AccessContext;
use anyhow::{ensure, Result};

impl Installer {
    #[cfg(unix)]
    pub fn install_local(
        &self,
        access: &AccessContext,
        local: &LocalPackages,
        bytes: &[u8],
        signature: &Signature,
        approved: bool,
    ) -> Result<()> {
        let verified = local.verify(access, bytes, signature)?;
        let package = Package::read(bytes, &verified.record().digest, &self.moss)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        self.recover_locked()?;
        let state = self.catalog.load()?;
        let owner = access.actor_user_id();
        if let Some(old) = state
            .installed
            .get(&package.manifest.id)
            .or_else(|| state.retained.get(&package.manifest.id))
        {
            ensure!(
                old.local_owner == Some(owner)
                    && old.publisher_public_key == verified.trust().public_key,
                "Local package ownership or signing key changed"
            );
        }
        for (id, range) in &package.manifest.requires {
            ensure!(
                state
                    .installed
                    .get(id)
                    .is_some_and(|m| range.matches(&m.manifest.version)),
                "A required module is missing or incompatible"
            );
        }
        self.activate_verified(
            access,
            package,
            bytes,
            Origin {
                publisher_key: verified.trust().fingerprint.clone(),
                public_key: verified.trust().public_key.clone(),
                source: format!("local:{}", verified.trust().installation_id),
                local_owner: Some(owner),
            },
            Activation {
                approved,
                pin_override: None,
            },
            &|_| Ok(()),
        )
    }
}

impl crate::store::Installed {
    pub fn visible_to(&self, access: &AccessContext) -> bool {
        match self.local_owner {
            Some(owner) => {
                owner == access.actor_user_id()
                    && self.manifest.id.starts_with(&format!("local.{owner}."))
            }
            None => !self.manifest.id.starts_with("local."),
        }
    }
}
impl Installer {
    pub(crate) fn manage(
        &self,
        access: &AccessContext,
        module: &crate::store::Installed,
    ) -> Result<()> {
        ensure!(
            module.visible_to(access),
            "Module is unavailable for this account"
        );
        if module.local_owner.is_none() {
            self.admin(access)?;
        }
        Ok(())
    }
    /// Account projection; never expose the host catalog's unfiltered state to a caller.
    pub fn installed_for(&self, access: &AccessContext) -> Result<Vec<crate::store::Installed>> {
        Ok(self
            .catalog
            .load()?
            .installed
            .into_values()
            .filter(|m| m.visible_to(access))
            .collect())
    }
    /// A package export/read is authorized against its active owner before opening the blob.
    pub fn package_for_account(&self, access: &AccessContext, id: &str) -> Result<Package> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let state = self.catalog.load()?;
        let module = state
            .installed
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Module unavailable"))?;
        ensure!(
            module.visible_to(access),
            "Module is unavailable for this account"
        );
        self.read_package_trusted(&module.digest)
    }
}
