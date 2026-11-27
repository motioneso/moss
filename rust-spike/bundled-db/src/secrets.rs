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
        // Windows pins existing ancestors rather than manufacturing them.
        std::fs::create_dir(&instance).unwrap();
        let layout = Layout::create(&instance.join("database")).unwrap();
        let secret = password(&layout, crate::SUPERUSER).unwrap();
        // Migration runs between supervisor lifetimes. Release the Windows
        // ancestor pins before recording setup, then reopen the real reader.
        drop(layout);
        std::fs::write(instance.join("credentials.json"), b"{}").unwrap();
        let key = scratch.path().join("headless.key");
        let mut store = KeyFileStore::new(key.clone());
        record_key_file_choice(&instance, &key).unwrap();
        let service = keystore::platform::service_name("instance");
        prepare_instance(&instance, &mut store, &service)
            .unwrap()
            .commit_with(&mut store, &service)
            .unwrap();
        let layout = Layout::open(&instance.join("database")).unwrap();
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
        drop(layout);
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_migration_works_while_another_process_pins_the_database_layout() {
        use std::process::{Command, Stdio};
        let scratch = tempfile::tempdir().unwrap();
        let instance = scratch.path().join("instance");
        std::fs::create_dir(&instance).unwrap();
        let layout = Layout::create(&instance.join("database")).unwrap();
        let secret = password(&layout, crate::SUPERUSER).unwrap();
        drop(layout);
        std::fs::write(instance.join("credentials.json"), b"{}").unwrap();
        let ready = scratch.path().join("ready");
        let stop = scratch.path().join("stop");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "secrets::custody_tests::hold_windows_layout",
                "--test-threads=1",
            ])
            .env("MOSS_CUSTODY_PIN_ROOT", instance.join("database"))
            .env("MOSS_CUSTODY_PIN_READY", &ready)
            .env("MOSS_CUSTODY_PIN_STOP", &stop)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        struct Child(std::process::Child, std::path::PathBuf);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = std::fs::write(&self.1, b"stop");
                let _ = self.0.wait();
            }
        }
        let mut child = Child(child, stop);
        let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "pin holder exited early"
            );
            assert!(
                std::time::Instant::now() < until,
                "pin holder did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let mut store = keystore::platform::platform_store();
        let service = keystore::platform::service_name("instance");
        let result = (|| {
            let prepared = prepare_instance(&instance, store.as_mut(), &service)?;
            prepared.commit_with(store.as_mut(), &service)?;
            Ok::<(), keystore::custody::CustodyError>(())
        })();
        if result.is_ok() {
            let layout = Layout::open(&instance.join("database")).unwrap();
            assert!(existing(&layout, crate::SUPERUSER).unwrap().expose() == secret.expose());
            assert!(!layout.secrets.join(crate::SUPERUSER).exists());
            drop(layout);
        }
        store.delete_master(&service).unwrap();
        assert!(
            result.is_ok(),
            "DPAPI migration failed while database ancestors were pinned: {:?}",
            result.err()
        );
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "pin holder must span the migration"
        );
        drop(child);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "spawned by the separate-process pinning test"]
    fn hold_windows_layout() {
        let root = std::env::var_os("MOSS_CUSTODY_PIN_ROOT").unwrap();
        let ready = std::env::var_os("MOSS_CUSTODY_PIN_READY").unwrap();
        let stop = std::env::var_os("MOSS_CUSTODY_PIN_STOP").unwrap();
        let layout = Layout::open(std::path::Path::new(&root)).unwrap();
        std::fs::write(ready, b"ready").unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(45);
        while !std::path::Path::new(&stop).exists() {
            assert!(std::time::Instant::now() < until, "pin holder timed out");
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        drop(layout);
    }
}
