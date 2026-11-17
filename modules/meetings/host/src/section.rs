//! The account export section. Each collection reads the signed-in account's rows through the
//! call's actor transaction, so row level security applies, and renders timestamps as the
//! millisecond ISO text the legacy export used. Ready recording imports also carry their stored
//! audio, read and verified here.
use crate::recordings::Recordings;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};

/// How a column is turned into JSON.
#[derive(Clone, Copy)]
enum K {
    /// Passed through as stored.
    Plain,
    /// A uuid, as text.
    Uuid,
    /// A timestamp, as ISO text with milliseconds.
    Time,
    /// An array of timestamps.
    Times,
}
use K::{Plain as P, Time as T, Times as TS, Uuid as U};

const ISO: &str = "YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"";

struct Collection {
    name: &'static str,
    table: &'static str,
    order: &'static str,
    columns: &'static [(&'static str, &'static str, K)],
}

const COLLECTIONS: &[Collection] = &[
    Collection {
        name: "recording_types",
        table: "meeting_recording_types",
        order: "owner_user_id",
        columns: &[("owner_user_id", "ownerUserId", U), ("revision", "revision", P), ("types_json", "typesJson", P)],
    },
    Collection {
        name: "recording_metadata",
        table: "meeting_recording_metadata",
        order: "meeting_id",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("revision", "revision", P),
            ("type_id", "typeId", P),
            ("type_source", "typeSource", P),
            ("title_source", "titleSource", P),
            ("side", "side", P),
            ("confidence", "confidence", P),
            ("reason", "reason", P),
            ("recorded_at", "recordedAt", T),
            ("source", "source", P),
            ("output_version", "outputVersion", P),
        ],
    },
    Collection {
        name: "manual_entries",
        table: "meeting_manual_entries",
        order: "meeting_id",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("request_key", "requestKey", U),
            ("input_hash", "inputHash", P),
            ("transcript_revision", "transcriptRevision", P),
        ],
    },
    Collection {
        name: "voice_enablements",
        table: "meeting_recording_voice_enablements",
        order: "enabled_at, id",
        columns: &[
            ("id", "id", U),
            ("owner_user_id", "ownerUserId", U),
            ("source_device_id", "sourceDeviceId", U),
            ("request_key", "requestKey", U),
            ("inventory_json", "inventoryJson", P),
            ("enabled_at", "enabledAt", T),
            ("disabled_at", "disabledAt", T),
        ],
    },
    Collection {
        name: "recording_imports",
        table: "meeting_recording_imports",
        order: "created_at, id",
        columns: &[
            ("id", "id", U),
            ("owner_user_id", "ownerUserId", U),
            ("meeting_id", "meetingId", U),
            ("source_device_id", "sourceDeviceId", U),
            ("recording_id", "recordingId", P),
            ("fingerprint", "fingerprint", P),
            ("metadata_json", "metadataJson", P),
            ("ready", "ready", P),
            ("state", "state", P),
            ("attempts", "attempts", P),
            ("code", "code", P),
            ("voice_enablement_id", "voiceEnablementId", U),
            ("voice_automatic", "voiceAutomatic", P),
            ("voice_captured_at", "voiceCapturedAt", T),
            ("voice_request_id", "voiceRequestId", U),
            ("source_manifest_json", "sourceManifestJson", P),
            ("upload_reserved", "uploadReserved", P),
            ("upload_expires_at", "uploadExpiresAt", T),
            ("next_window_ms", "nextWindowMs", P),
            ("transcript_version", "transcriptVersion", P),
            ("transcript_cursor", "transcriptCursor", P),
            ("voice_transcript", "voiceTranscript", P),
            ("created_at", "createdAt", T),
        ],
    },
    Collection {
        name: "transcript_batches",
        table: "meeting_transcript_batches",
        order: "meeting_id, version",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("request_key", "requestKey", U),
            ("version", "version", P),
            ("input_json", "inputJson", P),
            ("transcript_revision", "transcriptRevision", P),
            ("cursor", "cursor", P),
            ("stop_cutoff_ms", "stopCutoffMs", P),
            ("created_at", "createdAt", T),
        ],
    },
    Collection {
        name: "output_requests",
        table: "meeting_output_requests",
        order: "meeting_id, request_key",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("request_key", "requestKey", U),
            ("input_json", "inputJson", P),
            ("expires_at", "expiresAt", T),
            ("result_json", "resultJson", P),
        ],
    },
    Collection {
        name: "output_artifacts",
        table: "meeting_output_artifacts",
        order: "meeting_id, version",
        columns: &[
            ("id", "id", U),
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("version", "version", P),
            ("artifact_json", "artifactJson", P),
            ("inactive", "inactive", P),
            ("created_at", "createdAt", T),
        ],
    },
    Collection {
        name: "action_candidates",
        table: "meeting_action_candidates",
        order: "meeting_id, artifact_version, id",
        columns: &[
            ("id", "id", U),
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("identity_key", "identityKey", P),
            ("artifact_version", "artifactVersion", P),
            ("proposal_json", "proposalJson", P),
            ("possible_match_ids", "possibleMatchIds", P),
            ("review_state", "reviewState", P),
            ("accepted_task_id", "acceptedTaskId", U),
        ],
    },
    Collection {
        name: "export_receipts",
        table: "meeting_export_receipts",
        order: "meeting_id, artifact_version",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("artifact_version", "artifactVersion", P),
            ("content_hash", "contentHash", P),
            ("receipt_json", "receiptJson", P),
        ],
    },
    Collection {
        name: "export_requests",
        table: "meeting_export_requests",
        order: "meeting_id, request_key",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("request_key", "requestKey", U),
            ("artifact_version", "artifactVersion", P),
            ("result_json", "resultJson", P),
        ],
    },
    Collection {
        name: "stop_summaries",
        table: "meeting_stop_summaries",
        order: "created_at, meeting_id",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("grant_id", "grantId", U),
            ("recording_import_id", "recordingImportId", U),
            ("manual_entry", "manualEntry", P),
            ("transcript_revision", "transcriptRevision", P),
            ("request_key", "requestKey", U),
            ("template_id", "templateId", P),
            ("status", "status", P),
            ("code", "code", P),
            ("due_at", "dueAt", T),
            ("created_at", "createdAt", T),
            ("early_enqueued", "earlyEnqueued", P),
            ("input_json", "inputJson", P),
        ],
    },
    Collection {
        name: "capture_grants",
        table: "meeting_capture_grants",
        order: "created_at, id",
        columns: &[
            ("id", "id", U),
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("device_name", "deviceName", P),
            ("status", "status", P),
            ("state_json", "stateJson", P),
            ("created_at", "createdAt", T),
            ("expires_at", "expiresAt", T),
        ],
    },
    Collection {
        name: "capture_connections",
        table: "meeting_capture_connections",
        order: "device_id",
        columns: &[
            ("device_id", "deviceId", U),
            ("owner_user_id", "ownerUserId", U),
            ("device_name", "deviceName", P),
            ("inventory_json", "inventoryJson", P),
            ("last_seen_at", "lastSeenAt", T),
            ("expires_at", "expiresAt", T),
        ],
    },
    Collection {
        name: "capture_start_cancellations",
        table: "meeting_capture_start_cancellations",
        order: "created_at, request_key",
        columns: &[
            ("meeting_id", "meetingId", U),
            ("owner_user_id", "ownerUserId", U),
            ("request_key", "requestKey", U),
            ("created_at", "createdAt", T),
        ],
    },
    Collection {
        name: "capture_start_limits",
        table: "meeting_capture_start_limits",
        order: "owner_user_id",
        columns: &[("owner_user_id", "ownerUserId", U), ("started_at", "startedAt", TS)],
    },
];

