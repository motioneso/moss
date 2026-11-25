//! Private, atomic operation journal shared with the one-shot installer child.
use anyhow::{ensure, Context, Result};
use moss_network::config::{private_read, private_write};
use moss_shell_contract::module_management::{
    ModuleOperation, ModuleOperationResult, ModuleOperationStage,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecycleState>,
    pub source_binding: String,
    pub approved: bool,
    #[serde(default)]
    pub pin_after_install: bool,
    pub view: ModuleOperation,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct LifecycleState {
    pub typed_name: String,
    pub acknowledge_data_loss: bool,
    pub before_revision: Option<u64>,
    pub expected_digest: Option<String>,
}
fn folder(instance: &Path) -> Result<PathBuf> {
    let folder = instance.join("module-operations");
    std::fs::create_dir_all(&folder)?;
    Ok(folder)
}
fn path(instance: &Path, id: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(id).context("Invalid operation ID")?;
    ensure!(parsed.to_string() == id, "Invalid operation ID");
    Ok(folder(instance)?.join(format!("{id}.json")))
}
impl Record {
    pub fn read(instance: &Path, id: &str) -> Result<Self> {
        let bytes = private_read(&path(instance, id)?).map_err(anyhow::Error::msg)?;
        let record: Self = serde_json::from_slice(&bytes)?;
        ensure!(record.view.id == id, "Operation identity changed");
        Ok(record)
    }
    pub fn save(&self, instance: &Path) -> Result<()> {
        private_write(&path(instance, &self.view.id)?, &serde_json::to_vec(self)?)
            .map_err(anyhow::Error::msg)?;
        #[cfg(unix)]
        File::open(folder(instance)?)?.sync_all()?;
        Ok(())
    }
    pub fn stage(&mut self, instance: &Path, stage: ModuleOperationStage) -> Result<()> {
        self.view.stage = stage;
        if self.view.stages.last() != Some(&stage) {
            self.view.stages.push(stage);
        }
        self.save(instance)
    }
    pub fn finish(
        &mut self,
        instance: &Path,
        result: std::result::Result<&str, &str>,
    ) -> Result<()> {
        self.finish_with_recovery(instance, result, None)
    }
    pub fn finish_with_recovery(
        &mut self,
        instance: &Path,
        result: std::result::Result<&str, &str>,
        restored_version: Option<String>,
    ) -> Result<()> {
        self.view.stage = if result.is_ok() {
            ModuleOperationStage::Succeeded
        } else {
            ModuleOperationStage::Failed
        };
        self.view.stages.push(self.view.stage);
        self.view.result = Some(ModuleOperationResult {
            restored_version,
            ok: result.is_ok(),
            message: result.unwrap_or_else(|message| message).into(),
        });
        self.save(instance)
    }
}
/// Stable lock files are never replaced with journal records. File locks release on process death.
pub fn lock_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
pub fn operation_lock(instance: &Path, id: &str) -> Result<File> {
    let file = path(instance, id)?.with_extension("lock");
    lock_file(&file)
}
