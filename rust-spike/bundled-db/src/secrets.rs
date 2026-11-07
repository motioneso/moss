//! Database passwords. The spike keeps each one in an owner-only file under the install root.
//! The product keeps them in the OS key store (Phase 0b), never in a file beside the data.

use std::fmt;
use std::io::{self, Write};
use std::path::Path;

use rand::RngCore;

use crate::layout::{private_file, Layout};

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
    let path = layout.secrets.join(role);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Secret(text.trim().to_string())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => create(&path),
        Err(error) => Err(error),
    }
}

/// Reads the password for `role`, which must already exist.
pub fn existing(layout: &Layout, role: &str) -> Result<Secret, String> {
    std::fs::read_to_string(layout.secrets.join(role))
        .map(|text| Secret(text.trim().to_string()))
        .map_err(|e| format!("password for {role}: {e}"))
}

fn create(path: &Path) -> io::Result<Secret> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let value = hex::encode(bytes);
    let mut file = private_file(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    Ok(Secret(value))
}