/// The collections this reader serves. The typed reads in the guest cover the other two.
pub fn names() -> Vec<&'static str> {
    COLLECTIONS.iter().map(|c| c.name).collect()
}

fn expression(column: &str, kind: K) -> String {
    match kind {
        K::Plain => column.to_owned(),
        K::Uuid => format!("{column}::text"),
        K::Time => format!("to_char({column} AT TIME ZONE 'UTC','{ISO}')"),
        K::Times => format!(
            "(SELECT coalesce(jsonb_agg(to_char(x AT TIME ZONE 'UTC','{ISO}') ORDER BY ord),'[]'::jsonb) FROM unnest({column}) WITH ORDINALITY AS u(x,ord))"
        ),
    }
}

fn statement(collection: &Collection) -> String {
    let pairs: Vec<String> = collection
        .columns
        .iter()
        .map(|(column, name, kind)| format!("'{name}',{}", expression(column, *kind)))
        .collect();
    format!(
        "SELECT coalesce(jsonb_agg(r ORDER BY ord),'[]'::jsonb) FROM (SELECT jsonb_build_object({}) AS r, row_number() OVER (ORDER BY {}) AS ord FROM app.{} WHERE owner_user_id=app.current_actor_user_id()) AS rows",
        pairs.join(","),
        collection.order,
        collection.table
    )
}

pub async fn collect(
    cx: &DataContext,
    recordings: Option<&Recordings>,
    access: &AccessContext,
) -> Result<Value> {
    let mut section = Map::new();
    for collection in COLLECTIONS {
        let row = cx.db().query_one(statement(collection).as_str(), &[]).await?;
        let mut items: Vec<Value> = serde_json::from_value(row.get::<_, Value>(0))?;
        if collection.name == "recording_imports" {
            for item in &mut items {
                attach_audio(cx, recordings, access, item).await?;
            }
        }
        section.insert(collection.name.into(), Value::Array(items));
    }
    Ok(Value::Object(section))
}

/// Ready imports carry their audio. A manifest-based import lists verified chunks. A legacy one
/// keeps its retained bundle text.
async fn attach_audio(
    cx: &DataContext,
    recordings: Option<&Recordings>,
    access: &AccessContext,
    item: &mut Value,
) -> Result<()> {
    if item["ready"] != json!(true) {
        return Ok(());
    }
    let id = item["id"].as_str().unwrap_or_default().to_owned();
    ensure!(
        recordings.is_some(),
        "Recording audio storage is not configured, so the export cannot include it"
    );
    let recordings = recordings.expect("checked");
    if item["sourceManifestJson"].is_string() {
        let rows = cx
            .db()
            .query(
                "SELECT kind,chunk_index,byte_length,sha256 FROM app.meeting_recording_chunks WHERE import_id=$1::text::uuid AND owner_user_id=app.current_actor_user_id() ORDER BY kind,chunk_index",
                &[&id],
            )
            .await?;
        let mut chunks = Vec::new();
        for row in rows {
            let kind: String = row.get(0);
            let index: i32 = row.get(1);
            let length: i32 = row.get(2);
            let hash: String = row.get(3);
            let base64 = recordings.chunk(access, &id, &kind, index, length, &hash)?;
            chunks.push(json!({"kind": kind, "index": index, "byteLength": length, "sha256": hash, "base64": base64}));
        }
        item["chunks"] = Value::Array(chunks);
    } else {
        item["bundleJson"] = Value::String(recordings.bundle(access, &id)?);
    }
    Ok(())
}
