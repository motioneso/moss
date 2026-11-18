//! Guest side of summary storage. The host runs the SQL; this module shapes what goes in and out.
use crate::output_validation::{InputSegment, Inputs};
use crate::recording::Recording;
use crate::recording_reading::Context;
use crate::records::Records;
use crate::store;
use crate::transcript::{self, Ledger};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

pub const OUTPUTS: &str = "meetings.outputs";

/// Snapshot limits for ordinary meetings and for long recording imports.
const SHORT: (i64, i64) = (500, 100_000);
const LONG: (i64, i64) = (20_000, 1_200_000);

pub fn call<H: Host + ?Sized>(host: &H, operation: &str, meeting: &str, extra: Value) -> Result<Value> {
    let mut params = extra;
    params["meetingId"] = json!(meeting);
    host.call("kv", operation, OUTPUTS, params)
}

/// The notes and transcript a summary reads, with the facts a stale check compares.
pub struct Current {
    /// The `inputs` object stored inside an artifact.
    pub stored: Value,
    pub notes_revision: i64,
    pub transcript_revision: i64,
    pub inputs: Inputs,
    pub has_notes: bool,
    pub segment_count: usize,
    pub omitted: bool,
    pub provisional: bool,
    pub final_text: bool,
}

/// Locks (or share-locks) the meeting and reads its inputs. `None` means it is not visible.
pub fn inputs<H: Host + ?Sized>(host: &H, meeting: &str, exclusive: bool) -> Result<Option<Current>> {
    let row = call(host, if exclusive { "lock" } else { "get" }, meeting, json!({}))?;
    if row["found"] != true {
        return Ok(None);
    }
    let notes = row["personalNotes"].as_str().unwrap_or_default().to_owned();
    let notes_revision = row["notesRevision"].as_i64().unwrap_or(0);
    let limits = if row["longSource"] == true { LONG } else { SHORT };
    let transcript = match store::load(host, meeting, false)? {
        Ok(Some(state)) => {
            let stop = state.receipt().stop_cutoff_ms;
            state.ledger.map(|ledger| (stop, ledger))
        }
        Ok(None) => None,
        Err(_) => return Err(Error::new("Transcript unavailable")),
    };
    let recording = recording_context(host, meeting, exclusive)?;
    let mut current = Current {
        stored: Value::Null,
        notes_revision,
        transcript_revision: 0,
        inputs: Inputs {
            meeting_id: meeting.to_owned(),
            notes_revision,
            personal_notes: notes.clone(),
            segments: vec![],
            recording: recording.as_ref().map(|r| r.0.clone()),
        },
        has_notes: !crate::text::js_trim(&notes).is_empty(),
        segment_count: 0,
        omitted: false,
        provisional: false,
        final_text: false,
    };
    let mut snapshot_value = Value::Null;
    if let Some((stop, ledger)) = transcript {
        let snapshot = snapshot_of(&ledger, stop, limits)?;
        current.transcript_revision = ledger.transcript_revision;
        current.segment_count = snapshot.segments.len();
        current.omitted = snapshot.omitted > 0;
        current.provisional = snapshot.contains_provisional;
        current.final_text = snapshot
            .segments
            .iter()
            .any(|s| s.finality == "final" && s.text.chars().any(char::is_alphanumeric));
        current.inputs.segments = snapshot
            .segments
            .iter()
            .map(|s| InputSegment {
                meeting_id: s.meeting_id.clone(),
                segment_id: s.segment_id.clone(),
                revision: s.revision,
                text: s.text.clone(),
            })
            .collect();
        let bound = stop.unwrap_or_else(|| ledger.sources.iter().map(|s| s.end_ms).max().unwrap_or(0));
        snapshot_value = json!({
            "maxSegments": limits.0, "maxCharacters": limits.1,
            "meetingId": meeting, "ownerUserId": ledger.owner_user_id,
            "transcriptRevision": ledger.transcript_revision, "cutoffMs": bound,
            "cursor": snapshot.cursor, "segments": snapshot.segments, "throughMs": snapshot.through_ms,
            "omittedSegments": snapshot.omitted, "containsProvisional": snapshot.contains_provisional});
    }
    current.stored = json!({"meetingId": meeting, "transcript": snapshot_value,
        "personalNotes": notes, "notesRevision": notes_revision});
    if let Some((_, stored)) = recording {
        current.stored["recording"] = stored;
    }
    Ok(Some(current))
}

