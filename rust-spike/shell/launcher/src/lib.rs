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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selector_uses_one_retained_version_and_refuses_paths() {
        let root = std::env::temp_dir().join(format!("moss versions {}", uuid::Uuid::new_v4()));
        for version in ["7.0.0", "7.1.0"] {
            std::fs::create_dir_all(root.join("versions").join(version)).unwrap();
        }
        for version in ["7.0.0", "7.1.0"] {
            std::fs::write(root.join("current"), version).unwrap();
            assert_eq!(
                current(&root).unwrap(),
                root.canonicalize().unwrap().join("versions").join(version)
            );
        }
        for invalid in [
            "",
            ".",
            "..",
            "../7.0.0",
            "versions/7.0.0",
            "/7.0.0",
            "7.0.0\\bad",
            "7.0.0\nignored",
        ] {
            std::fs::write(root.join("current"), invalid).unwrap();
            assert!(current(&root).is_err(), "accepted {invalid:?}");
        }
        assert!(root.join("versions/7.0.0").is_dir());
        assert!(root.join("versions/7.1.0").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn service_identity_includes_the_entire_instance_path() {
        assert_eq!(
            service::name(Path::new("/one/default")),
            service::name(Path::new("/one/default"))
        );
        assert_ne!(
            service::name(Path::new("/one/default")),
            service::name(Path::new("/two/default"))
        );
        assert_ne!(
            service::name(Path::new("/one/default")),
            service::name(Path::new("/one/test"))
        );
    }
}
