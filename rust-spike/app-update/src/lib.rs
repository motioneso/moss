//! Read-only app-update preflight. No server control or version switching lives here.
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

// Compile the registry's canonical primitives without pulling in its Wasm runtime.
#[path = "../../module-host/src/trust_crypto.rs"]
pub mod trust;

pub const MAX_INDEX: usize = 8 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub os: String,
    pub arch: String,
    pub version: String,
    pub url: String,
    pub digest: String,
    pub size: u64,
    pub schema_min: u64,
    pub schema_max: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub serial: u64,
    pub expires: DateTime<Utc>,
    pub signing_key: String,
    pub artifacts: Vec<Artifact>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Seen {
    pub serial: u64,
    pub index_digest: String,
    pub key_fingerprint: String,
}
pub struct Client {
    pub key_id: String,
    /// Installed trust, never a key taken from the feed.
    pub public_key: String,
    pub os: String,
    pub arch: String,
    pub schema: u64,
}
impl Client {
    /// Verifies exact signed bytes, then serial, expiry and local compatibility.
    /// The caller must durably save `next` before offering this release. On refusal
    /// the old record remains unchanged. Neither this method nor the CLI stops servers.
    pub fn check(
        &self,
        bytes: &[u8],
        signature: &str,
        seen: &Seen,
        now: DateTime<Utc>,
    ) -> Result<(Artifact, Seen)> {
        ensure!(bytes.len() <= MAX_INDEX, "Update index is too large");
        trust::verify(&self.public_key, bytes, signature)?;
        let index: Index = serde_json::from_slice(bytes)?;
        ensure!(
            index.signing_key == self.key_id,
            "Untrusted app update signing key"
        );
        let fingerprint = trust::digest(self.public_key.as_bytes());
        ensure!(
            seen.key_fingerprint.is_empty() || seen.key_fingerprint == fingerprint,
            "App update trust changed"
        );
        ensure!(index.serial >= seen.serial, "Older app update serial");
        let digest = trust::digest(bytes);
        ensure!(
            index.serial != seen.serial
                || seen.index_digest.is_empty()
                || seen.index_digest == digest,
            "App update serial reused"
        );
        ensure!(index.expires > now, "App update index expired");
        let mut targets = BTreeSet::new();
        for artifact in &index.artifacts {
            ensure!(
                matches!(artifact.os.as_str(), "linux" | "macos" | "windows")
                    && matches!(artifact.arch.as_str(), "x86_64" | "aarch64"),
                "Unsupported app update target"
            );
            ensure!(
                targets.insert((&artifact.os, &artifact.arch)),
                "Duplicate app update target"
            );
            ensure!(
                trust::valid_digest(&artifact.digest) && artifact.size > 0,
                "Invalid app update digest or size"
            );
            ensure!(
                artifact.schema_min <= artifact.schema_max,
                "Invalid app update schema range"
            );
            ensure!(
                artifact.url.starts_with("https://") && !artifact.version.is_empty(),
                "Invalid app update location or version"
            );
        }
        let artifact = index
            .artifacts
            .iter()
            .find(|a| a.os == self.os && a.arch == self.arch)
            .context("No app update for this OS and architecture")?;
        ensure!(
            (artifact.schema_min..=artifact.schema_max).contains(&self.schema),
            "App update cannot read this schema"
        );
        Ok((
            artifact.clone(),
            Seen {
                serial: index.serial,
                index_digest: digest,
                key_fingerprint: fingerprint,
            },
        ))
    }
}
impl Artifact {
    /// Recheck bytes supplied by the future downloader before staging them.
    pub fn verify_bytes(&self, bytes: &[u8]) -> Result<()> {
        ensure!(
            bytes.len() as u64 == self.size && trust::digest(bytes) == self.digest,
            "App update artifact hash mismatch"
        );
        Ok(())
    }
}
/// Fail closed on corrupt/unreadable state; only a genuinely new installation starts at zero.
pub fn load_seen(path: &Path) -> Result<Seen> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Seen::default()),
        Err(e) => Err(e.into()),
    }
}
/// Atomic replacement on all supported platforms. Callers serialize checks for a
/// single trust domain using an exclusive lock; readers never reset on parse errors.
pub fn save_seen(path: &Path, seen: &Seen) -> Result<()> {
    use std::io::Write;
    let next = path.with_extension("next");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(&next)?;
    file.write_all(&serde_json::to_vec(seen)?)?;
    file.sync_all()?;
    fs::rename(&next, path)?;
    #[cfg(unix)]
    fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}
