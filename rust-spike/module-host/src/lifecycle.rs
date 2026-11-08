//! Unprivileged file lifecycle for modules with no SQL. Database-owning packages require a
//! migration service; this implementation refuses them rather than pretending they ran.
use crate::{
    archive::Package,
    store::{Installed, Lifecycle},
};
use access_context::AccessContext;
use anyhow::{ensure, Result};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct FileLifecycle {
    data: PathBuf,
    admins: BTreeSet<uuid::Uuid>,
    paused: Mutex<BTreeSet<String>>,
}
impl FileLifecycle {
    pub fn new(data: &Path, admins: BTreeSet<uuid::Uuid>) -> Result<Self> {
        vault::Root::create(&data.join("modules/snapshots"))?;
        Ok(Self {
            data: data.into(),
            admins,
            paused: Mutex::new(BTreeSet::new()),
        })
    }
    fn files(&self, id: &str) -> PathBuf {
        self.data.join("modules/files").join(id)
    }
}
impl Lifecycle for FileLifecycle {
    fn is_admin(&self, access: &AccessContext) -> Result<bool> {
        Ok(self.admins.contains(&access.actor_user_id()))
    }
    fn pause_jobs(&self, id: &str) -> Result<()> {
        self.paused.lock().unwrap().insert(id.into());
        Ok(())
    }
    fn resume_jobs(&self, id: &str) -> Result<()> {
        self.paused.lock().unwrap().remove(id);
        Ok(())
    }
    fn snapshot(&self, id: &str) -> Result<String> {
        ensure!(crate::manifest::identifier(id), "Invalid module identifier");
        let name = uuid::Uuid::new_v4().to_string();
        let dest = self.data.join("modules/snapshots").join(id).join(&name);
        vault::Root::create(&dest)?;
        if self.files(id).exists() {
            copy_tree(&self.files(id), &dest.join("files"))?;
        }
        Ok(name)
    }
    fn migrate(&self, new: &Package, _old: Option<&Installed>) -> Result<()> {
        ensure!(
            new.manifest.database.migrations.is_empty()
                && new.manifest.database.owned_tables.is_empty(),
            "Database modules need the host's transactional migration service"
        );
        ensure!(
            new.manifest.jobs.is_empty(),
            "Scheduled modules need the host's queue lifecycle service"
        );
        Ok(())
    }
    fn restore(&self, id: &str, snapshot: &str) -> Result<()> {
        ensure!(
            crate::manifest::identifier(id) && uuid::Uuid::parse_str(snapshot).is_ok(),
            "Invalid snapshot name"
        );
        let files = self.files(id);
        if files.exists() {
            std::fs::remove_dir_all(&files)?;
        }
        let from = self
            .data
            .join("modules/snapshots")
            .join(id)
            .join(snapshot)
            .join("files");
        if from.exists() {
            copy_tree(&from, &files)?;
        }
        Ok(())
    }
    fn discard_snapshot(&self, id: &str, snapshot: &str) -> Result<()> {
        ensure!(
            crate::manifest::identifier(id) && uuid::Uuid::parse_str(snapshot).is_ok(),
            "Invalid snapshot identity"
        );
        let path = self.data.join("modules/snapshots").join(id).join(snapshot);
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
        Ok(())
    }
    fn purge(&self, id: &str) -> Result<()> {
        let files = self.files(id);
        if files.exists() {
            std::fs::remove_dir_all(files)?;
        }
        Ok(())
    }
}
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let root = vault::Root::open(from)?;
    let dest = vault::Root::create(to)?;
    for entry in root.list("")? {
        match entry.kind {
            vault::EntryKind::Dir => copy_tree(&from.join(&entry.name), &to.join(&entry.name))?,
            vault::EntryKind::File => dest.write(&entry.name, &root.read(&entry.name)?)?,
            _ => anyhow::bail!("A module data folder contains a link or special file"),
        }
    }
    Ok(())
}
