//! Database passwords. Setup initially writes owner-only role files. Custody migration
//! moves them into the instance's wrapped bundle; Layout then reads through the key store.

use std::fmt;
use std::io::{self, Write};

use rand::RngCore;

use crate::layout::Layout;

/// A password that never prints. There is no `Display`, and `Debug` hides the value.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(hidden)")
    }
}

/// Reads the password for `role`, creating a random one the first time.
pub fn password(layout: &Layout, role: &str) -> io::Result<Secret> {
    match layout.read_secret(role) {
        Ok(text) => Ok(Secret(text.trim().to_string())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => create(layout, role),
        Err(error) => Err(error),
    }
}

/// Reads the password for `role`, which must already exist.
pub fn existing(layout: &Layout, role: &str) -> Result<Secret, String> {
    layout
        .read_secret(role)
        .map(|text| Secret(text.trim().to_string()))
        .map_err(|e| format!("password for {role}: {e}"))
}

fn create(layout: &Layout, role: &str) -> io::Result<Secret> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let value = hex::encode(bytes);
    let mut file = layout.create_secret(role)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    Ok(Secret(value))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn all_canonical_credentials_survive_reopening_and_refuse_unknown_names() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::create(&temp.path().join("install")).unwrap();
        for name in crate::RUNTIME_ROLES.into_iter().chain([
            crate::SUPERUSER,
            "session-signing-secret",
            "connector-key",
            "ai-key",
        ]) {
            let first = password(&layout, name).unwrap();
            assert_eq!(first.expose().len(), 64);
            assert!(first.expose() == existing(&layout, name).unwrap().expose());
            assert!(first.expose() == password(&layout, name).unwrap().expose());
        }
        assert!(password(&layout, "../escape").is_err());
        assert!(existing(&layout, "unknown").is_err());
    }
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use keystore::custody::{prepare_instance, record_key_file_choice, KeyFileStore};

    #[test]
    fn migrated_supervisor_reads_wrapped_role_credentials_without_recreating_files() {
        let scratch = tempfile::tempdir().unwrap();
        let instance = scratch.path().join("instance");
        let layout = Layout::create(&instance.join("database")).unwrap();
        let secret = password(&layout, crate::SUPERUSER).unwrap();
        std::fs::write(instance.join("credentials.json"), b"{}").unwrap();
        let key = scratch.path().join("headless.key");
        let mut store = KeyFileStore::new(key.clone());
        record_key_file_choice(&instance, &key).unwrap();
        let service = keystore::platform::service_name("instance");
        prepare_instance(&instance, &mut store, &service)
            .unwrap()
            .commit_with(&mut store, &service)
            .unwrap();
        assert!(!layout.secrets.join(crate::SUPERUSER).exists());
        assert!(existing(&layout, crate::SUPERUSER).unwrap().expose() == secret.expose());
        assert!(password(&layout, crate::SUPERUSER).unwrap().expose() == secret.expose());
        assert!(keystore::custody::find_plaintext(
            &instance,
            &[secret.expose().as_bytes().to_vec()]
        )
        .is_empty());
        std::fs::remove_file(key).unwrap();
        assert!(password(&layout, crate::SUPERUSER).is_err());
        assert!(!layout.secrets.join(crate::SUPERUSER).exists());
    }
}
