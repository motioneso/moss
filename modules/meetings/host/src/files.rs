//! Recording file storage for ring uploads. The module decides what may be stored. This side
//! holds the staged request bytes, which never enter the module, and writes them under the
//! owner's own folder.
use crate::recordings::Recordings;
use anyhow::{ensure, Result};
use moss_module_host::runtime::CallScope;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const FILES: &str = "meetings.recording-files";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub key: Option<String>,
    pub import_id: Option<String>,
    pub kind: Option<String>,
    pub index: Option<i32>,
    pub bytes: Option<usize>,
    pub sha256: Option<String>,
    pub manifest: Option<String>,
}

fn need<T>(value: Option<T>, what: &str) -> Result<T> {
    value.ok_or_else(|| anyhow::anyhow!("{what} required"))
}

/// Operations that touch only files. `lock` needs the database and lives with the caller.
pub fn run(files: &Recordings, scope: &CallScope, operation: &str, p: &Params) -> Result<Value> {
    let access = scope.access();
    match operation {
        "prepare" => {
            files.prepare(access, &need(p.import_id.as_deref(), "Import id")?, &need(p.manifest.as_deref(), "Manifest")?)?;
            Ok(json!({"prepared": true}))
        }
        "put" => {
            let staged = moss_module_host::staged::get(access.request_id())
                .ok_or_else(|| anyhow::anyhow!("No staged bytes for this request"))?;
            let sha = need(p.sha256.as_deref(), "Hash")?;
            ensure!(staged.len() == need(p.bytes, "Length")?, "Staged length differs");
            let actual: String = Sha256::digest(staged.as_slice()).iter().map(|b| format!("{b:02x}")).collect();
            ensure!(actual == sha, "Staged hash differs");
            files.put(
                access,
                &need(p.import_id.as_deref(), "Import id")?,
                &need(p.kind.as_deref(), "Kind")?,
                need(p.index, "Index")?,
                &staged,
            )?;
            Ok(json!({"stored": true}))
        }
        "purge" => {
            files.purge(access, &need(p.import_id.as_deref(), "Import id")?)?;
            Ok(json!({"purged": true}))
        }
        _ => anyhow::bail!("Unsupported Meetings file operation"),
    }
}
