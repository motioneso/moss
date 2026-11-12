//! Account deletion and export shape. Tables from later parts are listed so a deletion covers
//! every owned table, and their export collections stay empty until those parts land.
use crate::records::{NOTE_WRITES, RECORDS};
use moss_module_sdk::{query::Order, query::Query, Client, Error, Host, Result};
use serde_json::{Map, Value};

pub const COUNT_PREDICATE: &str = "owner_user_id = $1::uuid";
const PAGE: u32 = 100;

pub const OWNED_TABLES: [&str; 22] = [
    "app.meeting_recording_metadata",
    "app.meeting_recording_types",
    "app.meeting_manual_entries",
    "app.meeting_recording_imports",
    "app.meeting_recording_chunks",
    "app.meeting_recording_voice_enablements",
    "app.meeting_records",
    "app.meeting_note_writes",
    "app.meeting_transcript_batches",
    "app.meeting_history_segments",
    "app.meeting_output_requests",
    "app.meeting_output_artifacts",
    "app.meeting_action_candidates",
    "app.meeting_export_receipts",
    "app.meeting_export_requests",
    "app.meeting_capture_links",
    "app.meeting_capture_grants",
    "app.meeting_capture_receipts",
    "app.meeting_capture_connections",
    "app.meeting_capture_start_cancellations",
    "app.meeting_stop_summaries",
    "app.meeting_capture_start_limits",
];

/// Collections whose tables arrive in later parts. Each exports an empty list for now.
pub const STUB_COLLECTIONS: [&str; 16] = [
    "recording_types",
    "recording_metadata",
    "manual_entries",
    "voice_enablements",
    "recording_imports",
    "transcript_batches",
    "output_requests",
    "output_artifacts",
    "action_candidates",
    "export_receipts",
    "export_requests",
    "stop_summaries",
    "capture_grants",
    "capture_connections",
    "capture_start_cancellations",
    "capture_start_limits",
];

const RECORD_FIELDS: [(&str, &str); 9] = [
    ("id", "id"),
    ("owner_user_id", "ownerUserId"),
    ("request_key", "requestKey"),
    ("title", "title"),
    ("creation_title", "creationTitle"),
    ("personal_notes", "personalNotes"),
    ("notes_revision", "notesRevision"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
];
const WRITE_FIELDS: [(&str, &str); 6] = [
    ("meeting_id", "meetingId"),
    ("owner_user_id", "ownerUserId"),
    ("request_key", "requestKey"),
    ("expected_revision", "expectedRevision"),
    ("personal_notes", "personalNotes"),
    ("saved_at", "savedAt"),
];

fn page<H: Host + ?Sized>(
    host: &H,
    table: &str,
    order: &[&str],
    fields: &[(&str, &str)],
) -> Result<Value> {
    let mut query = Query {
        order: order
            .iter()
            .map(|column| Order { column: (*column).into(), descending: false })
            .collect(),
        limit: Some(PAGE),
        ..Query::default()
    };
    let mut out = Vec::new();
    loop {
        let rows = Client(host).query(table, &query)?;
        let count = rows.len();
        for row in rows {
            let mut item = Map::new();
            for (column, name) in fields {
                let value = row
                    .get(column)
                    .ok_or_else(|| Error::new("Meetings export row is incomplete"))?;
                item.insert((*name).into(), value.clone());
            }
            out.push(Value::Object(item));
        }
        if count < PAGE as usize {
            break;
        }
        query.offset = query
            .offset
            .checked_add(PAGE)
            .filter(|offset| *offset <= 1_000_000)
            .ok_or_else(|| Error::new("Meetings export exceeds the host paging limit"))?;
    }
    Ok(Value::Array(out))
}

pub fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut section = Map::new();
    for name in STUB_COLLECTIONS {
        section.insert(name.into(), Value::Array(vec![]));
    }
    section.insert("records".into(), page(host, RECORDS, &["created_at", "id"], &RECORD_FIELDS)?);
    section.insert(
        "note_writes".into(),
        page(host, NOTE_WRITES, &["saved_at", "meeting_id", "request_key"], &WRITE_FIELDS)?,
    );
    Ok(Value::Object(section))
}
