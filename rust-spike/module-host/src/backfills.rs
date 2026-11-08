//! Rust equivalents of the two release-frozen SQL sidecars. These run inside the
//! migration transaction, under its trusted owner; downloaded scripts never execute.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio_postgres::Transaction;

fn parse(text: &str, limit: usize) -> Result<Value> {
    ensure!(text.len() <= limit, "Legacy projection exceeds its limit");
    serde_json::from_str(text).context("Invalid legacy projection")
}
fn field<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v[name].as_str().context("Invalid legacy projection field")
}
fn integer(v: &Value) -> Result<i32> {
    let n = v.as_i64().context("Invalid legacy integer")?;
    Ok(n.try_into()?)
}
fn overview(text: &str) -> String {
    // ECMAScript whitespace also includes BOM. NUL is removed before collapsing it.
    text.replace('\0', "")
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}
pub async fn run(tx: &Transaction<'_>, path: &str) -> Result<()> {
    let result = match path {
        "sql/0280_meeting_history.sql" => history(tx).await,
        "sql/0292_meeting_minimal.sql" => minimal(tx).await,
        _ => anyhow::bail!("No compiled implementation for this legacy sidecar"),
    };
    // Do not expose retained row contents through PostgreSQL or JSON diagnostics.
    result
        .map_err(|_| anyhow::anyhow!("The frozen meeting projection failed; migration rolled back"))
}
async fn minimal(tx: &Transaction<'_>) -> Result<()> {
    tx.batch_execute("ALTER TABLE app.meeting_output_artifacts DISABLE ROW LEVEL SECURITY; ALTER TABLE app.meeting_capture_grants DISABLE ROW LEVEL SECURITY").await?;
    let mut after: Option<uuid::Uuid> = None;
    loop {
        let rows=tx.query("SELECT id,artifact_json FROM app.meeting_output_artifacts WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 8",&[&after]).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id: uuid::Uuid = row.get(0);
            let v = parse(row.get(1), 1_048_576)?;
            tx.execute(
                "UPDATE app.meeting_output_artifacts SET history_overview=$2 WHERE id=$1",
                &[&id, &overview(field(&v["content"], "overview")?)],
            )
            .await?;
            after = Some(id);
        }
    }
    after = None;
    loop {
        let rows=tx.query("SELECT id,state_json FROM app.meeting_capture_grants WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 8",&[&after]).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id: uuid::Uuid = row.get(0);
            let text: Option<String> = row.get(1);
            let duration = text
                .map(|s| parse(&s, 524_288))
                .transpose()?
                .and_then(|v| v["recordedDurationMs"].as_f64())
                .filter(|n| n.fract() == 0.0 && (0.0..=7_200_000.0).contains(n))
                .map(|n| n as i32);
            tx.execute(
                "UPDATE app.meeting_capture_grants SET recorded_duration_ms=$2 WHERE id=$1",
                &[&id, &duration],
            )
            .await?;
            after = Some(id);
        }
    }
    tx.batch_execute("ALTER TABLE app.meeting_output_artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE app.meeting_output_artifacts FORCE ROW LEVEL SECURITY; ALTER TABLE app.meeting_capture_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE app.meeting_capture_grants FORCE ROW LEVEL SECURITY").await?;
    Ok(())
}
async fn history(tx: &Transaction<'_>) -> Result<()> {
    let mut before: Option<uuid::Uuid> = None;
    loop {
        let meetings=tx.query("SELECT id,owner_user_id FROM app.meeting_records WHERE ($1::uuid IS NULL OR id<$1) ORDER BY id DESC LIMIT 30",&[&before]).await?;
        if meetings.is_empty() {
            break;
        }
        for meeting in meetings {
            let id: uuid::Uuid = meeting.get(0);
            let owner: uuid::Uuid = meeting.get(1);
            let mut segments = BTreeMap::<String, Value>::new();
            let mut version = 0_i32;
            let mut bytes = 0;
            loop {
                let rows=tx.query("SELECT version,input_json FROM app.meeting_transcript_batches WHERE meeting_id=$1 AND version>$2 ORDER BY version LIMIT 8",&[&id,&version]).await?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    let text: &str = row.get(1);
                    bytes += text.len();
                    ensure!(
                        bytes <= 32 * 1024 * 1024,
                        "Transcript exceeds migration limit"
                    );
                    let input = parse(text, 32 * 1024 * 1024)?;
                    for event in input["events"].as_array().context("Missing events")? {
                        let segment = &event["segment"];
                        let key = serde_json::to_string(&segment["segmentId"])?;
                        let rev = segment["revision"].as_f64().context("Missing revision")?;
                        if segments
                            .get(&key)
                            .is_none_or(|old| old["revision"].as_f64().unwrap_or(0.0) < rev)
                        {
                            segments.insert(key, segment.clone());
                        }
                    }
                    ensure!(segments.len() <= 20_000, "Too many retained segments");
                    let mut sources = Vec::new();
                    for source in input["sources"].as_array().context("Missing sources")? {
                        let pair = json!({"kind":source["kind"],"label":source["label"]});
                        if !sources.contains(&pair) {
                            sources.push(pair);
                        }
                    }
                    let omitted = sources.len().saturating_sub(4) as i32;
                    sources.truncate(4);
                    version = row.get(0);
                    tx.execute("UPDATE app.meeting_transcript_batches SET history_sources_json=$3,history_omitted_sources=$4 WHERE meeting_id=$1 AND version=$2",&[&id,&version,&serde_json::to_string(&sources)?,&omitted]).await?;
                }
            }
            for (key, s) in segments {
                tx.execute("INSERT INTO app.meeting_history_segments(meeting_id,owner_user_id,segment_key,revision,start_ms,end_ms,finality,search_terms) VALUES($1,$2,$3,$4,$5,$6,$7,tsvector_to_array(to_tsvector('simple'::regconfig,$8)))",&[&id,&owner,&key,&s["revision"].as_f64().context("Missing revision")?,&s["startMs"].as_f64().context("Missing start")?,&s["endMs"].as_f64().context("Missing end")?,&field(&s,"finality")?,&field(&s,"text")?]).await?;
            }
            project_rows(tx, id).await?;
            before = Some(id);
        }
    }
    for table in [
        "meeting_records",
        "meeting_transcript_batches",
        "meeting_history_segments",
        "meeting_output_requests",
        "meeting_output_artifacts",
        "meeting_export_receipts",
    ] {
        tx.batch_execute(&format!("ALTER TABLE app.{table} FORCE ROW LEVEL SECURITY"))
            .await?;
    }
    Ok(())
}
async fn project_rows(tx: &Transaction<'_>, id: uuid::Uuid) -> Result<()> {
    let mut after: Option<uuid::Uuid> = None;
    loop {
        let rows=tx.query("SELECT request_key,input_json,result_json FROM app.meeting_output_requests WHERE meeting_id=$1 AND ($2::uuid IS NULL OR request_key>$2) ORDER BY request_key LIMIT 8",&[&id,&after]).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let key: uuid::Uuid = row.get(0);
            let input = parse(row.get(1), 32 * 1024 * 1024)?;
            let result: Option<String> = row.get(2);
            let result = result
                .map(|s| parse(&s, 32 * 1024 * 1024))
                .transpose()?
                .unwrap_or(Value::Null);
            tx.execute("UPDATE app.meeting_output_requests SET history_kind=$3,history_result_status=$4,history_result_code=$5 WHERE meeting_id=$1 AND request_key=$2",&[&id,&key,&input["kind"].as_str(),&result["status"].as_str(),&result["code"].as_str()]).await?;
            after = Some(key);
        }
    }
    for (table, key, field_name) in [
        ("meeting_output_artifacts", "version", "artifact_json"),
        (
            "meeting_export_receipts",
            "artifact_version",
            "receipt_json",
        ),
    ] {
        let mut version = 0_i32;
        loop {
            let rows=tx.query(&format!("SELECT {key},{field_name} FROM app.{table} WHERE meeting_id=$1 AND {key}>$2 ORDER BY {key} LIMIT 8"),&[&id,&version]).await?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                version = row.get(0);
                let v = parse(row.get(1), 32 * 1024 * 1024)?;
                if table == "meeting_output_artifacts" {
                    tx.execute("UPDATE app.meeting_output_artifacts SET history_origin=$3,history_notes_revision=$4,history_transcript_revision=$5,history_stale=$6 WHERE meeting_id=$1 AND version=$2",&[&id,&version,&field(&v,"origin")?,&integer(&v["inputs"]["notesRevision"])?,&integer(v["inputs"]["transcript"]["transcriptRevision"].as_i64().map(Value::from).as_ref().unwrap_or(&json!(0)))?,&v["stale"].as_bool().context("Missing stale")?]).await?;
                } else {
                    tx.execute("UPDATE app.meeting_export_receipts SET history_write_status=$3,history_index_status=$4,history_updated_at=$5 WHERE meeting_id=$1 AND artifact_version=$2",&[&id,&version,&field(&v,"writeStatus")?,&field(&v,"indexStatus")?,&field(&v,"updatedAt")?]).await?;
                }
            }
        }
    }
    Ok(())
}
