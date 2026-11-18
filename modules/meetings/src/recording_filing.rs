//! Files a recording reading: type, side, confidence and reason go onto the recording facts, an
//! automatic title goes onto the meeting, and two background jobs follow. One asks the owner to
//! check a low-confidence side. The other proposes memory facts from the idea groups.
use crate::records::{Records, METADATA, RECORDS};
use crate::recording_reading::{side_review_version, Context, Reading};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const NOTICE_QUEUE: &str = "meetings.recording-notice";
pub const MEMORY_QUEUE: &str = "meetings.recording-memory";

fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Queues a metadata-only job. The idempotency key makes a repeat call a no-op.
pub fn enqueue<H: Host + ?Sized>(host: &H, queue: &str, meeting: &str, key: &str) -> Result<()> {
    let at = host.call("context", "read", "call", json!({}))?["now"].as_str().unwrap_or_default().to_owned();
    host.call(
        "jobs",
        "enqueue-after-commit",
        queue,
        json!({"params": {"meeting-id": meeting}, "idempotencyKey": key, "availableAt": at}),
    )?;
    Ok(())
}

/// A fixed UUID for the memory job, so a repeat of the same run queues it once.
pub(crate) fn derived_key(request_key: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("meetings.recording-memory:{request_key}").as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[..16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Writes the reading. A person's own type choice stays, and a change made since the run began
/// (a different revision) leaves everything alone. Returns whether the reading was filed.
pub fn file<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    context: &Context,
    reading: &Reading,
    output_version: i64,
    request_key: &str,
) -> Result<bool> {
    let kept = if context.type_source == "user" { context.type_id.clone() } else { Some(reading.type_id.clone()) };
    let updated = Client(host).query(
        METADATA,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("meeting_id", meeting),
                    Filter::eq("revision", context.metadata_revision),
                ],
            },
            values(vec![
                ("type_id", json!(kept)),
                ("side", json!(reading.side)),
                ("confidence", json!(reading.confidence)),
                ("reason", json!(reading.reason)),
                ("output_version", json!(output_version)),
                ("revision", json!(context.metadata_revision + 1)),
            ]),
        ),
    )?;
    if updated.is_empty() {
        return Ok(false);
    }
    if context.title_source == "automatic" {
        retitle(host, meeting, &reading.title)?;
    }
    if side_review_version(output_version, &reading.side, reading.confidence, &reading.reason).is_some() {
        enqueue(host, NOTICE_QUEUE, meeting, request_key)?;
    }
    if !reading.idea_groups.is_empty() {
        enqueue(host, MEMORY_QUEUE, meeting, &derived_key(request_key))?;
    }
    Ok(true)
}

/// Names the meeting after its reading. A rename the person made meanwhile wins, because the
/// update only matches the title that was read.
fn retitle<H: Host + ?Sized>(host: &H, meeting: &str, title: &str) -> Result<()> {
    let records = Records::new(host);
    let Some(row) = records.row(meeting)? else { return Ok(()) };
    let current = row["title"].as_str().unwrap_or_default();
    if current == title {
        return Ok(());
    }
    Client(host).query(
        RECORDS,
        &Query::update(
            Filter::And { filters: vec![Filter::eq("id", meeting), Filter::eq("title", current)] },
            values(vec![("title", json!(title)), ("updated_at", json!(records.now()?))]),
        ),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::derived_key;

    #[test]
    fn the_memory_job_key_is_a_stable_uuid_per_request() {
        let key = derived_key("11111111-1111-4111-8111-111111111111");
        assert_eq!(key, derived_key("11111111-1111-4111-8111-111111111111"));
        assert_ne!(key, derived_key("22222222-2222-4222-8222-222222222222"));
        assert_eq!(key.len(), 36);
        assert_eq!(key.matches('-').count(), 4);
        assert_eq!(&key[14..15], "4");
    }
}
