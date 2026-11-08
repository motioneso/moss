//! Files are staged before a transactional catalog pointer changes. The host holds a write
//! fence across lifecycle changes; callers use read fences across complete invocations.
use crate::{
    archive::Package,
    manifest::{Manifest, Permission},
    registry::{Artifact, Catalog, ModuleList, ModulePin, SeenRegistry},
    runtime::{Host, Ports},
    sql::LegacyInventory,
    trust,
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct State {
    pub revision: u64,
    pub installed: BTreeMap<String, Installed>,
    pub registries: BTreeMap<String, SeenRegistry>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Installed {
    pub manifest: Manifest,
    pub digest: String,
    pub publisher_key: String,
    pub publisher_public_key: String,
    pub registry: String,
    pub pin: Option<Version>,
    pub previous: Option<String>,
    pub disabled: Option<String>,
}
/// Implementations must compare revision and atomically commit the row. The PostgreSQL
/// implementation keeps activation in a database row; no symlink or file is the version pointer.
pub trait CatalogStore: Send + Sync {
    fn load(&self) -> Result<State>;
    fn commit(&self, expected: u64, next: &State) -> Result<()>;
}
/// This trusted service composes existing queue and migration services with the host. A
/// module can never obtain it through the guest linker. A snapshot precedes any data change.
pub trait Lifecycle: Send + Sync {
    fn is_admin(&self, access: &AccessContext) -> Result<bool>;
    fn pause_jobs(&self, id: &str) -> Result<()>;
    fn resume_jobs(&self, id: &str) -> Result<()>;
    fn snapshot(&self, id: &str) -> Result<String>;
    fn migrate(&self, new: &Package, old: Option<&Installed>) -> Result<()>;
    fn restore(&self, id: &str, snapshot: &str) -> Result<()>;
    fn purge(&self, id: &str) -> Result<()>;
}
pub struct Installer {
    root: vault::Root,
    catalog: Arc<dyn CatalogStore>,
    lifecycle: Arc<dyn Lifecycle>,
    host: Host,
    ports: Arc<dyn Ports>,
    moss: Version,
    inventory: LegacyInventory,
    fence: RwLock<()>,
}
#[derive(Debug)]
pub struct Approval {
    pub new_permissions: Vec<Permission>,
    pub new_migrations: Vec<String>,
    pub urgent: bool,
}
impl Approval {
    pub fn required(&self) -> bool {
        !self.new_permissions.is_empty() || !self.new_migrations.is_empty()
    }
}
impl Installer {
    pub fn new(
        data: &Path,
        catalog: Arc<dyn CatalogStore>,
        lifecycle: Arc<dyn Lifecycle>,
        host: Host,
        ports: Arc<dyn Ports>,
        moss: Version,
        inventory: LegacyInventory,
    ) -> Result<Self> {
        let root = vault::Root::create(&data.join("modules"))?;
        for folder in ["blobs", "installed", "staging", "snapshots", "files"] {
            root.create_subdir(folder)?;
        }
        root.create_subdir("blobs")?.create_subdir("sha256")?;
        let installer = Self {
            root,
            catalog,
            lifecycle,
            host,
            ports,
            moss,
            inventory,
            fence: RwLock::new(()),
        };
        let _disk_lock = installer.disk_lock(true)?;
        for entry in std::fs::read_dir(installer.root.subdir("staging")?.path())? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
            } else {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(installer)
    }
    fn disk_lock(&self, exclusive: bool) -> Result<std::fs::File> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.path().join("host.lock"))?;
        if exclusive {
            file.lock()?;
        } else {
            file.lock_shared()?;
        }
        Ok(file)
    }
    fn admin(&self, access: &AccessContext) -> Result<()> {
        ensure!(
            self.lifecycle.is_admin(access)?,
            "An administrator must approve module changes"
        );
        Ok(())
    }
    pub fn refresh(
        &self,
        access: &AccessContext,
        source: crate::registry::Source,
        root_key: &str,
        first_party_key: &str,
        registry_id: &str,
    ) -> Result<Catalog> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let previous = state.revision;
        let catalog = Catalog::fetch(
            source,
            root_key,
            first_party_key,
            state.registries.entry(registry_id.into()).or_default(),
        )?;
        ensure!(
            catalog.trust.identity.id == registry_id,
            "The registry has a different identity"
        );
        let seen = &state.registries[registry_id];
        for installed in state
            .installed
            .values_mut()
            .filter(|m| m.registry == registry_id)
        {
            if [&installed.digest, &installed.publisher_key]
                .iter()
                .any(|k| {
                    seen.revocations
                        .get(*k)
                        .is_some_and(|r| r.level == crate::registry::RevocationLevel::Block)
                })
            {
                installed.disabled = Some("The registry blocked this module or publisher".into());
                self.lifecycle.pause_jobs(&installed.manifest.id)?;
            }
        }
        state.revision += 1;
        self.catalog.commit(previous, &state)?;
        Ok(catalog)
    }
    pub fn approval(&self, package: &Package, urgent: bool) -> Result<Approval> {
        let state = self.catalog.load()?;
        let old = state.installed.get(&package.manifest.id);
        Ok(Approval {
            new_permissions: old.map_or_else(
                || package.manifest.permissions(),
                |old| package.manifest.newly_requested(&old.manifest),
            ),
            new_migrations: package
                .manifest
                .database
                .migrations
                .iter()
                .filter(|p| old.is_none_or(|old| !old.manifest.database.migrations.contains(p)))
                .cloned()
                .collect(),
            urgent,
        })
    }
    pub fn install(
        &self,
        access: &AccessContext,
        catalog: &Catalog,
        artifact: &Artifact,
        approved: bool,
    ) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(true)?;
        let state = self.catalog.load()?;
        let seen = state
            .registries
            .get(&catalog.trust.identity.id)
            .context("Refresh this registry before installing")?;
        let installed = state
            .installed
            .iter()
            .map(|(k, v)| (k.clone(), v.manifest.version.clone()))
            .collect();
        let pin = state
            .installed
            .get(&artifact.id)
            .and_then(|v| v.pin.as_ref());
        let selected = catalog.select(
            &artifact.id,
            pin.or(Some(&artifact.version)),
            &self.moss,
            &installed,
            seen,
        )?;
        ensure!(
            selected.digest == artifact.digest,
            "The requested package is not the selected signed version"
        );
        let package = catalog.download(artifact, &self.moss)?;
        let bytes = catalog.source.fetch(
            &format!("packages/{}.mosspkg", artifact.digest),
            artifact.size,
        )?;
        // Recheck the bytes saved to the blob store, including if a registry changed mid-fetch.
        ensure!(
            trust::digest(&bytes) == artifact.digest,
            "The package changed during download"
        );
        self.activate(
            access,
            package,
            &bytes,
            catalog,
            &artifact.publisher_key,
            approved,
        )
    }
    pub fn import_file(
        &self,
        access: &AccessContext,
        catalog: &Catalog,
        bytes: &[u8],
        signature: &str,
        publisher_key: &str,
        approved: bool,
    ) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(true)?;
        let digest = trust::digest(bytes);
        let package = Package::read(bytes, &digest, &self.moss)?;
        catalog
            .trust
            .verify_package(publisher_key, &package.manifest.id, &digest, signature)?;
        let state = self.catalog.load()?;
        let seen = state
            .registries
            .get(&catalog.trust.identity.id)
            .context("Trust and refresh the registry before importing a file")?;
        ensure!(
            ![&digest, &publisher_key.to_string()].iter().any(|k| seen
                .revocations
                .get(*k)
                .is_some_and(|r| r.level == crate::registry::RevocationLevel::Block)),
            "This package or publisher is blocked"
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
        self.activate(access, package, bytes, catalog, publisher_key, approved)
    }
    fn activate(
        &self,
        access: &AccessContext,
        package: Package,
        bytes: &[u8],
        catalog: &Catalog,
        key_id: &str,
        approved: bool,
    ) -> Result<()> {
        crate::sql::check(&package, &self.inventory)?;
        if let Some(wasm) = package.files.get("code/module.wasm") {
            self.host.validate(wasm, &package.manifest)?;
        }
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let id = &package.manifest.id;
        let old = state.installed.get(id).cloned();
        let publisher = catalog.trust.publisher(key_id, id)?;
        if let Some(old) = &old {
            ensure!(
                package.manifest.version > old.manifest.version || package.digest == old.digest,
                "An installed module cannot silently move backwards or replace a published version"
            );
            ensure!(
                old.publisher_public_key == publisher.key
                    || publisher.replaces.contains(&old.publisher_public_key),
                "Only the registry root may approve a publisher replacement"
            );
            let previous = self.read_package(&old.digest)?;
            package.unchanged_sql(&previous)?;
            ensure!(
                old.pin
                    .as_ref()
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
            state.installed.insert(
                id.clone(),
                Installed {
                    manifest: package.manifest.clone(),
                    digest: package.digest.clone(),
                    publisher_key: key_id.into(),
                    publisher_public_key: publisher.key.clone(),
                    registry: catalog.trust.identity.id.clone(),
                    pin: old.as_ref().and_then(|m| m.pin.clone()),
                    previous: old.as_ref().map(|m| m.digest.clone()),
                    disabled: None,
                },
            );
            state.revision += 1;
            self.catalog.commit(revision, &state)?;
            Ok(())
        })();
        if outcome.is_err() {
            self.lifecycle.restore(id, &snapshot)?;
        }
        self.lifecycle.resume_jobs(id)?;
        outcome
    }
    fn stage(&self, package: &Package, bytes: &[u8]) -> Result<()> {
        let blob = self.root.subdir("blobs/sha256")?;
        match blob.read(&package.digest) {
            Ok(existing) => ensure!(
                trust::digest(&existing) == package.digest,
                "The cached package has changed"
            ),
            Err(vault::VaultError::NotFound(_)) => blob.write(&package.digest, bytes)?,
            Err(e) => return Err(e.into()),
        }
        let staging = self
            .root
            .subdir("staging")?
            .create_subdir(&uuid::Uuid::new_v4().to_string())?;
        for (path, bytes) in &package.files {
            let parts: Vec<_> = path.split('/').collect();
            let mut dir = staging.clone();
            for part in &parts[..parts.len() - 1] {
                dir = dir.create_subdir(part)?;
            }
            dir.write(parts.last().expect("file"), bytes)?;
        }
        let destination = self
            .root
            .subdir("installed")?
            .create_subdir(&package.manifest.id)?;
        let final_path = destination
            .path()
            .join(package.manifest.version.to_string());
        if final_path.exists() {
            std::fs::remove_dir_all(staging.path())?;
        } else {
            std::fs::rename(staging.path(), &final_path)?;
        }
        make_readonly(&final_path)?;
        Ok(())
    }
    pub fn read_package(&self, digest: &str) -> Result<Package> {
        ensure!(trust::valid_digest(digest), "Invalid installed digest");
        let bytes = self.root.subdir("blobs/sha256")?.read(digest)?;
        Package::read(&bytes, digest, &self.moss)
    }
    pub fn call(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(false)?;
        let state = self.catalog.load()?;
        let installed = state
            .installed
            .get(id)
            .context("This module is not installed")?;
        ensure!(installed.disabled.is_none(), "This module is disabled");
        let package = self.read_package(&installed.digest)?;
        let dir = self
            .root
            .subdir("installed")?
            .subdir(id)?
            .subdir(&installed.manifest.version.to_string())?;
        for (path, expected) in &package.files {
            ensure!(
                dir.read(path)? == *expected,
                "The installed module changed on disk and is disabled"
            );
        }
        let wasm = package
            .files
            .get("code/module.wasm")
            .context("This module has no code handler")?;
        self.host.call(
            wasm,
            Arc::new(installed.manifest.clone()),
            access,
            self.ports.clone(),
            kind,
            payload,
        )
    }
    pub fn pin(&self, access: &AccessContext, id: &str, version: Option<Version>) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let installed = state
            .installed
            .get_mut(id)
            .context("This module is not installed")?;
        ensure!(
            version
                .as_ref()
                .is_none_or(|v| v == &installed.manifest.version),
            "Install the selected version before pinning it"
        );
        installed.pin = version;
        state.revision += 1;
        self.catalog.commit(revision, &state)
    }
    pub fn remove(
        &self,
        access: &AccessContext,
        id: &str,
        delete_data: Option<&str>,
    ) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let module = state
            .installed
            .get(id)
            .context("This module is not installed")?;
        if let Some(typed_name) = delete_data {
            ensure!(
                typed_name == module.manifest.name,
                "Type the module name to delete every account's data"
            );
        }
        self.lifecycle.pause_jobs(id)?;
        let snapshot = if delete_data.is_some() {
            match self.lifecycle.snapshot(id) {
                Ok(snapshot) => Some(snapshot),
                Err(error) => {
                    self.lifecycle.resume_jobs(id)?;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let outcome = (|| -> Result<()> {
            if delete_data.is_some() {
                self.lifecycle.purge(id)?;
            }
            state.installed.remove(id);
            state.revision += 1;
            self.catalog.commit(revision, &state)?;
            Ok(())
        })();
        if let Err(error) = outcome {
            if let Some(snapshot) = snapshot {
                self.lifecycle.restore(id, &snapshot)?;
            }
            self.lifecycle.resume_jobs(id)?;
            return Err(error);
        }
        let path = self.root.subdir("installed")?.subdir(id)?;
        make_writable(path.path())?;
        std::fs::remove_dir_all(path.path())?;
        Ok(())
    }
    /// Only listed modules are added or pinned. A missing name is never a removal request.
    pub fn apply_list(
        &self,
        access: &AccessContext,
        list: &ModuleList,
        catalogs: &BTreeMap<String, Catalog>,
        approved: bool,
    ) -> Result<()> {
        self.admin(access)?;
        for item in &list.modules {
            let catalog = catalogs
                .get(&item.registry)
                .context("The module list names an unconfigured registry")?;
            let state = self.catalog.load()?;
            let installed = state
                .installed
                .iter()
                .map(|(id, m)| (id.clone(), m.manifest.version.clone()))
                .collect();
            let seen = state
                .registries
                .get(&item.registry)
                .context("Refresh the registry before importing the module list")?;
            let artifact = catalog.select(
                &item.id,
                item.version.as_ref(),
                &self.moss,
                &installed,
                seen,
            )?;
            if state
                .installed
                .get(&item.id)
                .is_none_or(|m| m.digest != artifact.digest)
            {
                if state
                    .installed
                    .get(&item.id)
                    .is_some_and(|m| m.pin.is_some())
                {
                    self.pin(access, &item.id, None)?;
                }
                self.install(access, catalog, artifact, approved)?;
            }
            self.pin(access, &item.id, item.version.clone())?;
        }
        Ok(())
    }
    /// The caller schedules this at start, daily, or on opening the future module screen.
    /// Quiet-time updates narrow permissions only; urgent updates use the same approval gate.
    pub fn update(
        &self,
        access: &AccessContext,
        catalog: &Catalog,
        quiet_time: bool,
    ) -> Result<Vec<(String, Approval)>> {
        self.admin(access)?;
        let state = self.catalog.load()?;
        let mut pending = Vec::new();
        let seen = state
            .registries
            .get(&catalog.trust.identity.id)
            .context("Refresh the registry before checking updates")?;
        let installed = state
            .installed
            .iter()
            .map(|(id, m)| (id.clone(), m.manifest.version.clone()))
            .collect();
        for (id, module) in &state.installed {
            if module.registry != catalog.trust.identity.id
                || module.pin.is_some()
                || module.disabled.is_some()
            {
                continue;
            }
            let artifact = catalog.select(id, None, &self.moss, &installed, seen)?;
            if artifact.version <= module.manifest.version {
                continue;
            }
            let package = catalog.download(artifact, &self.moss)?;
            let approval = self.approval(&package, artifact.urgent)?;
            if approval.required() {
                pending.push((id.clone(), approval));
            } else if quiet_time || artifact.urgent {
                self.install(access, catalog, artifact, false)?;
            }
        }
        Ok(pending)
    }
    pub fn export_list(&self) -> Result<ModuleList> {
        Ok(ModuleList {
            modules: self
                .catalog
                .load()?
                .installed
                .into_iter()
                .map(|(id, m)| ModulePin {
                    id,
                    registry: m.registry,
                    version: m.pin,
                })
                .collect(),
        })
    }
    pub fn data_path(&self) -> PathBuf {
        self.root.path().to_path_buf()
    }
}
fn make_readonly(path: &Path) -> Result<()> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            make_readonly(&entry.path())?;
        } else {
            let mut p = entry.metadata()?.permissions();
            p.set_readonly(true);
            std::fs::set_permissions(entry.path(), p)?;
        }
    }
    Ok(())
}
fn make_writable(path: &Path) -> Result<()> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            make_writable(&entry.path())?;
        } else {
            let mut p = entry.metadata()?.permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                p.set_mode(0o600);
            }
            #[cfg(not(unix))]
            p.set_readonly(false);
            std::fs::set_permissions(entry.path(), p)?;
        }
    }
    Ok(())
}
