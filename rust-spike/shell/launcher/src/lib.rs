//! Stable program selection and per-instance, ordinary-user login services.
pub mod database;
pub mod runtime;
pub mod service;
use std::path::{Path, PathBuf};

/// The selector is a single version name, never a path supplied to a shell.
pub fn current(root: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "Missing Moss program folder")?;
    let version = std::fs::read_to_string(root.join("current"))
        .map_err(|_| "Cannot read the current Moss version")?;
    let version = version.trim();
    if version.is_empty()
        || version.len() > 100
        || version == "."
        || version == ".."
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
    {
        return Err("Invalid Moss version selector".into());
    }
    let folder = root.join("versions").join(version);
    let real = folder
        .canonicalize()
        .map_err(|_| "Missing Moss program version")?;
    if real != folder || !real.is_dir() {
        return Err("Moss version must be a real program folder".into());
    }
    Ok(real)
}

/// Installed versions use the stable launcher above versions/. Development uses a local one.
pub fn launcher(install: &Path) -> PathBuf {
    let name = format!("moss-launcher{}", std::env::consts::EXE_SUFFIX);
    if install
        .parent()
        .is_some_and(|p| p.file_name().is_some_and(|n| n == "versions"))
    {
        install.parent().unwrap().parent().unwrap().join(name)
    } else {
        install.join(name)
    }
}
