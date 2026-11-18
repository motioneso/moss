//! Guest side of the transcript store. The host runs the SQL; this module only shapes the data.
use crate::js::lossy_surrogates;
use crate::transcript::{Event, Ledger, Source};
use crate::transcript_batch::{Batch, Fail, MAX_BATCHES, MAX_STORAGE_BYTES};
use crate::transcript_routes::{history_sources, latest_segments};
use moss_module_sdk::{Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const TRANSCRIPTS: &str = "meetings.transcripts";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBatch {
    pub request_key: String,
    pub version: i64,
    pub input_json: String,
    pub transcript_revision: i64,
    pub cursor: i64,
    pub stop_cutoff_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub version: i64,
    pub transcript_revision: i64,
    pub cursor: i64,
    pub stop_cutoff_ms: Option<i64>,
}
impl StoredBatch {
    pub fn receipt(&self) -> Receipt {
        Receipt {
            version: self.version,
            transcript_revision: self.transcript_revision,
            cursor: self.cursor,
            stop_cutoff_ms: self.stop_cutoff_ms,
        }
    }
}

pub struct Stored {
    pub owner: String,
    pub bytes: i64,
    pub batches: Vec<StoredBatch>,
    pub ledger: Option<Ledger>,
}
impl Stored {
    pub fn receipt(&self) -> Receipt {
        self.batches.last().map(StoredBatch::receipt).unwrap_or(Receipt {
            version: 0,
            transcript_revision: 0,
            cursor: 0,
            stop_cutoff_ms: None,
        })
    }
}

/// Reads one meeting's stored batches and rebuilds its ledger. `exclusive` takes the write lock.
/// `Ok(Ok(None))` means the meeting is not visible to this person.
pub fn load<H: Host + ?Sized>(
    host: &H,
    meeting_id: &str,
    exclusive: bool,
) -> Result<std::result::Result<Option<Stored>, Fail>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        found: bool,
        owner_user_id: Option<String>,
        bytes: Option<i64>,
        batches: Option<Vec<StoredBatch>>,
    }
    let op = if exclusive { "lock" } else { "get" };
    let reply: Reply = serde_json::from_value(host.call("kv", op, TRANSCRIPTS, json!({"meetingId": meeting_id}))?)?;
    let (true, Some(owner), Some(bytes), Some(batches)) =
        (reply.found, reply.owner_user_id, reply.bytes, reply.batches)
    else {
        return Ok(Ok(None));
    };
    if bytes > MAX_STORAGE_BYTES || batches.len() > MAX_BATCHES {
        return Ok(Err(Fail::Limit));
    }
    #[derive(Deserialize)]
    struct Input {
        sources: Vec<Source>,
        events: Vec<Event>,
    }
    let mut ledger: Option<Ledger> = None;
    for batch in &batches {
        let Ok(input) = serde_json::from_str::<Input>(&lossy_surrogates(&batch.input_json)) else {
            return Ok(Err(Fail::Input));
        };
        let ledger = ledger.get_or_insert_with(|| Ledger::restored(meeting_id, &owner, vec![]));
        ledger.sources = input.sources;
        for event in &input.events {
            if event.cursor > ledger.cursor {
                ledger.push_stored(event);
            }
        }
        if ledger.cursor != batch.cursor || ledger.revisions.len() as i64 != batch.transcript_revision {
            return Ok(Err(Fail::Input));
        }
    }
    Ok(Ok(Some(Stored { owner, bytes, batches, ledger })))
}

/// Stores an accepted batch and its search rows, in the same transaction as the lock.
pub fn save<H: Host + ?Sized>(host: &H, batch: &Batch, encoded: &str, ledger: &Ledger) -> Result<()> {
    let (sources_json, omitted) = history_sources(&batch.sources);
    let segments: Vec<Value> = latest_segments(&batch.events)
        .into_iter()
        .map(|s| {
            json!({"key": serde_json::to_string(&s.segment_id).unwrap_or_default(), "revision": s.revision,
                "startMs": s.start_ms, "endMs": s.end_ms, "finality": s.finality, "text": s.text})
        })
        .collect();
    host.call(
        "kv",
        "set",
        TRANSCRIPTS,
        json!({"meetingId": batch.meeting_id, "requestKey": batch.request_key, "version": batch.expected_version + 1,
            "inputJson": encoded, "transcriptRevision": ledger.transcript_revision, "cursor": ledger.cursor,
            "stopCutoffMs": batch.stop_cutoff_ms, "sourcesJson": sources_json, "omittedSources": omitted,
            "segments": segments}),
    )?;
    Ok(())
}