/// The recording facts a summary starts from, with their stored copy. Generation creates the
/// metadata row on first use, and a read leaves it alone.
fn recording_context<H: Host + ?Sized>(host: &H, meeting: &str, create: bool) -> Result<Option<(Context, Value)>> {
    let recording = Recording::new(host);
    let row = match recording.metadata(meeting)? {
        Some(row) => Some(row),
        None if create => {
            let title = Records::new(host).row(meeting)?.map(|r| r["title"].as_str().unwrap_or_default().to_owned());
            match title {
                Some(title) => recording.ensure(meeting, &title)?,
                None => None,
            }
        }
        None => None,
    };
    let Some(row) = row else { return Ok(None) };
    let configuration = recording.configuration(false)?;
    let stored = json!({"metadata": crate::recording::dto(&row)?, "configuration": configuration});
    let context = Context {
        metadata_revision: row["revision"].as_i64().unwrap_or(0),
        configuration_revision: configuration.revision,
        type_source: row["type_source"].as_str().unwrap_or("automatic").to_owned(),
        type_id: row["type_id"].as_str().map(str::to_owned),
        title_source: row["title_source"].as_str().unwrap_or("user").to_owned(),
        recorded_at: stored["metadata"]["recordedAt"].as_str().map(str::to_owned),
        types: configuration.types,
    };
    Ok(Some((context, stored)))
}

/// Rebuilds the recording facts from the copy an artifact stored.
fn stored_recording(inputs: &Value) -> Option<Context> {
    let stored = inputs.get("recording").filter(|v| v.is_object())?;
    Some(Context {
        metadata_revision: stored["metadata"]["revision"].as_i64().unwrap_or(0),
        configuration_revision: stored["configuration"]["revision"].as_i64().unwrap_or(0),
        type_source: stored["metadata"]["typeSource"].as_str().unwrap_or("automatic").to_owned(),
        type_id: stored["metadata"]["typeId"].as_str().map(str::to_owned),
        title_source: stored["metadata"]["titleSource"].as_str().unwrap_or("user").to_owned(),
        recorded_at: stored["metadata"]["recordedAt"].as_str().map(str::to_owned),
        types: serde_json::from_value(stored["configuration"]["types"].clone()).unwrap_or_default(),
    })
}

fn snapshot_of(ledger: &Ledger, stop: Option<i64>, limits: (i64, i64)) -> Result<transcript::Snapshot> {
    let bound = stop.unwrap_or_else(|| ledger.sources.iter().map(|s| s.end_ms).max().unwrap_or(0));
    transcript::snapshot_within(ledger, ledger.transcript_revision, bound, limits.0, limits.1, limits)
        .map_err(|_| Error::new("Transcript snapshot unavailable"))
}

/// The validation inputs an artifact was made from, rebuilt from its stored copy.
pub fn stored_inputs(artifact: &Value) -> Inputs {
    let inputs = &artifact["inputs"];
    let segments = inputs["transcript"]["segments"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|s| InputSegment {
                    meeting_id: s["meetingId"].as_str().unwrap_or_default().to_owned(),
                    segment_id: s["segmentId"].as_str().unwrap_or_default().to_owned(),
                    revision: s["revision"].as_i64().unwrap_or(0),
                    text: s["text"].as_str().unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default();
    Inputs {
        meeting_id: inputs["meetingId"].as_str().unwrap_or_default().to_owned(),
        notes_revision: inputs["notesRevision"].as_i64().unwrap_or(0),
        personal_notes: inputs["personalNotes"].as_str().unwrap_or_default().to_owned(),
        segments,
        recording: stored_recording(inputs),
    }
}

pub fn parse(text: &str) -> Result<Value> {
    Ok(serde_json::from_str(text)?)
}

/// The newest active artifact, if any.
pub fn head<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Option<Value>> {
    let reply = call(host, "head", meeting, json!({}))?;
    reply["artifactJson"].as_str().map(parse).transpose()
}

pub fn artifact<H: Host + ?Sized>(host: &H, meeting: &str, version: i64) -> Result<Option<Value>> {
    let reply = call(host, "artifact", meeting, json!({"version": version}))?;
    reply["artifactJson"].as_str().map(parse).transpose()
}

/// Revision numbers an artifact was made from, as a stale check needs them.
pub fn stale_against(artifact: &Value, now: &Current) -> bool {
    artifact["stale"] == true
        || artifact["inputs"]["notesRevision"].as_i64().unwrap_or(0) != now.notes_revision
        || artifact["inputs"]["transcript"]["transcriptRevision"].as_i64().unwrap_or(0) != now.transcript_revision
}

/// Search-display text of an overview. Mirrors the old history projection.
pub fn overview_text(value: &str) -> String {
    let flat: String = value.replace('\0', "");
    let spaced = flat.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    spaced.chars().take(240).collect()
}
