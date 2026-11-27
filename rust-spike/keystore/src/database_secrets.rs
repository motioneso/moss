//! Database supervisor credentials travel in the instance's wrapped bundle.
use crate::custody::{self, CustodyError};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

pub(crate) const NAMES: [&str; 8] = [
    "moss_admin",
    "jarvis_migration_owner",
    "jarvis_app_runtime",
    "jarvis_worker_runtime",
    "jarvis_auth_runtime",
    "session-signing-secret",
    "connector-key",
    "ai-key",
];

pub(crate) fn collect(
    root: &Path,
    previous: Option<&Value>,
) -> Result<BTreeMap<String, String>, CustodyError> {
    let mut values: BTreeMap<String, String> = previous
        .and_then(|v| v.get("database_secrets"))
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|_| CustodyError::Damaged("invalid database credentials".into()))?
        .unwrap_or_default();
    for folder in [root.join("database"), root.join("database/secrets")] {
        match fs::symlink_metadata(folder) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => {
                return Err(CustodyError::Damaged(
                    "database secrets must be in real folders".into(),
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(CustodyError::Io(e.to_string())),
        }
    }
    for name in NAMES {
        let path = root.join("database/secrets").join(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_file() => {
                if meta.len() > 256 {
                    return Err(CustodyError::Damaged(
                        "invalid database credential file".into(),
                    ));
                }
                let value =
                    fs::read_to_string(&path).map_err(|e| CustodyError::Io(e.to_string()))?;
                if value.len() > 256 || value.trim().is_empty() {
                    return Err(CustodyError::Damaged(
                        "invalid database credential file".into(),
                    ));
                }
                values.insert(name.into(), value.trim().into());
            }
            Ok(_) => {
                return Err(CustodyError::Damaged(
                    "database credential must be a regular file".into(),
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(CustodyError::Io(e.to_string())),
        }
    }
    if values.keys().any(|name| !NAMES.contains(&name.as_str())) {
        return Err(CustodyError::Damaged("unknown database credential".into()));
    }
    Ok(values)
}

pub(crate) fn remove(root: &Path, values: &BTreeMap<String, String>) -> Result<(), CustodyError> {
    for name in values.keys() {
        match fs::remove_file(root.join("database/secrets").join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(CustodyError::Io(e.to_string())),
        }
    }
    custody::sync_folder(&root.join("database/secrets"));
    Ok(())
}

pub(crate) fn restore(root: &Path, values: &BTreeMap<String, String>) -> Result<(), CustodyError> {
    for (name, value) in values {
        custody::write_private(&root.join("database/secrets").join(name), value.as_bytes())?;
    }
    Ok(())
}

/// Reads one database supervisor credential after migration. No plaintext file fallback.
pub fn read(root: &Path, name: &str) -> Result<String, CustodyError> {
    if !NAMES.contains(&name) {
        return Err(CustodyError::Damaged("unknown database credential".into()));
    }
    let service = root
        .file_name()
        .and_then(|s| s.to_str())
        .map(crate::platform::service_name)
        .ok_or_else(|| CustodyError::Damaged("invalid instance folder".into()))?;
    let store = crate::platform::platform_store();
    let choice = custody::recorded_key_file(root);
    let master = custody::load_master(store.as_ref(), &service, choice.as_deref())?;
    let bundle = custody::read_bundle(root)?;
    let payload: Value = serde_json::from_slice(&custody::unwrap_with_master(&bundle, &master)?)
        .map_err(|_| CustodyError::Damaged("invalid bundle credentials".into()))?;
    payload
        .get("database_secrets")
        .and_then(|v| v.get(name))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CustodyError::Damaged("database credential missing from bundle".into()))
}
