//! Private export storage. The guest keeps every rule. This side runs the SQL, inside the
//! call's actor transaction, so row level security applies to every statement.
use anyhow::{ensure, Result};
use safety_core::db::DataContext;
use serde::Deserialize;
use serde_json::{json, Value};

pub const EXPORTS: &str = "meetings.exports";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    meeting_id: String,
    request_key: Option<String>,
    version: Option<i32>,
    content_hash: Option<String>,
    receipt_json: Option<String>,
    write_status: Option<String>,
    index_status: Option<String>,
    updated_at: Option<String>,
}

fn uuid(value: &str) -> Result<()> {
    ensure!(uuid::Uuid::parse_str(value).is_ok(), "Invalid id");
    Ok(())
}

pub async fn run(cx: &DataContext, operation: &str, parameters: &Value) -> Result<Value> {
    let p: Params = serde_json::from_value(parameters.clone())?;
    uuid(&p.meeting_id)?;
    let meeting = p.meeting_id.as_str();
    let db = cx.db();
    let version = || p.version.ok_or_else(|| anyhow::anyhow!("Version required"));
    let key = || -> Result<&str> {
        let key = p.request_key.as_deref().ok_or_else(|| anyhow::anyhow!("Request key required"))?;
        uuid(key)?;
        Ok(key)
    };
    match operation {
        "list" => {
            let rows = db
                .query(
                    "SELECT receipt_json FROM app.meeting_export_receipts WHERE meeting_id=$1::text::uuid ORDER BY artifact_version DESC LIMIT 1000",
                    &[&meeting],
                )
                .await?;
            Ok(json!({"items": rows.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>()}))
        }
        "request" => {
            let row = db
                .query_opt(
                    "SELECT artifact_version,result_json FROM app.meeting_export_requests WHERE meeting_id=$1::text::uuid AND request_key=$2::text::uuid",
                    &[&meeting, &key()?],
                )
                .await?;
            Ok(match row {
                None => json!({"found": false}),
                Some(r) => json!({"found": true, "artifactVersion": r.get::<_, i32>(0), "resultJson": r.get::<_, Option<String>>(1)}),
            })
        }
        "receipt" => {
            let row = db
                .query_opt(
                    "SELECT receipt_json,content_hash FROM app.meeting_export_receipts WHERE meeting_id=$1::text::uuid AND artifact_version=$2",
                    &[&meeting, &version()?],
                )
                .await?;
            Ok(match row {
                None => json!({"found": false}),
                Some(r) => json!({"found": true, "receiptJson": r.get::<_, String>(0), "contentHash": r.get::<_, String>(1)}),
            })
        }
        "intend" => {
            let (Some(hash), Some(receipt), Some(write), Some(index), Some(at)) =
                (&p.content_hash, &p.receipt_json, &p.write_status, &p.index_status, &p.updated_at)
            else {
                anyhow::bail!("Receipt fields required");
            };
            db.execute(
                "INSERT INTO app.meeting_export_receipts(meeting_id,artifact_version,content_hash,receipt_json,history_write_status,history_index_status,history_updated_at) VALUES($1::text::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
                &[&meeting, &version()?, hash, receipt, write, index, at],
            )
            .await?;
            Ok(json!({}))
        }
        "reserve" => {
            db.execute(
                "INSERT INTO app.meeting_export_requests(meeting_id,request_key,artifact_version,result_json) VALUES($1::text::uuid,$2::text::uuid,$3,NULL) ON CONFLICT DO NOTHING",
                &[&meeting, &key()?, &version()?],
            )
            .await?;
            Ok(json!({}))
        }
        "finish" => {
            let (Some(receipt), Some(write), Some(index), Some(at)) =
                (&p.receipt_json, &p.write_status, &p.index_status, &p.updated_at)
            else {
                anyhow::bail!("Receipt fields required");
            };
            db.execute(
                "UPDATE app.meeting_export_receipts SET receipt_json=$3,history_write_status=$4,history_index_status=$5,history_updated_at=$6 WHERE meeting_id=$1::text::uuid AND artifact_version=$2",
                &[&meeting, &version()?, receipt, write, index, at],
            )
            .await?;
            db.execute(
                "UPDATE app.meeting_export_requests SET result_json=$3 WHERE meeting_id=$1::text::uuid AND request_key=$2::text::uuid AND result_json IS NULL",
                &[&meeting, &key()?, receipt],
            )
            .await?;
            Ok(json!({}))
        }
        _ => anyhow::bail!("Unsupported Meetings exports operation"),
    }
}
