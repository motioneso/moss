//! Reads stored recording audio from the account's own Meetings files folder. Every chunk is
//! checked against the size and hash saved with it, so a damaged file fails the export instead
//! of shipping bad bytes.
use access_context::AccessContext;
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use vault::{Root, VaultContext};

pub struct Recordings {
    root: Root,
}

impl Recordings {
    /// `files` is the host's module files folder. Meetings keeps its audio under its own
    /// account subfolder, in the same place its file port writes.
    pub fn new(files: &Root) -> Result<Self> {
        Ok(Self { root: files.create_subdir("meetings")? })
    }

    fn account(&self, access: &AccessContext) -> Result<VaultContext> {
        Ok(VaultContext::for_module_files(&self.root, access)?)
    }

    pub fn chunk(
        &self,
        access: &AccessContext,
        import: &str,
        kind: &str,
        index: i32,
        length: i32,
        sha256: &str,
    ) -> Result<String> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        ensure!(["packets", "sidecar", "wav"].contains(&kind), "Invalid chunk kind");
        ensure!(index >= 0, "Invalid chunk index");
        let bytes = self
            .account(access)?
            .read(&format!("vault/meeting-recordings/{import}/{kind}/{index}.bin"))?;
        ensure!(bytes.len() as i64 == i64::from(length), "A stored recording chunk has the wrong size");
        ensure!(
            hex(&Sha256::digest(&bytes)) == sha256,
            "A stored recording chunk does not match its saved hash"
        );
        Ok(STANDARD.encode(bytes))
    }

    fn dir(import: &str) -> String {
        format!("vault/meeting-recordings/{import}")
    }

    /// Creates the folders for one upload and keeps its manifest beside the chunks.
    pub fn prepare(&self, access: &AccessContext, import: &str, manifest: &str) -> Result<()> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        let account = self.account(access)?;
        for dir in ["vault", "vault/meeting-recordings"].into_iter().map(str::to_owned).chain(
            [String::new(), "/packets".into(), "/sidecar".into(), "/wav".into()]
                .into_iter()
                .map(|tail| format!("{}{tail}", Self::dir(import))),
        ) {
            // An existing folder is fine, a retry after a crash repeats these.
            let _ = account.create_dir(&dir);
        }
        account.write(&format!("{}/source.json", Self::dir(import)), manifest.as_bytes())?;
        Ok(())
    }

    /// Writes one chunk. A file already stored with the same bytes is left as it is.
    pub fn put(&self, access: &AccessContext, import: &str, kind: &str, index: i32, bytes: &[u8]) -> Result<()> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        ensure!(["packets", "sidecar", "wav"].contains(&kind), "Invalid chunk kind");
        ensure!(index >= 0, "Invalid chunk index");
        self.account(access)?
            .write(&format!("{}/{kind}/{index}.bin", Self::dir(import)), bytes)?;
        Ok(())
    }

    /// Deletes every stored file of one upload. Missing files are fine.
    pub fn purge(&self, access: &AccessContext, import: &str) -> Result<()> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        let account = self.account(access)?;
        let base = Self::dir(import);
        for kind in ["packets", "sidecar", "wav"] {
            for entry in account.list(&format!("{base}/{kind}")).unwrap_or_default() {
                let _ = account.remove(&format!("{base}/{kind}/{}", entry.name));
            }
        }
        let _ = account.remove(&format!("{base}/source.json"));
        let _ = account.remove(&format!("{base}/bundle.json"));
        Ok(())
    }

    pub fn bundle(&self, access: &AccessContext, import: &str) -> Result<String> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        Ok(self
            .account(access)?
            .read_to_string(&format!("vault/meeting-recordings/{import}/bundle.json"))?)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
