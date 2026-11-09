//! What a running server tells the connecting app.
//!
//! A local server writes `running.json` in its instance folder while it listens. The app reads
//! it to find and trust the local server. Remote servers answer `GET /api/hello` instead.

use crate::config::{private_read, private_write};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};

pub const RUNNING_FILE: &str = "running.json";
pub const NETWORK_FILE: &str = "network.json";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The native calls the app makes. Screens are served by the server and are not counted.
pub const API: ApiRange = ApiRange {
    current: 1,
    oldest: 1,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiRange {
    pub current: u32,
    pub oldest: u32,
}

impl ApiRange {
    pub fn overlaps(self, other: ApiRange) -> bool {
        self.oldest <= self.current
            && other.oldest <= other.current
            && self.oldest <= other.current
            && other.oldest <= self.current
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub product: String,
    pub version: String,
    pub api: ApiRange,
}

pub fn hello() -> Hello {
    Hello {
        product: "moss".into(),
        version: VERSION.into(),
        api: API,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Running {
    pub instance: String,
    pub origin: String,
    pub fingerprint: String,
    pub pid: u32,
    pub version: String,
    pub api: ApiRange,
}

impl Running {
    pub fn read(folder: &Path) -> Result<Self, String> {
        let bytes = private_read(&folder.join(RUNNING_FILE))?;
        serde_json::from_slice(&bytes).map_err(|_| "Invalid running file".into())
    }

    pub fn write(&self, folder: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "Cannot encode running file")?;
        private_write(&folder.join(RUNNING_FILE), &bytes)
    }

    /// Removes the file only while it still names this process, so a newer server's file
    /// survives an older one shutting down.
    pub fn remove_if_ours(folder: &Path) {
        let path = folder.join(RUNNING_FILE);
        if Self::read(folder).is_ok_and(|r| r.pid == std::process::id()) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// SHA-256 of a DER certificate, in the format the Sharing screen shows.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(": ")
}

/// The first certificate in a PEM file, which is the leaf the server presents.
pub fn leaf_der(pem: &[u8]) -> Result<Vec<u8>, String> {
    CertificateDer::pem_slice_iter(pem)
        .next()
        .ok_or("Invalid public certificate")?
        .map(|c| c.as_ref().to_vec())
        .map_err(|_| "Invalid public certificate".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(oldest: u32, current: u32) -> ApiRange {
        ApiRange { current, oldest }
    }

    #[test]
    fn api_ranges_overlap_only_when_they_share_a_number() {
        assert!(range(1, 1).overlaps(range(1, 1)));
        assert!(range(1, 3).overlaps(range(3, 5)));
        assert!(!range(1, 2).overlaps(range(3, 4)));
        assert!(!range(3, 4).overlaps(range(1, 2)));
        assert!(!range(2, 1).overlaps(range(1, 2)));
    }

    #[test]
    fn fingerprint_matches_the_sharing_screen_format() {
        let f = fingerprint(b"");
        assert!(f.starts_with("E3: B0: C4: 42"));
        assert_eq!(f.split(": ").count(), 32);
    }

    #[test]
    fn running_file_is_owner_only_and_removed_only_by_its_server() {
        let dir = std::env::temp_dir().join(format!("moss-running-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let mut running = Running {
            instance: "default".into(),
            origin: "https://127.0.0.1:5201".into(),
            fingerprint: fingerprint(b"x"),
            pid: std::process::id() + 1,
            version: VERSION.into(),
            api: API,
        };
        running.write(&dir).unwrap();
        assert_eq!(Running::read(&dir).unwrap(), running);
        Running::remove_if_ours(&dir);
        assert!(dir.join(RUNNING_FILE).exists(), "another server's file was removed");
        running.pid = std::process::id();
        running.write(&dir).unwrap();
        Running::remove_if_ours(&dir);
        assert!(!dir.join(RUNNING_FILE).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
