//! The backup ledger: one record per archive, kept beside the archives in `ledger.json`.
//!
//! Every change takes `ledger.lock` and replaces the file whole, so a crash leaves either the
//! old ledger or the new one.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::{backups_dir, create_private_dir, ARCHIVE_SUFFIX};

pub const LEDGER_FILE: &str = "ledger.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub created_at: u64,
    pub size: u64,
    pub sha256: String,
    pub verified: bool,
    pub verified_at: Option<u64>,
    pub pinned: bool,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "createdAt": self.created_at,
            "file": format!("{}{ARCHIVE_SUFFIX}", self.id),
            "size": self.size,
            "sha256": self.sha256,
            "verified": self.verified,
            "verifiedAt": self.verified_at,
            "pinned": self.pinned,
        })
    }

    fn from_json(value: &Value) -> Option<Entry> {
        let id = value["id"].as_str()?.to_owned();
        if !crate::valid_id(&id) {
            return None;
        }
        Some(Entry {
            id,
            created_at: value["createdAt"].as_u64()?,
            size: value["size"].as_u64()?,
            sha256: value["sha256"].as_str()?.to_owned(),
            verified: value["verified"].as_bool()?,
            verified_at: value["verifiedAt"].as_u64(),
            pinned: value["pinned"].as_bool()?,
        })
    }
}

pub fn archive_path(instance: &Path, id: &str) -> PathBuf {
    backups_dir(instance).join(format!("{id}{ARCHIVE_SUFFIX}"))
}

fn read(path: &Path) -> Result<Vec<Entry>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("ledger: {error}")),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "the ledger is damaged")?;
    value["backups"]
        .as_array()
        .ok_or("the ledger is damaged")?
        .iter()
        .map(|v| Entry::from_json(v).ok_or_else(|| "the ledger has a damaged record".to_string()))
        .collect()
}

fn write(path: &Path, entries: &[Entry]) -> Result<(), String> {
    let body = json!({
        "kind": "moss-backup-ledger",
        "version": 1,
        "backups": entries.iter().map(Entry::to_json).collect::<Vec<_>>(),
    });
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = crate::create_private_file(&temporary).map_err(|e| format!("ledger: {e}"))?;
    file.write_all(&serde_json::to_vec_pretty(&body).unwrap())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("ledger: {e}"))?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|e| format!("ledger: {e}"))
}

/// Reads the ledger, lets `change` edit it, and writes it back, all under the ledger lock.
pub fn update<T>(
    instance: &Path,
    change: impl FnOnce(&mut Vec<Entry>) -> Result<T, String>,
) -> Result<T, String> {
    let dir = backups_dir(instance);
    create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(dir.join("ledger.lock"))
        .map_err(|e| format!("ledger lock: {e}"))?;
    portability::file_lock::exclusive(&lock).map_err(|e| format!("ledger lock: {e}"))?;
    let path = dir.join(LEDGER_FILE);
    let mut entries = read(&path)?;
    let before = entries.clone();
    let result = change(&mut entries)?;
    if entries != before {
        write(&path, &entries)?;
    }
    Ok(result)
}

pub fn list(instance: &Path) -> Result<Vec<Entry>, String> {
    update(instance, |entries| Ok(entries.clone()))
}

pub fn find(instance: &Path, id: &str) -> Result<Entry, String> {
    list(instance)?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("no backup {id} in the ledger"))
}

pub fn set_pinned(instance: &Path, id: &str, pinned: bool) -> Result<(), String> {
    update(instance, |entries| {
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| format!("no backup {id} in the ledger"))?;
        entry.pinned = pinned;
        Ok(())
    })
}

pub fn set_verified(instance: &Path, id: &str, verified: bool) -> Result<(), String> {
    update(instance, |entries| {
        if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
            entry.verified = verified;
            entry.verified_at = verified.then(crate::now_seconds);
        }
        Ok(())
    })
}

/// Applies retention. Deletes the dropped archives, then their records. Returns the ids removed.
pub fn prune(instance: &Path) -> Result<Vec<String>, String> {
    update(instance, |entries| {
        let candidates: Vec<crate::retention::Candidate> = entries
            .iter()
            .map(|e| crate::retention::Candidate {
                id: &e.id,
                created_at: e.created_at,
                pinned: e.pinned,
                verified: e.verified,
            })
            .collect();
        let keep = crate::retention::keep(&candidates);
        let mut removed = Vec::new();
        for entry in entries.iter().filter(|e| !keep.contains(&e.id)) {
            match std::fs::remove_file(archive_path(instance, &entry.id)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("delete backup {}: {error}", entry.id)),
            }
            removed.push(entry.id.clone());
        }
        entries.retain(|e| keep.contains(&e.id));
        Ok(removed)
    })
}
