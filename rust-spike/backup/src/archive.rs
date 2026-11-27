//! The encrypted backup archive.
//!
//! ```text
//! "MOSSBAK1" | u32 header length | header JSON
//! chunk*     = u32 ciphertext length | u8 final flag | AES-256-GCM ciphertext
//! ```
//!
//! Every archive has a fresh 256-bit data key. The header carries that key sealed by the
//! instance master key, and the instance key bundle verbatim, so the recovery words open the
//! master key and the master key opens the data key. The header holds no plaintext secret.
//!
//! Chunk `i` uses nonce `0000 || u64 i` and authenticates `sha256(magic|length|header) || i ||
//! final`. A changed, reordered, dropped or appended chunk, a changed header and a truncated
//! file all fail to open. Inside the chunks, the plaintext is a run of entries (roles, the
//! database dump, the files, the manifest, then an end marker):
//!
//! ```text
//! entry   = u8 kind | u16 name length | name | segment* | u32 0
//! segment = u32 length (non-zero) | bytes
//! ```

use std::io::{self, Read, Write};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use keystore::custody::MasterKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 8] = b"MOSSBAK1";
pub const KIND: &str = "moss-backup-archive";
pub const CHUNK_SIZE: usize = 1 << 20;
const MAX_HEADER: u32 = 1 << 20;

pub const ENTRY_ROLES: u8 = b'R';
pub const ENTRY_DUMP: u8 = b'D';
pub const ENTRY_FILE: u8 = b'F';
pub const ENTRY_MANIFEST: u8 = b'M';
pub const ENTRY_END: u8 = b'Z';

/// The per-archive data key. No Debug or Display.
pub struct DataKey([u8; 32]);

impl DataKey {
    pub fn generate() -> DataKey {
        DataKey(rand::random())
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for DataKey {
    fn drop(&mut self) {
        self.0 = [0; 32];
    }
}

fn data_key_aad(backup_id: &str) -> Vec<u8> {
    format!("moss-backup-data-key|{backup_id}").into_bytes()
}

fn seal_data_key(master: &MasterKey, backup_id: &str, key: &DataKey) -> Value {
    let nonce: [u8; 12] = rand::random();
    let sealed = Aes256Gcm::new(master.bytes().into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: key.bytes(),
                aad: &data_key_aad(backup_id),
            },
        )
        .expect("a 32-byte key always seals");
    json!({ "nonce": STANDARD.encode(nonce), "sealed": STANDARD.encode(sealed) })
}

/// Opens the data key with the master key. Fails on a wrong key or a changed header.
pub fn open_data_key(header: &Header, master: &MasterKey) -> Result<DataKey, String> {
    let sealed = &header.value["dataKey"];
    let nonce = sealed["nonce"]
        .as_str()
        .and_then(|n| STANDARD.decode(n).ok())
        .filter(|n| n.len() == 12)
        .ok_or("the archive header has no data key")?;
    let body = sealed["sealed"]
        .as_str()
        .and_then(|s| STANDARD.decode(s).ok())
        .ok_or("the archive header has no data key")?;
    let plain = Aes256Gcm::new(master.bytes().into())
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &body,
                aad: &data_key_aad(&header.backup_id),
            },
        )
        .map_err(|_| "the data key does not open with this master key")?;
    let bytes: [u8; 32] = plain
        .try_into()
        .map_err(|_| "the data key has the wrong size")?;
    Ok(DataKey(bytes))
}

/// The parsed plaintext header and the digest the chunks authenticate.
pub struct Header {
    pub value: Value,
    pub backup_id: String,
    digest: [u8; 32],
}

impl Header {
    pub fn key_bundle(&self) -> &Value {
        &self.value["keyBundle"]
    }
}

fn header_digest(text: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(MAGIC);
    hash.update((text.len() as u32).to_be_bytes());
    hash.update(text);
    hash.finalize().into()
}

fn nonce(index: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&index.to_be_bytes());
    nonce
}

fn chunk_aad(digest: &[u8; 32], index: u64, last: bool) -> [u8; 41] {
    let mut aad = [0u8; 41];
    aad[..32].copy_from_slice(digest);
    aad[32..40].copy_from_slice(&index.to_be_bytes());
    aad[40] = last as u8;
    aad
}

