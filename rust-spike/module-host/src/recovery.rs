//! Write-ahead lifecycle journal. A committed catalog revision is the activation boundary.
//! Recovery is repeatable: snapshots are copied, never consumed, until their retention ends.
use crate::store::{Installed, Installer, State};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub module: String,
    pub id: String,
    pub created: DateTime<Utc>,
    pub expires: DateTime<Utc>,
    pub reason: String,
    pub previous: Option<Installed>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    module: String,
    snapshot: String,
    before: State,
    target: Option<String>,
}
impl Installer {
    pub(crate) fn begin_change(
        &self,
        id: &str,
        snapshot: &str,
        target: Option<String>,
    ) -> Result<()> {
        ensure!(
            !self.root.path().join("operation.json").exists(),
            "A module change needs recovery first"
        );
        let before = self.catalog.load()?;
        let now = Utc::now();
        let meta = Snapshot {
            module: id.into(),
            id: snapshot.into(),
            created: now,
            expires: now + Duration::days(30),
            reason: if target.is_some() {
                "upgrade"
            } else {
                "delete-data"
            }
            .into(),
            previous: before
                .installed
                .get(id)
                .or_else(|| before.retained.get(id))
                .cloned(),
        };
        self.root
            .subdir("snapshots")?
            .subdir(id)?
            .subdir(snapshot)?
            .write("snapshot.json", &serde_json::to_vec(&meta)?)?;
        self.root.write(
            "operation.json",
            &serde_json::to_vec(&Journal {
                module: id.into(),
                snapshot: snapshot.into(),
                before,
                target,
            })?,
        )?;
        sync_directory(self.root.path())
    }
    pub(crate) fn complete_change(
        &self,
        id: &str,
        snapshot: &str,
        result: Result<()>,
    ) -> Result<()> {
        let mut errors = Vec::new();
        if let Err(error) = &result {
            errors.push(format!("Module change failed: {error}"));
            if let Err(restore) = self.lifecycle.restore(id, snapshot) {
                errors.push(format!("Recovery remains pending: {restore}"));
                // Keep jobs fenced when data recovery is incomplete.
                return Err(anyhow::anyhow!(errors.join("; ")));
            }
        }
        if let Err(error) = self.lifecycle.resume_jobs(id) {
            errors.push(format!("Resuming the queue remains pending: {error}"));
            return Err(anyhow::anyhow!(errors.join("; ")));
        }
        self.clear_journal()?;
        result
    }
    fn clear_journal(&self) -> Result<()> {
        let path = self.root.path().join("operation.json");
        if path.exists() {
            std::fs::remove_file(path)?;
            sync_directory(self.root.path())?;
        }
        Ok(())
    }
    /// Called under the data-folder lock before startup accepts any guest calls.
    pub(crate) fn recover_locked(&self) -> Result<()> {
        let bytes = match self.root.read("operation.json") {
            Ok(bytes) => bytes,
            Err(vault::VaultError::NotFound(_)) => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let journal: Journal = serde_json::from_slice(&bytes)?;
        ensure!(
            crate::manifest::identifier(&journal.module)
                && uuid::Uuid::parse_str(&journal.snapshot).is_ok(),
            "Invalid lifecycle journal"
        );
        let current = self.catalog.load()?;
        let committed = current.revision == journal.before.revision + 1
            && match &journal.target {
                Some(digest) => current
                    .installed
                    .get(&journal.module)
                    .is_some_and(|m| &m.digest == digest),
                None => {
                    !current.installed.contains_key(&journal.module)
                        && !current.retained.contains_key(&journal.module)
                }
            };
        ensure!(
            committed || current.revision == journal.before.revision,
            "The catalog changed while recovery was pending; keep this module fenced"
        );
        self.lifecycle.pause_jobs(&journal.module)?;
        if !committed {
            self.lifecycle.restore(&journal.module, &journal.snapshot)?;
        }
        self.lifecycle.resume_jobs(&journal.module)?;
        self.clear_journal()
    }
    pub fn snapshots(&self, access: &AccessContext) -> Result<Vec<Snapshot>> {
        self.admin(access)?;
        self.snapshots_internal()
    }
    fn snapshots_internal(&self) -> Result<Vec<Snapshot>> {
        let mut snapshots = Vec::new();
        let root = self.root.subdir("snapshots")?;
        for module in root.list("")? {
            ensure!(
                module.kind == vault::EntryKind::Dir && crate::manifest::identifier(&module.name),
                "Invalid snapshot module folder"
            );
            let module_root = root.subdir(&module.name)?;
            for entry in module_root.list("")? {
                ensure!(
                    entry.kind == vault::EntryKind::Dir
                        && uuid::Uuid::parse_str(&entry.name).is_ok(),
                    "Invalid snapshot folder"
                );
                let folder = module_root.subdir(&entry.name)?;
                match folder.read("snapshot.json") {
                    Ok(bytes) => {
                        let snapshot: Snapshot = serde_json::from_slice(&bytes)?;
                        ensure!(
                            snapshot.module == module.name && snapshot.id == entry.name,
                            "Snapshot identity mismatch"
                        );
                        snapshots.push(snapshot);
                    }
                    // An interrupted snapshot before journaling changed no live data. It is
                    // discarded on startup, including any incomplete database snapshot schema.
                    Err(vault::VaultError::NotFound(_)) => {
                        self.lifecycle.discard_snapshot(&module.name, &entry.name)?
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        snapshots.sort_by_key(|s| s.created);
        Ok(snapshots)
    }
    pub(crate) fn cleanup_snapshots(&self, now: DateTime<Utc>) -> Result<()> {
        ensure!(
            !self.root.path().join("operation.json").exists(),
            "Do not expire snapshots during recovery"
        );
        for snapshot in self.snapshots_internal()? {
            if snapshot.expires <= now {
                self.lifecycle
                    .discard_snapshot(&snapshot.module, &snapshot.id)?;
            }
        }
        Ok(())
    }
    pub fn expire_snapshots(&self, access: &AccessContext, now: DateTime<Utc>) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        self.cleanup_snapshots(now)
    }
    /// Restoring replaces all accounts' data for this module. Callers must show that loss
    /// explicitly; typing the name is separate from acknowledging intervening writes are lost.
    pub fn restore_snapshot(
        &self,
        access: &AccessContext,
        snapshot: &Snapshot,
        typed_name: &str,
        acknowledge_data_loss: bool,
    ) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let stored = self
            .snapshots_internal()?
            .into_iter()
            .find(|s| s.module == snapshot.module && s.id == snapshot.id)
            .context("The snapshot is unavailable")?;
        ensure!(stored.expires > Utc::now(), "The snapshot has expired");
        let module = stored
            .previous
            .context("This snapshot contains no previous module data")?;
        ensure!(
            typed_name == module.manifest.name && acknowledge_data_loss,
            "Confirm the module name and that newer writes will be lost"
        );
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let backup = self.lifecycle.snapshot(&snapshot.module)?;
        self.begin_change(&snapshot.module, &backup, Some(module.digest.clone()))?;
        self.lifecycle.pause_jobs(&snapshot.module)?;
        let outcome = (|| {
            self.lifecycle.restore(&snapshot.module, &snapshot.id)?;
            let package = self.read_package(&module.digest)?;
            let bytes = self.root.subdir("blobs/sha256")?.read(&module.digest)?;
            self.stage(&package, &bytes)?;
            state.retained.remove(&snapshot.module);
            state.installed.insert(snapshot.module.clone(), module);
            state.revision += 1;
            self.catalog.commit(revision, &state)
        })();
        self.complete_change(&snapshot.module, &backup, outcome)
    }
}
fn sync_directory(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        lifecycle::FileLifecycle,
        local::LocalPorts,
        runtime::{Host, Limits},
        sql::LegacyInventory,
        store::{CatalogStore, Lifecycle},
    };
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Memory(Mutex<State>);
    impl CatalogStore for Memory {
        fn load(&self) -> Result<State> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn commit(&self, expected: u64, next: &State) -> Result<()> {
            let mut s = self.0.lock().unwrap();
            ensure!(s.revision == expected, "Stale state");
            *s = next.clone();
            Ok(())
        }
    }
    #[test]
    fn startup_recovers_uncommitted_changes_but_keeps_committed_purge_and_expires_snapshots() {
        let data = tempfile::tempdir().unwrap();
        let actor = uuid::Uuid::new_v4();
        let access = AccessContext::new(actor, "recovery");
        let catalog = Arc::new(Memory::default());
        let lifecycle = Arc::new(FileLifecycle::new(data.path(), [actor].into()).unwrap());
        let open = || {
            Installer::new(
                data.path(),
                catalog.clone(),
                lifecycle.clone(),
                Host::new(Limits::default()).unwrap(),
                Arc::new(LocalPorts::new(data.path()).unwrap()),
                "0.1.0".parse().unwrap(),
                LegacyInventory::default(),
            )
            .unwrap()
        };
        let installer = open();
        let files = vault::Root::create(&data.path().join("modules/files/sample.data")).unwrap();
        files.write("account.json", b"before").unwrap();
        let snapshot = lifecycle.snapshot("sample.data").unwrap();
        installer
            .begin_change("sample.data", &snapshot, Some("a".repeat(64)))
            .unwrap();
        files
            .write("account.json", b"interrupted migration")
            .unwrap();
        drop(installer);
        let installer = open();
        assert_eq!(files.read("account.json").unwrap(), b"before");
        assert!(!data.path().join("modules/operation.json").exists());
        let snapshot = lifecycle.snapshot("sample.data").unwrap();
        installer
            .begin_change("sample.data", &snapshot, None)
            .unwrap();
        lifecycle.purge("sample.data").unwrap();
        let mut committed = catalog.load().unwrap();
        committed.revision += 1;
        catalog.commit(0, &committed).unwrap();
        drop(installer);
        let installer = open();
        assert!(!data.path().join("modules/files/sample.data").exists());
        assert_eq!(installer.snapshots(&access).unwrap().len(), 2);
        installer
            .expire_snapshots(&access, Utc::now() + Duration::days(31))
            .unwrap();
        assert!(installer.snapshots(&access).unwrap().is_empty());
    }
}
