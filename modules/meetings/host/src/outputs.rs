//! Summary storage. The guest keeps every rule. This side runs the SQL that typed guest queries
//! cannot express (row locks, clock reads, version counters), inside the call's actor
//! transaction, so row level security applies to every statement.
use anyhow::{bail, ensure, Result};
use safety_core::db::DataContext;
use serde::Deserialize;
use serde_json::{json, Value};

pub const OUTPUTS: &str = "meetings.outputs";

const MAX_VERSION: i32 = 1000;
const MAX_CANDIDATES: usize = 1000;
const MAX_ACTIONS: usize = 1000;

fn uuid(value: &str) -> Result<()> {
    ensure!(uuid::Uuid::parse_str(value).is_ok(), "Invalid id");
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    meeting_id: String,
    request_key: Option<String>,
    input_json: Option<String>,
    result_json: Option<String>,
    status: Option<String>,
    code: Option<String>,
    kind: Option<String>,
    ttl_seconds: Option<i64>,
    version: Option<i32>,
    versions: Option<Vec<i32>>,
    artifact_json: Option<String>,
    overview: Option<String>,
    origin: Option<String>,
    notes_revision: Option<i32>,
    transcript_revision: Option<i32>,
    stale: Option<bool>,
    actions: Option<Vec<ActionWrite>>,
    id: Option<String>,
    template_id: Option<String>,
    early_enqueued: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionWrite {
    identity: String,
    proposal_json: String,
}

pub async fn run(cx: &DataContext, operation: &str, parameters: &Value) -> Result<Value> {
    let p: Params = serde_json::from_value(parameters.clone())?;
    uuid(&p.meeting_id)?;
    let key = || -> Result<&str> {
        let key = p.request_key.as_deref().ok_or_else(|| anyhow::anyhow!("Request key required"))?;
        uuid(key)?;
        Ok(key)
    };
    let db = cx.db();
    let meeting = p.meeting_id.as_str();
    match operation {
        "get" | "lock" => {
            let lock = if operation == "lock" { "FOR UPDATE" } else { "FOR SHARE" };
            let row = db
                .query_opt(
                    &format!("SELECT owner_user_id::text,personal_notes,notes_revision FROM app.meeting_records WHERE id=$1::text::uuid {lock}"),
                    &[&meeting],
                )
                .await?;
            let Some(row) = row else { return Ok(json!({"found": false})) };
            let long_source: bool = db
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM app.meeting_recording_imports WHERE meeting_id=$1::text::uuid AND source_manifest_json IS NOT NULL)",
                    &[&meeting],
                )
                .await?
                .get(0);
            Ok(json!({"found": true, "ownerUserId": row.get::<_, String>(0), "personalNotes": row.get::<_, String>(1),
                "notesRevision": row.get::<_, i32>(2), "longSource": long_source}))
        }
        "head" => {
            let row = db
                .query_opt(
                    "SELECT artifact_json FROM app.meeting_output_artifacts WHERE meeting_id=$1::text::uuid AND NOT inactive ORDER BY version DESC LIMIT 1",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"artifactJson": row.map(|r| r.get::<_, String>(0))}))
        }
        "artifact" => {
            let version = p.version.ok_or_else(|| anyhow::anyhow!("Version required"))?;
            let row = db
                .query_opt(
                    "SELECT artifact_json FROM app.meeting_output_artifacts WHERE meeting_id=$1::text::uuid AND version=$2",
                    &[&meeting, &version],
                )
                .await?;
            Ok(json!({"artifactJson": row.map(|r| r.get::<_, String>(0))}))
        }
        "artifacts-meta" => {
            let rows = db
                .query(
                    "SELECT version,octet_length(artifact_json)::int FROM app.meeting_output_artifacts WHERE meeting_id=$1::text::uuid ORDER BY version DESC LIMIT 1000",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"items": rows.iter().map(|r| json!({"version": r.get::<_, i32>(0), "bytes": r.get::<_, i32>(1)})).collect::<Vec<_>>()}))
        }
        "artifacts" => {
            let versions = p.versions.unwrap_or_default();
            ensure!(versions.len() <= 1000, "Too many versions");
            let rows = db
                .query(
                    "SELECT artifact_json FROM app.meeting_output_artifacts WHERE meeting_id=$1::text::uuid AND version=ANY($2) ORDER BY version DESC",
                    &[&meeting, &versions],
                )
                .await?;
            Ok(json!({"items": rows.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>()}))
        }
        "candidates" => {
            let rows = db
                .query(
                    "SELECT id::text,artifact_version,proposal_json,possible_match_ids,review_state,accepted_task_id::text FROM app.meeting_action_candidates WHERE meeting_id=$1::text::uuid ORDER BY artifact_version,id LIMIT 1000",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"items": rows.iter().map(|r| json!({
                "id": r.get::<_, String>(0), "artifactVersion": r.get::<_, i32>(1), "proposalJson": r.get::<_, String>(2),
                "possibleMatchIds": r.get::<_, Value>(3), "reviewState": r.get::<_, String>(4),
                "acceptedTaskId": r.get::<_, Option<String>>(5)})).collect::<Vec<_>>()}))
        }
        "request" => {
            let key = key()?;
            let row = db
                .query_opt(
                    "SELECT input_json,result_json,expires_at<=clock_timestamp() FROM app.meeting_output_requests WHERE meeting_id=$1::text::uuid AND request_key=$2::text::uuid",
                    &[&meeting, &key],
                )
                .await?;
            Ok(match row {
                None => json!({"found": false}),
                Some(r) => json!({"found": true, "inputJson": r.get::<_, String>(0),
                    "resultJson": r.get::<_, Option<String>>(1), "expired": r.get::<_, bool>(2)}),
            })
        }
        "expire-pending" => {
            // Any generation whose reservation ran out is closed as interrupted.
            db.execute(
                "UPDATE app.meeting_output_requests SET result_json=json_build_object('status','failed','requestKey',request_key,'code','meeting_output_interrupted')::text,history_result_status='failed',history_result_code='meeting_output_interrupted' WHERE meeting_id=$1::text::uuid AND result_json IS NULL AND history_kind='generate' AND expires_at<=clock_timestamp()",
                &[&meeting],
            )
            .await?;
            let row = db
                .query_opt(
                    "SELECT request_key::text FROM app.meeting_output_requests WHERE meeting_id=$1::text::uuid AND result_json IS NULL AND history_kind='generate' AND expires_at>clock_timestamp() ORDER BY expires_at DESC LIMIT 1",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"pendingKey": row.map(|r| r.get::<_, String>(0))}))
        }
        "reserve" => {
            let key = key()?;
            let input = p.input_json.as_deref().ok_or_else(|| anyhow::anyhow!("Input required"))?;
            let kind = p.kind.as_deref();
            let ttl = p.ttl_seconds;
            ensure!(ttl.is_none_or(|t| (1..=3600).contains(&t)), "Invalid reservation time");
            db.execute(
                "INSERT INTO app.meeting_output_requests(meeting_id,request_key,input_json,history_kind,expires_at,result_json) VALUES($1::text::uuid,$2::text::uuid,$3,$4,coalesce(clock_timestamp()+($5::text||' seconds')::interval,clock_timestamp()+interval '2 minutes'),NULL)",
                &[&meeting, &key, &input, &kind, &ttl.map(|t| t.to_string())],
            )
            .await?;
            Ok(json!({}))
        }
        "finish" => {
            let key = key()?;
            let result = p.result_json.as_deref().ok_or_else(|| anyhow::anyhow!("Result required"))?;
            db.execute(
                "UPDATE app.meeting_output_requests SET result_json=$3,history_result_status=$4,history_result_code=$5 WHERE meeting_id=$1::text::uuid AND request_key=$2::text::uuid AND result_json IS NULL",
                &[&meeting, &key, &result, &p.status, &p.code],
            )
            .await?;
            Ok(json!({}))
        }
        "next" => {
            let version: i32 = db
                .query_one(
                    "SELECT coalesce(max(version),0)::int FROM app.meeting_output_artifacts WHERE meeting_id=$1::text::uuid",
                    &[&meeting],
                )
                .await?
                .get(0);
            let ids = db
                .query(
                    "SELECT id::text FROM app.meeting_action_candidates WHERE meeting_id=$1::text::uuid ORDER BY artifact_version,id LIMIT 1001",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"version": version + 1, "candidateIds": ids.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>()}))
        }
        "save" => {
            let (Some(id), Some(version), Some(json_text), Some(overview), Some(origin), Some(notes), Some(transcript), Some(stale)) = (
                p.id.as_deref(),
                p.version,
                p.artifact_json.as_deref(),
                p.overview.as_deref(),
                p.origin.as_deref(),
                p.notes_revision,
                p.transcript_revision,
                p.stale,
            ) else {
                bail!("Incomplete artifact write")
            };
            uuid(id)?;
            ensure!((1..=MAX_VERSION).contains(&version), "Artifact version out of range");
            let actions = p.actions.unwrap_or_default();
            ensure!(actions.len() <= MAX_ACTIONS, "Too many actions");
            db.execute(
                "INSERT INTO app.meeting_output_artifacts(id,meeting_id,version,artifact_json,history_overview,history_origin,history_notes_revision,history_transcript_revision,history_stale,inactive) VALUES($1::text::uuid,$2::text::uuid,$3,$4,$5,$6,$7,$8,$9,$9)",
                &[&id, &meeting, &version, &json_text, &overview, &origin, &notes, &transcript, &stale],
            )
            .await?;
            if !stale {
                let existing: Vec<String> = db
                    .query(
                        "SELECT id::text FROM app.meeting_action_candidates WHERE meeting_id=$1::text::uuid ORDER BY artifact_version,id LIMIT 1001",
                        &[&meeting],
                    )
                    .await?
                    .iter()
                    .map(|r| r.get(0))
                    .collect();
                ensure!(existing.len() + actions.len() <= MAX_CANDIDATES, "Too many candidates");
                let matches = serde_json::to_string(&existing)?;
                for action in &actions {
                    db.execute(
                        "INSERT INTO app.meeting_action_candidates(meeting_id,identity_key,artifact_version,proposal_json,possible_match_ids) VALUES($1::text::uuid,$2,$3,$4,$5::text::jsonb) ON CONFLICT(meeting_id,identity_key) DO NOTHING",
                        &[&meeting, &action.identity, &version, &action.proposal_json, &matches],
                    )
                    .await?;
                }
            }
            let created: String = db
                .query_one(
                    "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM app.meeting_output_artifacts WHERE id=$1::text::uuid",
                    &[&id],
                )
                .await?
                .get(0);
            Ok(json!({"createdAt": created}))
        }
        "summary" => {
            let row = db
                .query_opt(
                    "SELECT to_jsonb(s)-'owner_user_id' FROM app.meeting_stop_summaries s WHERE meeting_id=$1::text::uuid",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"row": row.map(|r| r.get::<_, Value>(0))}))
        }
        "summary-insert-manual" => {
            let key = key()?;
            let template = p.template_id.as_deref().ok_or_else(|| anyhow::anyhow!("Template required"))?;
            let revision = p.transcript_revision.ok_or_else(|| anyhow::anyhow!("Revision required"))?;
            db.execute(
                "INSERT INTO app.meeting_stop_summaries(meeting_id,manual_entry,transcript_revision,request_key,template_id,status,due_at) VALUES($1::text::uuid,true,$2,$3::text::uuid,$4,'waiting',clock_timestamp())",
                &[&meeting, &revision, &key, &template],
            )
            .await?;
            Ok(json!({}))
        }
        "summary-set" => {
            if let Some(input) = p.input_json.as_deref() {
                db.execute(
                    "UPDATE app.meeting_stop_summaries SET status='submitted',input_json=$2 WHERE meeting_id=$1::text::uuid",
                    &[&meeting, &input],
                )
                .await?;
            } else if let Some(code) = p.code.as_deref() {
                db.execute(
                    "UPDATE app.meeting_stop_summaries SET status='skipped',code=$2 WHERE meeting_id=$1::text::uuid",
                    &[&meeting, &code],
                )
                .await?;
            } else if let Some(early) = p.early_enqueued {
                db.execute(
                    "UPDATE app.meeting_stop_summaries SET early_enqueued=$2 WHERE meeting_id=$1::text::uuid",
                    &[&meeting, &early],
                )
                .await?;
            }
            Ok(json!({}))
        }
        _ => bail!("Unsupported Meetings outputs operation"),
    }
}