/// Writes an archive. Plaintext goes in through `Write`; call `finish` to seal the last chunk.
pub struct ArchiveWriter<W: Write> {
    out: W,
    cipher: Aes256Gcm,
    digest: [u8; 32],
    index: u64,
    buffer: Vec<u8>,
}

impl<W: Write> ArchiveWriter<W> {
    pub fn new(
        mut out: W,
        backup_id: &str,
        created_at: u64,
        master: &MasterKey,
        key_bundle: &Value,
    ) -> io::Result<ArchiveWriter<W>> {
        let key = DataKey::generate();
        let recovery_key_id = key_bundle["header"]
            .as_str()
            .and_then(|h| serde_json::from_str::<Value>(h).ok())
            .and_then(|h| h["recoveryKeyId"].as_str().map(str::to_owned));
        let header = json!({
            "kind": KIND,
            "version": 1,
            "backupId": backup_id,
            "createdAt": created_at,
            "chunkSize": CHUNK_SIZE,
            "recoveryKeyId": recovery_key_id,
            "dataKey": seal_data_key(master, backup_id, &key),
            "keyBundle": key_bundle,
        })
        .to_string();
        out.write_all(MAGIC)?;
        out.write_all(&(header.len() as u32).to_be_bytes())?;
        out.write_all(header.as_bytes())?;
        Ok(ArchiveWriter {
            out,
            cipher: Aes256Gcm::new(key.bytes().into()),
            digest: header_digest(header.as_bytes()),
            index: 0,
            buffer: Vec::with_capacity(CHUNK_SIZE),
        })
    }

    fn seal(&mut self, last: bool) -> io::Result<()> {
        let aad = chunk_aad(&self.digest, self.index, last);
        let sealed = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce(self.index)),
                Payload {
                    msg: &self.buffer,
                    aad: &aad,
                },
            )
            .map_err(|_| io::Error::other("chunk did not seal"))?;
        self.out.write_all(&(sealed.len() as u32).to_be_bytes())?;
        self.out.write_all(&[last as u8])?;
        self.out.write_all(&sealed)?;
        self.buffer.clear();
        self.index += 1;
        Ok(())
    }

    /// Seals the final chunk and returns the underlying writer.
    pub fn finish(mut self) -> io::Result<W> {
        self.seal(true)?;
        self.out.flush()?;
        Ok(self.out)
    }

    pub fn begin_entry(&mut self, kind: u8, name: &str) -> io::Result<()> {
        let name = name.as_bytes();
        let length =
            u16::try_from(name.len()).map_err(|_| io::Error::other("entry name too long"))?;
        self.write_all(&[kind])?;
        self.write_all(&length.to_be_bytes())?;
        self.write_all(name)
    }

    pub fn segment(&mut self, bytes: &[u8]) -> io::Result<()> {
        for part in bytes.chunks(u32::MAX as usize) {
            if part.is_empty() {
                continue;
            }
            self.write_all(&(part.len() as u32).to_be_bytes())?;
            self.write_all(part)?;
        }
        Ok(())
    }

    pub fn end_entry(&mut self) -> io::Result<()> {
        self.write_all(&0u32.to_be_bytes())
    }

    /// A writer for one entry's content: each write becomes a segment.
    pub fn content(&mut self) -> Content<'_, W> {
        Content {
            archive: self,
            pending: Vec::with_capacity(64 * 1024),
        }
    }
}

impl<W: Write> Write for ArchiveWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let room = CHUNK_SIZE - self.buffer.len();
        let taken = room.min(bytes.len());
        self.buffer.extend_from_slice(&bytes[..taken]);
        if self.buffer.len() == CHUNK_SIZE {
            self.seal(false)?;
        }
        Ok(taken)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Buffers an entry's content into segments of up to 64 KiB.
pub struct Content<'a, W: Write> {
    archive: &'a mut ArchiveWriter<W>,
    pending: Vec<u8>,
}

impl<W: Write> Write for Content<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() >= 64 * 1024 {
            self.flush()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let pending = std::mem::take(&mut self.pending);
        self.archive.segment(&pending)?;
        self.pending = pending;
        self.pending.clear();
        Ok(())
    }
}

impl<W: Write> Drop for Content<'_, W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

