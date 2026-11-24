//! One transaction and recovery path for registry and owner-private local packages.
use crate::{
    archive::Package,
    store::{Activation, Installed, Installer},
    trust,
};
use access_context::AccessContext;
use anyhow::{ensure, Result};
use std::sync::Arc;
pub(crate) struct Origin {
    pub publisher_key: String,
    pub public_key: String,
    pub source: String,
    pub local_owner: Option<uuid::Uuid>,
}
impl Installer {
    pub(crate) fn activate(
        &self,
        access: &AccessContext,
        package: Package,
        bytes: &[u8],
        registry_trust: &trust::TrustedRegistry,
        key_id: &str,
        options: Activation,
    ) -> Result<()> {
        let state = self.catalog.load()?;
        let id = &package.manifest.id;
        let publisher = registry_trust.publisher(key_id, id)?;
        for (registry, seen) in &state.registries {
            ensure!(
                seen.removed
                    || registry == &registry_trust.identity.id
                    || seen
                        .publishers
                        .get(&publisher.prefix)
                        .is_none_or(|key| key == &publisher.key),
                "Resolve conflicting registry publisher prefixes before installing"
            );
        }
        if let Some(old) = state.installed.get(id).or_else(|| state.retained.get(id)) {
            ensure!(
                old.publisher_public_key == publisher.key
                    || old.registry == registry_trust.identity.id
                        && publisher.replaces.contains(&old.publisher_public_key),
                "Only the registry root may approve a publisher replacement"
            );
        }
        self.activate_verified(
            access,
            package,
            bytes,
            Origin {
                publisher_key: key_id.into(),
                public_key: publisher.key.clone(),
                source: registry_trust.identity.id.clone(),
                local_owner: None,
            },
            options,
        )
    }
    pub(crate) fn activate_verified(
        &self,
        access: &AccessContext,
        package: Package,
        bytes: &[u8],
        origin: Origin,
        options: Activation,
    ) -> Result<()> {
        let Activation {
            approved,
            pin_override,
        } = options;
        crate::archive::validate_install(&package, &self.host, &self.inventory)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let id = &package.manifest.id;
        let old = state
            .installed
            .get(id)
            .or_else(|| state.retained.get(id))
            .cloned();
        if let Some(old) = &old {
            ensure!(
                package.manifest.version > old.manifest.version || package.digest == old.digest,
                "An installed module cannot silently move backwards or replace a published version"
            );
            let previous = self.read_package_trusted(&old.digest)?;
            package.unchanged_sql(&previous)?;
            ensure!(
                pin_override
                    .as_ref()
                    .or(old.pin.as_ref())
                    .is_none_or(|pin| pin == &package.manifest.version),
                "This module is pinned to another version"
            );
        }
        let approval = self.approval(&package, false)?;
        ensure!(
            approved || !approval.required(),
            "This update asks for more access or new migrations and needs administrator approval"
        );
        self.stage(&package, bytes)?;
        self.lifecycle.pause_jobs(id)?;
        let snapshot = match self.lifecycle.snapshot(id) {
            Ok(s) => s,
            Err(e) => {
                self.lifecycle.resume_jobs(id)?;
                return Err(e);
            }
        };
        self.begin_change(id, &snapshot, Some(package.digest.clone()))?;
        let outcome = (|| -> Result<()> {
            self.lifecycle.migrate(&package, old.as_ref())?;
            if let Some(wasm) = package.files.get("code/module.wasm") {
                self.host.call(
                    wasm,
                    Arc::new(package.manifest.clone()),
                    access.clone(),
                    self.ports.clone(),
                    "install",
                    "{}",
                )?;
                self.host.call(
                    wasm,
                    Arc::new(package.manifest.clone()),
                    access.clone(),
                    self.ports.clone(),
                    "health",
                    "{}",
                )?;
            }
            state.retained.remove(id);
            state.installed.insert(
                id.clone(),
                Installed {
                    manifest: package.manifest.clone(),
                    digest: package.digest.clone(),
                    publisher_key: origin.publisher_key.clone(),
                    publisher_public_key: origin.public_key.clone(),
                    registry: origin.source.clone(),
                    local_owner: origin.local_owner,
                    pin: pin_override.or_else(|| old.as_ref().and_then(|m| m.pin.clone())),
                    skipped_digest: old.as_ref().and_then(|m| m.skipped_digest.clone()),
                    previous: old.as_ref().map(|m| m.digest.clone()),
                    disabled: old.as_ref().and_then(|m| m.disabled.clone()),
                    revocations: Vec::new(),
                },
            );
            state.apply_revocations();
            state.revision += 1;
            self.catalog.commit(revision, &state)?;
            Ok(())
        })();
        self.complete_change(id, &snapshot, outcome)
    }
}
