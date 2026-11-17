//! The paging cursor: base64url of `{checkedInAt, id, since}`. It orders pages and grants nothing.
use serde_json::{json, Map, Value};

const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |a, (i, b)| a | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(URL_SAFE[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    for chunk in text.as_bytes().chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= (URL_SAFE.iter().position(|x| x == c)? as u32) << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Some(out)
}

pub fn token(checked_in_at: &str, id: &str, since: Option<&str>) -> String {
    encode(json!({"checkedInAt": checked_in_at, "id": id, "since": since}).to_string().as_bytes())
}

pub struct Cursor {
    pub checked_in_at: String,
    pub id: String,
}

const INVALID: &str = "Invalid check-in cursor. Restart history from the newest entries.";
const MISMATCH: &str = "Check-in cursor does not match this date window. Restart the read.";

fn precise(stamp: &str) -> bool {
    let b = stamp.as_bytes();
    b.len() == 27
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            26 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
        && !stamp.starts_with("0000-")
        && chrono::NaiveDateTime::parse_from_str(&stamp[..19], "%Y-%m-%dT%H:%M:%S").is_ok()
}

fn uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The cursor must name a real moment and row, and carry the same date window as this request.
pub fn parse(token: &str, since: Option<&str>) -> Result<Cursor, &'static str> {
    if token.is_empty() || token.len() > 512 || !token.bytes().all(|b| URL_SAFE.contains(&b)) {
        return Err(INVALID);
    }
    let bytes = decode(token).ok_or(INVALID)?;
    if encode(&bytes) != token {
        return Err(INVALID);
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    let map: &Map<String, Value> = parsed.as_object().ok_or(INVALID)?;
    let stamp = map.get("checkedInAt").and_then(Value::as_str).ok_or(INVALID)?;
    let id = map.get("id").and_then(Value::as_str).ok_or(INVALID)?;
    if !precise(stamp) || !uuid(id) {
        return Err(INVALID);
    }
    let same = match (map.get("since"), since) {
        (Some(Value::Null), None) => true,
        (Some(Value::String(a)), Some(b)) => a == b,
        _ => false,
    };
    if !same {
        return Err(MISMATCH);
    }
    Ok(Cursor { checked_in_at: stamp.to_owned(), id: id.to_owned() })
}