/// Reads the plaintext header without any key.
pub fn read_header<R: Read>(input: &mut R) -> Result<Header, String> {
    let mut magic = [0u8; 8];
    input
        .read_exact(&mut magic)
        .map_err(|_| "this is not a Moss backup")?;
    if &magic != MAGIC {
        return Err("this is not a Moss backup".into());
    }
    let mut length = [0u8; 4];
    input
        .read_exact(&mut length)
        .map_err(|_| "the archive header is cut short")?;
    let length = u32::from_be_bytes(length);
    if length > MAX_HEADER {
        return Err("the archive header is too large".into());
    }
    let mut text = vec![0u8; length as usize];
    input
        .read_exact(&mut text)
        .map_err(|_| "the archive header is cut short")?;
    let value: Value =
        serde_json::from_slice(&text).map_err(|_| "the archive header is damaged")?;
    if value["kind"] != KIND || value["version"] != 1 {
        return Err("unknown archive kind or version".into());
    }
    let backup_id = value["backupId"]
        .as_str()
        .ok_or("the archive has no id")?
        .to_owned();
    Ok(Header {
        value,
        backup_id,
        digest: header_digest(&text),
    })
}

/// Decrypted plaintext, chunk by chunk. Any failed chunk, a missing final chunk, or bytes after
/// the final chunk are read errors.
pub struct ArchiveReader<R: Read> {
    input: R,
    cipher: Aes256Gcm,
    digest: [u8; 32],
    index: u64,
    plain: Vec<u8>,
    position: usize,
    done: bool,
}

fn damaged(detail: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("the archive is damaged: {detail}"),
    )
}

impl<R: Read> ArchiveReader<R> {
    pub fn new(input: R, header: &Header, key: &DataKey) -> ArchiveReader<R> {
        ArchiveReader {
            input,
            cipher: Aes256Gcm::new(key.bytes().into()),
            digest: header.digest,
            index: 0,
            plain: Vec::new(),
            position: 0,
            done: false,
        }
    }

    fn next_chunk(&mut self) -> io::Result<bool> {
        if self.done {
            return Ok(false);
        }
        let mut prefix = [0u8; 5];
        if let Err(error) = self.input.read_exact(&mut prefix) {
            return Err(if error.kind() == io::ErrorKind::UnexpectedEof {
                damaged("it ends before its last chunk")
            } else {
                error
            });
        }
        let length = u32::from_be_bytes(prefix[..4].try_into().unwrap()) as usize;
        let last = match prefix[4] {
            0 => false,
            1 => true,
            _ => return Err(damaged("a chunk has a bad flag")),
        };
        if length > CHUNK_SIZE + 16 {
            return Err(damaged("a chunk is too large"));
        }
        let mut sealed = vec![0u8; length];
        self.input
            .read_exact(&mut sealed)
            .map_err(|_| damaged("it ends inside a chunk"))?;
        let aad = chunk_aad(&self.digest, self.index, last);
        self.plain = self
            .cipher
            .decrypt(
                Nonce::from_slice(&nonce(self.index)),
                Payload {
                    msg: &sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| damaged(&format!("chunk {} failed its check", self.index)))?;
        self.position = 0;
        self.index += 1;
        if last {
            self.done = true;
            let mut extra = [0u8; 1];
            if self.input.read(&mut extra)? != 0 {
                return Err(damaged("bytes follow the last chunk"));
            }
        }
        Ok(true)
    }

    /// Reads exactly `buffer.len()` bytes, treating the end of the plaintext as damage.
    pub fn take(&mut self, buffer: &mut [u8]) -> io::Result<()> {
        self.read_exact(buffer).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                damaged("an entry is cut short")
            } else {
                e
            }
        })
    }

    /// The next entry's kind and name.
    pub fn next_entry(&mut self) -> io::Result<(u8, String)> {
        let mut kind = [0u8; 1];
        self.take(&mut kind)?;
        if kind[0] == ENTRY_END {
            let mut rest = [0u8; 1];
            if self.read(&mut rest)? != 0 {
                return Err(damaged("data follows the end marker"));
            }
            return Ok((ENTRY_END, String::new()));
        }
        if ![ENTRY_ROLES, ENTRY_DUMP, ENTRY_FILE, ENTRY_MANIFEST].contains(&kind[0]) {
            return Err(damaged("unknown entry kind"));
        }
        let mut length = [0u8; 2];
        self.take(&mut length)?;
        let mut name = vec![0u8; u16::from_be_bytes(length) as usize];
        self.take(&mut name)?;
        let name = String::from_utf8(name).map_err(|_| damaged("an entry name is not text"))?;
        Ok((kind[0], name))
    }

    /// A reader for the current entry's content. Read it to the end before the next entry.
    pub fn content(&mut self) -> EntryContent<'_, R> {
        EntryContent {
            archive: self,
            left: 0,
            ended: false,
        }
    }
}

