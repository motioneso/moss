//! Reads stored recording audio from the account's own Meetings files folder. Every chunk is
//! checked against the size and hash saved with it, so a damaged file fails the export instead
//! of shipping bad bytes.
use access_context::AccessContext;
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use moss_meetings_module::ring_errors::Invalid;
use moss_meetings_module::ring_source::{
    chunk_length, sidecar_metadata, wav_duration, PacketValidator, CHUNK, DURATION_MAX_MS, SIDECAR_MAX,
};
use serde_json::{json, Value};
use vault::{Root, VaultContext};

/// Longest transcription window. Its base64 audio plus the request stays under 1 MiB.
pub const WINDOW_MAX_MS: u64 = 20_000;

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


    fn chunk_path(import: &str, kind: &str, index: u64) -> String {
        format!("{}/{kind}/{index}.bin", Self::dir(import))
    }

    /// Reads one kind back in order, checks its length and hash against the manifest, and hands
    /// each chunk to `each`. The first 44 bytes come back as the header.
    fn replay(
        &self,
        access: &AccessContext,
        import: &str,
        kind: &str,
        file: &(u64, String),
        mut each: impl FnMut(&[u8]) -> Result<(), Invalid>,
    ) -> Result<std::result::Result<Vec<u8>, Invalid>> {
        let account = self.account(access)?;
        let mut hash = Sha256::new();
        let mut head = Vec::new();
        for index in 0..file.0.div_ceil(CHUNK) {
            let bytes = account.read(&Self::chunk_path(import, kind, index))?;
            let Ok(expected) = chunk_length(file.0, index) else { return Ok(Err(Invalid(400))) };
            if bytes.len() as u64 != expected {
                return Ok(Err(Invalid(400)));
            }
            hash.update(&bytes);
            if head.len() < 44 {
                head.extend_from_slice(&bytes[..bytes.len().min(44 - head.len())]);
            }
            if let Err(error) = each(&bytes) {
                return Ok(Err(error));
            }
        }
        if hex(&hash.finalize()) != file.1 {
            return Ok(Err(Invalid(400)));
        }
        Ok(Ok(head))
    }

    /// Checks a finished upload: hashes, packet framing, WAV header and sidecar. The answer
    /// carries only numbers, never audio.
    pub fn validate(&self, access: &AccessContext, import: &str, manifest: &str) -> Result<Value> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        let manifest: Value = serde_json::from_str(manifest)?;
        let read = |kind: &str| -> Result<(u64, String)> {
            Ok((
                manifest[kind]["byteLength"].as_u64().ok_or_else(|| anyhow::anyhow!("Bad manifest"))?,
                manifest[kind]["sha256"].as_str().ok_or_else(|| anyhow::anyhow!("Bad manifest"))?.to_owned(),
            ))
        };
        let (packets, sidecar, wav) = (read("packets")?, read("sidecar")?, read("wav")?);
        let refuse = |error: Invalid| json!({"ok": false, "status": error.0});
        let mut framing = PacketValidator::default();
        match self.replay(access, import, "packets", &packets, |bytes| framing.push(bytes))? {
            Ok(_) => {}
            Err(error) => return Ok(refuse(error)),
        }
        if let Err(error) = framing.finish() {
            return Ok(refuse(error));
        }
        let head = match self.replay(access, import, "wav", &wav, |_| Ok(()))? {
            Ok(head) => head,
            Err(error) => return Ok(refuse(error)),
        };
        let duration = match wav_duration(&head, wav.0, DURATION_MAX_MS) {
            Ok(duration) => duration,
            Err(error) => return Ok(refuse(error)),
        };
        let mut side = Vec::new();
        match self.replay(access, import, "sidecar", &sidecar, |bytes| {
            side.extend_from_slice(bytes);
            Ok(())
        })? {
            Ok(_) => {}
            Err(error) => return Ok(refuse(error)),
        }
        Ok(match sidecar_metadata(&side, duration, SIDECAR_MAX, SIDECAR_MAX) {
            Ok(meta) => json!({
                "ok": true,
                "durationMs": duration,
                "startMs": meta.start_ms,
                "endMs": meta.end_ms,
                "recordedDurationMs": meta.recorded_duration_ms,
                "bookmarksMs": meta.bookmarks_ms,
            }),
            Err(error) => refuse(error),
        })
    }

    /// One transcription window as a small WAV, base64 encoded. Windows are short enough that
    /// the encoded audio fits one module message.
    pub fn window(&self, access: &AccessContext, import: &str, start_ms: u64, length_ms: u64, total_ms: u64) -> Result<Value> {
        ensure!(uuid::Uuid::parse_str(import).is_ok(), "Invalid import id");
        ensure!(length_ms > 0 && length_ms <= WINDOW_MAX_MS, "Window too long");
        ensure!(start_ms < total_ms, "Window starts after the recording");
        let end_ms = (start_ms + length_ms).min(total_ms);
        let (from, to) = (44 + start_ms * 32, 44 + end_ms * 32);
        let account = self.account(access)?;
        let mut pcm = Vec::with_capacity((to - from) as usize);
        let mut at = from;
        while at < to {
            let (index, offset) = (at / CHUNK, (at % CHUNK) as usize);
            let bytes = account.read(&Self::chunk_path(import, "wav", index))?;
            let take = ((to - at) as usize).min(bytes.len().saturating_sub(offset));
            ensure!(take > 0, "A stored recording chunk is too short");
            pcm.extend_from_slice(&bytes[offset..offset + take]);
            at += take as u64;
        }
        let mut wav = Vec::with_capacity(44 + pcm.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&[1, 0, 1, 0]);
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&[2, 0, 16, 0]);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);
        Ok(json!({"audio": STANDARD.encode(wav), "startMs": start_ms, "endMs": end_ms, "last": end_ms >= total_ms}))
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
