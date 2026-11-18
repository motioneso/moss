//! Ring recording source rules: upload manifest, packet framing, canonical WAV header and the
//! ring sidecar. Ported from the TypeScript receivers; nothing here decodes Opus.
use crate::ring_errors::{Invalid, BAD, TOO_BIG};
use crate::text::{is_iso_millis, is_uuid};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const PACKETS_MAX: u64 = 32 * 1024 * 1024;
pub const SIDECAR_MAX: u64 = 256 * 1024;
pub const WAV_MAX: u64 = 256 * 1024 * 1024;
pub const CHUNK: u64 = 1024 * 1024;
pub const DURATION_MAX_MS: u64 = 7_200_000;
pub const VOICE_DURATION_MAX_MS: u64 = 120_000;

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn hex64(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}$`
pub fn recording_id_ok(id: &str) -> bool {
    let rest = id.strip_prefix("amsg_").unwrap_or(id);
    let Some((digits, tail)) = rest.split_once('_') else { return false };
    digits.len() == 10
        && digits.bytes().all(|c| c.is_ascii_digit())
        && (1..=24).contains(&tail.len())
        && tail.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    Meeting,
    Voice { enablement_id: String, captured_at: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File {
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upload {
    pub source_device_id: String,
    pub recording_id: String,
    pub destination: Destination,
    pub packets: File,
    pub sidecar: File,
    pub wav: File,
    pub duration_ms: u64,
    pub fingerprint: String,
    pub canonical: String,
    pub voice_mode: bool,
}

fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a serde_json::Map<String, Value>, Invalid> {
    let map = value.as_object().ok_or(BAD)?;
    if map.len() != keys.len() || keys.iter().any(|k| !map.contains_key(*k)) {
        return Err(BAD);
    }
    Ok(map)
}

fn file(input: &serde_json::Map<String, Value>, kind: &str, max: u64) -> Result<File, Invalid> {
    let f = exact(&input[kind], &["byteLength", "sha256"])?;
    let len = f["byteLength"].as_u64().filter(|n| *n >= 1 && *n <= (1 << 53)).ok_or(BAD)?;
    let sha = f["sha256"].as_str().filter(|s| hex64(s)).ok_or(BAD)?;
    if len > max {
        return Err(TOO_BIG);
    }
    Ok(File { byte_length: len, sha256: sha.to_owned() })
}

fn file_json(f: &File) -> String {
    format!("{{\"byteLength\":{},\"sha256\":\"{}\"}}", f.byte_length, f.sha256)
}

fn captured_ok(value: &str) -> bool {
    is_iso_millis(value) && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// Parses a version 3 upload manifest. The fingerprint is the SHA-256 of the canonical JSON,
/// with the key order the TypeScript receivers use.
pub fn parse_upload(value: &Value) -> Result<Upload, Invalid> {
    let input = exact(value, &["version", "sourceDeviceId", "recordingId", "destination", "packets", "sidecar", "wav"])?;
    let device = input["sourceDeviceId"].as_str().filter(|s| is_uuid(s)).ok_or(BAD)?;
    let id = input["recordingId"].as_str().filter(|s| recording_id_ok(s)).ok_or(BAD)?;
    if input["version"] != 3 {
        return Err(BAD);
    }
    let raw = &input["destination"];
    let intent = raw.get("intent").and_then(Value::as_str);
    let destination = if intent == Some("meeting") {
        exact(raw, &["intent"])?;
        Destination::Meeting
    } else {
        let d = exact(raw, &["intent", "enablementId", "capturedAt"])?;
        let enablement = d["enablementId"].as_str().filter(|s| is_uuid(s)).ok_or(BAD)?;
        let captured = match &d["capturedAt"] {
            Value::Null => None,
            Value::String(s) if captured_ok(s) => Some(s.clone()),
            _ => return Err(BAD),
        };
        if intent != Some("voice-request") || !id.starts_with("amsg_") {
            return Err(BAD);
        }
        Destination::Voice { enablement_id: enablement.to_lowercase(), captured_at: captured }
    };
    let packets = file(input, "packets", PACKETS_MAX)?;
    let sidecar = file(input, "sidecar", SIDECAR_MAX)?;
    let wav = file(input, "wav", WAV_MAX)?;
    let body = wav.byte_length.checked_sub(44).ok_or(BAD)?;
    if body % 32 != 0 || body == 0 {
        return Err(BAD);
    }
    let duration_ms = body / 32;
    let cap = if destination == Destination::Meeting { DURATION_MAX_MS } else { VOICE_DURATION_MAX_MS };
    if duration_ms > cap {
        return Err(TOO_BIG);
    }
    let dest_json = match &destination {
        Destination::Meeting => "{\"intent\":\"meeting\"}".to_owned(),
        Destination::Voice { enablement_id, captured_at } => format!(
            "{{\"intent\":\"voice-request\",\"enablementId\":{},\"capturedAt\":{}}}",
            Value::from(enablement_id.as_str()),
            captured_at.as_deref().map_or("null".to_owned(), |c| Value::from(c).to_string())
        ),
    };
    let canonical = format!(
        "{{\"version\":3,\"sourceDeviceId\":{},\"recordingId\":{},\"destination\":{},\"packets\":{},\"sidecar\":{},\"wav\":{}}}",
        Value::from(device.to_lowercase()),
        Value::from(id),
        dest_json,
        file_json(&packets),
        file_json(&sidecar),
        file_json(&wav)
    );
    Ok(Upload {
        source_device_id: device.to_lowercase(),
        recording_id: id.to_owned(),
        destination,
        packets,
        sidecar,
        wav,
        duration_ms,
        fingerprint: sha256_hex(canonical.as_bytes()),
        canonical,
        voice_mode: id.starts_with("amsg_"),
    })
}

/// Expected byte length of one chunk, or an error for an index past the end of the file.
pub fn chunk_length(total: u64, index: u64) -> Result<u64, Invalid> {
    let remaining = total.checked_sub(index.checked_mul(CHUNK).ok_or(BAD)?).filter(|r| *r > 0).ok_or(BAD)?;
    Ok(remaining.min(CHUNK))
}

/// `^(0|[1-9][0-9]{0,2})$`
pub fn chunk_index(text: &str) -> Option<u64> {
    let ok = !text.is_empty()
        && text.len() <= 3
        && text.bytes().all(|c| c.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    ok.then(|| text.parse().ok()).flatten()
}

/// Incremental seq:u8, len:u8, payload framing. Retains no bytes.
#[derive(Default)]
pub struct PacketValidator {
    next: Option<u8>,
    awaiting_length: bool,
    remaining: usize,
    count: u64,
}

impl PacketValidator {
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), Invalid> {
        let mut at = 0;
        while at < bytes.len() {
            if self.remaining > 0 {
                let used = self.remaining.min(bytes.len() - at);
                self.remaining -= used;
                at += used;
            } else if self.awaiting_length {
                self.remaining = bytes[at] as usize;
                at += 1;
                if self.remaining == 0 {
                    return Err(BAD);
                }
                self.awaiting_length = false;
                self.count += 1;
            } else {
                let seq = bytes[at];
                at += 1;
                if self.next.is_some_and(|n| n != seq) {
                    return Err(BAD);
                }
                self.next = Some(seq.wrapping_add(1));
                self.awaiting_length = true;
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<u64, Invalid> {
        if self.awaiting_length || self.remaining > 0 || self.count == 0 {
            return Err(BAD);
        }
        Ok(self.count)
    }
}

fn le16(h: &[u8], at: usize) -> u64 {
    u16::from_le_bytes([h[at], h[at + 1]]) as u64
}
fn le32(h: &[u8], at: usize) -> u64 {
    u32::from_le_bytes([h[at], h[at + 1], h[at + 2], h[at + 3]]) as u64
}

/// Duration in ms of a canonical 16 kHz mono PCM16 WAV, from its first 44 bytes and total size.
pub fn wav_duration(header: &[u8], byte_length: u64, max_ms: u64) -> Result<u64, Invalid> {
    if header.len() < 44
        || byte_length < 46
        || &header[0..4] != b"RIFF"
        || le32(header, 4) != byte_length - 8
        || &header[8..16] != b"WAVEfmt "
        || le32(header, 16) != 16
        || le16(header, 20) != 1
        || le16(header, 22) != 1
        || le32(header, 24) != 16000
        || le32(header, 28) != 32000
        || le16(header, 32) != 2
        || le16(header, 34) != 16
        || &header[36..40] != b"data"
        || le32(header, 40) != byte_length - 44
        || (byte_length - 44) % 2 != 0
    {
        return Err(BAD);
    }
    let body = byte_length - 44;
    if body > max_ms * 32 {
        return Err(TOO_BIG);
    }
    if body % 32 != 0 || body == 0 {
        return Err(BAD);
    }
    Ok(body / 32)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Sidecar {
    pub start_ms: u64,
    pub end_ms: u64,
    pub recorded_duration_ms: u64,
    pub bookmarks_ms: Vec<u64>,
}

fn timestamp(value: &Value) -> Result<u64, Invalid> {
    let s = value.as_str().filter(|s| (10..=13).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit())).ok_or(BAD)?;
    let n: u64 = s.parse().map_err(|_| BAD)?;
    Ok(if s.len() == 10 { n * 1000 } else { n })
}

/// Reads the ring sidecar, a run of JSON entries without the outer brackets.
pub fn sidecar_metadata(bytes: &[u8], duration_ms: u64, max_bytes: u64, max_entries: u64) -> Result<Sidecar, Invalid> {
    if bytes.len() as u64 > max_bytes {
        return Err(TOO_BIG);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| BAD)?;
    let entries: Value = serde_json::from_str(&format!("[{text}]")).map_err(|_| BAD)?;
    let entries = entries.as_array().filter(|e| !e.is_empty() && e.len() as u64 <= max_entries).ok_or(BAD)?;
    let (mut start, mut end, mut recorded) = (None, None, None);
    let mut buttons = Vec::new();
    for item in entries {
        let entry = item.as_object().ok_or(BAD)?;
        for key in ["record", "btn", "duration"] {
            let Some(pair) = entry.get(key) else { continue };
            let pair = pair.as_array().filter(|p| p.len() == 2).ok_or(BAD)?;
            let at = timestamp(&pair[0])?;
            match (key, pair[1].as_str()) {
                ("record", Some("start")) if start.is_none() => start = Some(at),
                ("record", Some("end")) if end.is_none() => end = Some(at),
                ("record", _) => return Err(BAD),
                ("btn", Some("1")) => buttons.push(at),
                ("btn", _) => {}
                _ => {
                    let n = pair[1].as_str().filter(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())).ok_or(BAD)?;
                    if recorded.is_some() {
                        return Err(BAD);
                    }
                    recorded = Some(n.parse::<u64>().ok().filter(|n| *n <= (1 << 53)).ok_or(BAD)?);
                }
            }
        }
    }
    let (Some(start_ms), Some(end_ms), Some(recorded_duration_ms)) = (start, end, recorded) else { return Err(BAD) };
    let bookmarks_ms = buttons.into_iter().filter_map(|at| at.checked_sub(start_ms)).filter(|at| *at <= duration_ms).collect();
    Ok(Sidecar { start_ms, end_ms, recorded_duration_ms, bookmarks_ms })
}