impl<R: Read> Read for ArchiveReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        while self.position == self.plain.len() {
            if !self.next_chunk()? {
                return Ok(0);
            }
        }
        let count = buffer.len().min(self.plain.len() - self.position);
        buffer[..count].copy_from_slice(&self.plain[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

pub struct EntryContent<'a, R: Read> {
    archive: &'a mut ArchiveReader<R>,
    left: usize,
    ended: bool,
}

impl<R: Read> Read for EntryContent<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.ended || buffer.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut length = [0u8; 4];
            self.archive.take(&mut length)?;
            self.left = u32::from_be_bytes(length) as usize;
            if self.left == 0 {
                self.ended = true;
                return Ok(0);
            }
        }
        let want = buffer.len().min(self.left);
        self.archive.take(&mut buffer[..want])?;
        self.left -= want;
        Ok(want)
    }
}

/// Copies a reader to a writer while hashing, returning the byte count and SHA-256.
pub fn copy_hashed(input: &mut dyn Read, output: &mut dyn Write) -> io::Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let count = input.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
        output.write_all(&chunk[..count])?;
        total += count as u64;
    }
    Ok((total, hex::encode(hash.finalize())))
}

/// Hashes everything written through it.
pub struct HashingWriter<W: Write> {
    pub inner: W,
    hash: Sha256,
    pub bytes: u64,
}

impl<W: Write> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        HashingWriter {
            inner,
            hash: Sha256::new(),
            bytes: 0,
        }
    }

    pub fn digest(&self) -> String {
        hex::encode(self.hash.clone().finalize())
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> Value {
        json!({ "header": "{\"recoveryKeyId\":\"abc\"}", "payload": {} })
    }

    fn sample(master: &MasterKey) -> Vec<u8> {
        let mut writer = ArchiveWriter::new(Vec::new(), "b1", 1, master, &bundle()).unwrap();
        writer.begin_entry(ENTRY_FILE, "notes/a.md").unwrap();
        {
            let mut content = writer.content();
            content.write_all(&vec![7u8; CHUNK_SIZE + 10]).unwrap();
        }
        writer.end_entry().unwrap();
        writer.write_all(&[ENTRY_END]).unwrap();
        writer.finish().unwrap()
    }

    fn read_all(bytes: &[u8], master: &MasterKey) -> Result<Vec<u8>, String> {
        let mut input = bytes;
        let header = read_header(&mut input)?;
        let key = open_data_key(&header, master)?;
        let mut reader = ArchiveReader::new(input, &header, &key);
        let (kind, name) = reader.next_entry().map_err(|e| e.to_string())?;
        assert_eq!((kind, name.as_str()), (ENTRY_FILE, "notes/a.md"));
        let mut out = Vec::new();
        reader
            .content()
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        let (kind, _) = reader.next_entry().map_err(|e| e.to_string())?;
        assert_eq!(kind, ENTRY_END);
        Ok(out)
    }

    #[test]
    fn round_trip_and_every_flipped_byte_fails() {
        let master = MasterKey::generate();
        let bytes = sample(&master);
        assert_eq!(
            read_all(&bytes, &master).unwrap(),
            vec![7u8; CHUNK_SIZE + 10]
        );
        assert!(read_all(&bytes, &MasterKey::generate()).is_err());
        for at in [9, 20, bytes.len() / 2, bytes.len() - 1] {
            let mut changed = bytes.clone();
            changed[at] ^= 1;
            assert!(
                read_all(&changed, &master).is_err(),
                "flip at {at} was accepted"
            );
        }
        assert!(read_all(&bytes[..bytes.len() - 1], &master).is_err());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(read_all(&longer, &master).is_err());
    }
}
