//! Database passwords. The spike keeps each one in an owner-only file under the install root.
//! The product keeps them in the OS key store (Phase 0a, fact 4), never in a file beside the data.

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
