//! Clip decoding, admission and the WAV wrapper for the Mac audio route. Everything here is
//! pure. The clip bytes never reach a log, a job payload or a row, only the fingerprint does.
use crate::capture_errors::{CaptureCode, Failure};
use crate::capture_state::elapsed;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_CLIP_MS: i64 = 10_000;
pub const MAX_PCM_BYTES: usize = 3_840_000;
pub const FINALIZATION_MS: i64 = 60_000;
pub const LEASE_MS: i64 = 30_000;
/// Every sample at or under this many counts is near silence (about -60 dBFS).
const SILENCE_PEAK: i32 = 32;

/// One clip as the Mac sent it, before the audio is decoded.
pub struct Clip {
    pub meeting_id: String,
    pub grant_id: String,
    pub request_key: String,
    pub generation: i64,
    pub epoch: i64,
    pub source_id: String,
    pub sequence: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub sample_rate_hz: i64,
    pub pcm: Vec<u8>,
    pub fingerprint: String,
}

fn invalid() -> Failure {
    Failure::new(CaptureCode::InvalidInput)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Canonical standard base64 only. Wrong characters, wrong padding and loose trailing bits fail.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = (index + 1) * 4 == bytes.len();
        let pad = chunk.iter().rev().take_while(|b| **b == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut value = 0u32;
        for (n, b) in chunk.iter().enumerate() {
            let digit = if n >= 4 - pad { 0 } else { ALPHABET.iter().position(|a| a == b)? as u32 };
            value = value << 6 | digit;
        }
        // The padded bits must be zero, or the text is not the canonical encoding.
        if (pad == 1 && value & 0xff != 0) || (pad == 2 && value & 0xffff != 0) {
            return None;
        }
        out.extend_from_slice(&value.to_be_bytes()[1..4 - pad]);
    }
    Some(out)
}

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |v, (n, b)| v | (*b as u32) << (16 - 8 * n));
        for n in 0..4 {
            if n <= chunk.len() {
                out.push(ALPHABET[(value >> (18 - 6 * n) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn int(body: &Value, key: &str) -> Result<i64, Failure> {
    body[key].as_i64().ok_or_else(invalid)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks the clip's numbers, decodes its audio and fingerprints metadata plus audio together.
/// The body shape was already checked by the route.
pub fn decode(body: &Value) -> Result<Clip, Failure> {
    let text = |key: &str| body[key].as_str().map(str::to_owned).ok_or_else(invalid);
    let (generation, epoch, sequence) = (int(body, "generation")?, int(body, "epoch")?, int(body, "sequence")?);
    let (start_ms, end_ms, rate) = (int(body, "startMs")?, int(body, "endMs")?, int(body, "sampleRateHz")?);
    let encoded = body["pcmBase64"].as_str().ok_or_else(invalid)?;
    if !(8000..=192_000).contains(&rate)
        || start_ms < 0
        || sequence < 0
        || !(1..=64).contains(&epoch)
        || generation < 1
        || end_ms <= start_ms
        || end_ms - start_ms > MAX_CLIP_MS
        || encoded.len() > MAX_PCM_BYTES.div_ceil(3) * 4
    {
        return Err(invalid());
    }
    let pcm = base64_decode(encoded).ok_or_else(invalid)?;
    let span = (end_ms - start_ms) as f64;
    if pcm.is_empty() || pcm.len() % 2 != 0 || pcm.len() > MAX_PCM_BYTES || ((pcm.len() as f64 / 2.0 / rate as f64) * 1000.0 - span).abs() > 2.0 {
        return Err(invalid());
    }
    let (meeting_id, grant_id, source_id) = (text("meetingId")?, text("grantId")?, text("sourceId")?);
    // Field order is fixed so a replay computes the same fingerprint.
    let metadata = format!(
        "{{\"meetingId\":{},\"grantId\":{},\"generation\":{generation},\"epoch\":{epoch},\"sourceId\":{},\"sequence\":{sequence},\"startMs\":{start_ms},\"endMs\":{end_ms},\"sampleRateHz\":{rate}}}",
        json!(meeting_id),
        json!(grant_id),
        json!(source_id)
    );
    let mut hasher = Sha256::new();
    hasher.update(metadata.as_bytes());
    hasher.update(&pcm);
    Ok(Clip {
        meeting_id,
        grant_id,
        request_key: text("requestKey")?,
        generation,
        epoch,
        source_id,
        sequence,
        start_ms,
        end_ms,
        sample_rate_hz: rate,
        pcm,
        fingerprint: hex(&hasher.finalize()),
    })
}

/// True when no sample rises above the silence floor.
pub fn near_silent(pcm: &[u8]) -> bool {
    pcm.chunks_exact(2).all(|pair| (i16::from_le_bytes([pair[0], pair[1]]) as i32).abs() <= SILENCE_PEAK)
}

/// Mono 16 bit WAV around the clip.
pub fn wave(pcm: &[u8], rate: i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(rate as u32).to_le_bytes());
    out.extend_from_slice(&(rate as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

fn millis(value: &Value) -> Option<i64> {
    value.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp_millis())
}

/// Decides whether the clip may be transcribed now. Returns the epoch it belongs to.
pub fn admit(state: &Value, clip: &Clip, at: DateTime<Utc>) -> Result<Value, Failure> {
    let conflict = || Failure::new(CaptureCode::Conflict);
    let epochs = state["epochs"].as_array().cloned().unwrap_or_default();
    let epoch = epochs
        .iter()
        .find(|e| e["epoch"].as_i64() == Some(clip.epoch) && e["generation"].as_i64() == Some(clip.generation))
        .cloned()
        .ok_or_else(conflict)?;
    let now_ms = elapsed(state, at);
    if clip.start_ms < epoch["startMs"].as_i64().unwrap_or(0) || clip.end_ms > now_ms || now_ms - clip.end_ms > FINALIZATION_MS {
        return Err(conflict());
    }
    let selection = &epoch["selection"];
    let mic = selection["microphone"]["sourceId"].as_str();
    let output = selection["mode"] != "microphone-only" && selection["outputSourceId"].as_str() == Some(clip.source_id.as_str());
    if mic != Some(clip.source_id.as_str()) && !output {
        return Err(invalid());
    }
    let observed = &state["observed"];
    let observed_now = observed["generation"] == state["generation"];
    let final_flush = state["desired"] == "stopped"
        && state["finalized"] != json!(true)
        && millis(&state["finalizationDeadline"]).is_some_and(|d| at.timestamp_millis() <= d)
        && observed["phase"] == "stopped"
        && observed_now;
    let resumed_flush = !epoch["endMs"].is_null()
        && epochs.last().is_some_and(|last| last["epoch"] != epoch["epoch"])
        && state["desired"] == "recording"
        && observed["phase"] == "recording"
        && observed_now;
    let seen = millis(&state["lastSeenAt"]);
    if !final_flush
        && (state["desired"] != "recording"
            || (!resumed_flush && state["generation"].as_i64() != Some(clip.generation))
            || observed["phase"] != "recording"
            || (!resumed_flush && observed["generation"].as_i64() != Some(clip.generation))
            || seen.is_none_or(|s| at.timestamp_millis() - s > LEASE_MS))
    {
        return Err(Failure::new(CaptureCode::Interrupted));
    }
    if epoch["endMs"].as_i64().is_some_and(|end| clip.end_ms > end) || state["stopCutoffMs"].as_i64().is_some_and(|cut| clip.end_ms > cut) {
        return Err(conflict());
    }
    Ok(epoch)
}
