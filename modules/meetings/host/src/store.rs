//! Transcript storage and History reads. The guest keeps every rule. This side only runs the
//! SQL that typed guest queries cannot express (row locks, search terms, lateral joins), inside
//! the call's actor transaction, so row level security applies to every statement.
use anyhow::{bail, ensure, Result};
use safety_core::db::DataContext;
use serde::Deserialize;
use serde_json::{json, Value};

pub const TRANSCRIPTS: &str = "meetings.transcripts";
pub const HISTORY: &str = "meetings.history";

const BATCH_READ_LIMIT: i64 = 4097;
const HISTORY_TIMEOUT_MS: &str = "3000";
const WHITESPACE: &str = "\u{9}\u{a}\u{b}\u{c}\u{d} \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

fn uuid(value: &str) -> Result<()> {
    ensure!(uuid::Uuid::parse_str(value).is_ok(), "Invalid meeting id");
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lookup {
    meeting_id: String,
}

/// Locks the meeting row and returns what the guest needs to rebuild the ledger.
pub async fn read(cx: &DataContext, parameters: &Value, exclusive: bool) -> Result<Value> {
    let Lookup { meeting_id } = serde_json::from_value(parameters.clone())?;
    uuid(&meeting_id)?;
    let lock = if exclusive { "FOR UPDATE" } else { "FOR SHARE" };
    let Some(meeting) = cx
        .db()
        .query_opt(
            &format!("SELECT owner_user_id::text FROM app.meeting_records WHERE id=$1::text::uuid {lock}"),
            &[&meeting_id],
        )
        .await?
    else {
        return Ok(json!({"found": false}));
    };
    let bytes: i64 = cx
        .db()
        .query_one(
            "SELECT coalesce(sum(octet_length(input_json)),0)::bigint FROM app.meeting_transcript_batches WHERE meeting_id=$1::text::uuid",
            &[&meeting_id],
        )
        .await?
        .get(0);
    let rows = cx
        .db()
        .query(
            "SELECT request_key::text,version,input_json,transcript_revision,cursor,stop_cutoff_ms FROM app.meeting_transcript_batches WHERE meeting_id=$1::text::uuid ORDER BY version LIMIT $2",
            &[&meeting_id, &BATCH_READ_LIMIT],
        )
        .await?;
    let batches: Vec<Value> = rows
        .iter()
        .map(|row| {
            let stop: Option<f64> = row.get(5);
            json!({
                "requestKey": row.get::<_, String>(0),
                "version": row.get::<_, i32>(1),
                "inputJson": row.get::<_, String>(2),
                "transcriptRevision": row.get::<_, i32>(3),
                "cursor": row.get::<_, f64>(4) as i64,
                "stopCutoffMs": stop.map(|v| v as i64),
            })
        })
        .collect();
    Ok(json!({"found": true, "ownerUserId": meeting.get::<_, String>(0), "bytes": bytes, "batches": batches}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Write {
    meeting_id: String,
    request_key: String,
    version: i32,
    input_json: String,
    transcript_revision: i32,
    cursor: i64,
    stop_cutoff_ms: Option<i64>,
    sources_json: String,
    omitted_sources: i32,
    segments: Vec<SegmentWrite>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SegmentWrite {
    key: String,
    revision: i64,
    start_ms: i64,
    end_ms: i64,
    finality: String,
    text: String,
}

/// Stores one accepted batch and refreshes the search rows of the segments it touched.
pub async fn write(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let w: Write = serde_json::from_value(parameters.clone())?;
    uuid(&w.meeting_id)?;
    uuid(&w.request_key)?;
    ensure!(w.segments.len() <= 100, "Too many transcript segments");
    cx.db()
        .execute(
            "INSERT INTO app.meeting_transcript_batches(meeting_id,request_key,version,input_json,transcript_revision,cursor,stop_cutoff_ms,history_sources_json,history_omitted_sources) VALUES($1::text::uuid,$2::text::uuid,$3,$4,$5,$6,$7,$8,$9)",
            &[
                &w.meeting_id,
                &w.request_key,
                &w.version,
                &w.input_json,
                &w.transcript_revision,
                &(w.cursor as f64),
                &w.stop_cutoff_ms.map(|v| v as f64),
                &w.sources_json,
                &w.omitted_sources,
            ],
        )
        .await?;
    for s in &w.segments {
        cx.db()
            .execute(
                "INSERT INTO app.meeting_history_segments(meeting_id,segment_key,revision,start_ms,end_ms,finality,search_terms) VALUES($1::text::uuid,$2,$3,$4,$5,$6,tsvector_to_array(to_tsvector('simple'::regconfig,$7))) ON CONFLICT(meeting_id,segment_key) DO UPDATE SET revision=EXCLUDED.revision,start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms,finality=EXCLUDED.finality,search_terms=EXCLUDED.search_terms WHERE app.meeting_history_segments.revision<EXCLUDED.revision",
                &[
                    &w.meeting_id,
                    &s.key,
                    &(s.revision as f64),
                    &(s.start_ms as f64),
                    &(s.end_ms as f64),
                    &s.finality,
                    &s.text,
                ],
            )
            .await?;
    }
    Ok(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    id: Option<String>,
    query: String,
    filter: String,
    limit: i64,
    before: Option<Cursor>,
    type_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    id: String,
    #[serde(rename = "dateAt")]
    date_at: String,
}

fn state_filter(filter: &str) -> Result<&'static str> {
    Ok(match filter {
        "transcript" => "segment_count > 0",
        "notes-only" => "has_notes AND segment_count = 0",
        "exported" => "saved_count > 0",
        "needs-review" => "pending_count > 0 OR provisional_count > 0 OR (output_version IS NOT NULL AND output_stale) OR generation_status IN ('failed','interrupted') OR vault_write_status IN ('failed','conflict') OR vault_index_status IN ('delayed','conflict')",
        "all" => "true",
        _ => bail!("Unknown History filter"),
    })
}

/// One History page. Returns the raw rows as JSON, or `tooManyTerms` when the search text
/// splits into more than 16 search terms.
pub async fn history(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let s: Search = serde_json::from_value(parameters.clone())?;
    ensure!((1..=50).contains(&s.limit), "Invalid History limit");
    cx.db()
        .execute("SELECT set_config('statement_timeout',$1,true)", &[&HISTORY_TIMEOUT_MS])
        .await?;
    let mut terms: Vec<String> = vec![];
    if !s.query.is_empty() {
        terms = cx
            .db()
            .query_one(
                "SELECT tsvector_to_array(to_tsvector('simple'::regconfig,$1::text))",
                &[&s.query],
            )
            .await?
            .get(0);
        if terms.len() > 16 {
            return Ok(json!({"tooManyTerms": true}));
        }
        if terms.is_empty() {
            return Ok(json!({"rows": []}));
        }
    }
    let (cursor_at, cursor_id) = match &s.before {
        Some(c) => (Some(c.date_at.clone()), Some(c.id.clone())),
        None => (None, None),
    };
    let mut search = String::from("true");
    for i in 0..terms.len() {
        let n = 6 + i;
        search.push_str(&format!(
            " AND r.id IN (SELECT d.id FROM app.meeting_records d WHERE d.owner_user_id=app.current_actor_user_id() AND d.history_search_terms @> ARRAY[${n}]::text[] UNION SELECT g.meeting_id FROM app.meeting_history_segments g WHERE g.owner_user_id=app.current_actor_user_id() AND g.search_terms @> ARRAY[${n}]::text[])"
        ));
    }
    let early = if s.filter == "all" { format!("LIMIT {}", s.limit + 1) } else { String::new() };
    let sql = HISTORY_SQL
        .replace("/*SEARCH*/", &search)
        .replace("/*EARLY*/", &early)
        .replace("/*STATE*/", state_filter(&s.filter)?)
        .replace("/*LIMIT*/", &(s.limit + 1).to_string());
    let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        vec![&s.id, &cursor_at, &cursor_id, &s.type_id, &WHITESPACE];
    for term in &terms {
        params.push(term);
    }
    let rows = cx.db().query(&sql, &params).await?;
    Ok(json!({"rows": rows.iter().map(|r| r.get::<_, Value>(0)).collect::<Vec<_>>()}))
}

/// The read the TypeScript History used. Only scalar and index reads, no transcript rebuild.
const HISTORY_SQL: &str = r#"
WITH records AS MATERIALIZED (
  SELECT r.id,r.title,r.created_at,r.updated_at,r.notes_revision,m.type_id,m.side AS recording_side,
    m.recorded_at,coalesce(m.recorded_at,r.created_at) AS history_date,
    btrim(r.personal_notes,$5::text)<>'' AS has_notes
  FROM app.meeting_records r
  LEFT JOIN app.meeting_recording_metadata m ON m.meeting_id=r.id
  WHERE r.owner_user_id=app.current_actor_user_id()
    AND ($1::text IS NULL OR r.id=$1::text::uuid)
    AND ($2::text IS NULL OR (coalesce(m.recorded_at,r.created_at),r.id)<($2::text::timestamptz,$3::text::uuid))
    AND ($4::text IS NULL OR m.type_id=$4::text)
    AND /*SEARCH*/
  ORDER BY history_date DESC,r.id DESC /*EARLY*/
), history AS (
  SELECT r.*,capture.duration_ms AS capture_duration_ms,imp.import_metadata_json,
    coalesce(a.history_overview,n.history_overview) AS output_overview,
    coalesce(t.transcript_revision,0) AS transcript_revision,
    s.segment_count,s.final_count,s.provisional_count,s.start_ms,s.end_ms,
    coalesce(t.history_sources_json,'[]') AS sources_json,coalesce(t.history_omitted_sources,0) AS omitted_sources,
    coalesce(a.version,n.version) AS output_version,coalesce(a.history_origin,n.history_origin) AS output_origin,
    coalesce(a.created_at,n.created_at) AS output_created_at,
    (coalesce(a.inactive,n.inactive,false) OR coalesce(a.history_stale,n.history_stale,false) OR
      coalesce(a.history_notes_revision,n.history_notes_revision) IS DISTINCT FROM r.notes_revision OR
      coalesce(a.history_transcript_revision,n.history_transcript_revision) IS DISTINCT FROM coalesce(t.transcript_revision,0)) AS output_stale,
    CASE WHEN g.request_key IS NULL THEN NULL
      WHEN g.history_result_status IS NULL THEN CASE WHEN g.expires_at<=statement_timestamp() THEN 'interrupted' ELSE 'pending' END
      WHEN g.history_result_status='failed' THEN CASE WHEN g.history_result_code='meeting_output_interrupted' THEN 'interrupted' ELSE 'failed' END
      ELSE 'saved' END AS generation_status,
    g.expires_at AS generation_expires_at,
    c.pending_count,c.accepted_count,c.dismissed_count,
    v.artifact_version AS vault_version,v.history_write_status AS vault_write_status,
    v.history_index_status AS vault_index_status,v.history_updated_at AS vault_updated_at,
    saved.saved_count
  FROM records r
  LEFT JOIN LATERAL (
    SELECT recorded_duration_ms AS duration_ms
    FROM app.meeting_capture_grants WHERE meeting_id=r.id AND state_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1
  ) capture ON true
  LEFT JOIN LATERAL (
    SELECT metadata_json AS import_metadata_json
    FROM app.meeting_recording_imports WHERE meeting_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1
  ) imp ON true
  LEFT JOIN LATERAL (
    SELECT transcript_revision,history_sources_json,history_omitted_sources
    FROM app.meeting_transcript_batches WHERE meeting_id=r.id ORDER BY version DESC LIMIT 1
  ) t ON true
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS segment_count,count(*) FILTER (WHERE finality='final')::int AS final_count,
      count(*) FILTER (WHERE finality='provisional')::int AS provisional_count,min(start_ms) AS start_ms,max(end_ms) AS end_ms
    FROM app.meeting_history_segments WHERE meeting_id=r.id
  ) s
  LEFT JOIN LATERAL (
    SELECT version,history_origin,created_at,inactive,history_stale,history_notes_revision,history_transcript_revision,history_overview
    FROM app.meeting_output_artifacts WHERE meeting_id=r.id AND NOT inactive ORDER BY version DESC LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT version,history_origin,created_at,inactive,history_stale,history_notes_revision,history_transcript_revision,history_overview
    FROM app.meeting_output_artifacts WHERE meeting_id=r.id ORDER BY version DESC LIMIT 1
  ) n ON a.version IS NULL
  LEFT JOIN LATERAL (
    SELECT request_key,expires_at,history_result_status,history_result_code
    FROM app.meeting_output_requests WHERE meeting_id=r.id AND history_kind='generate'
    ORDER BY expires_at DESC,request_key DESC LIMIT 1
  ) g ON true
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE review_state='pending')::int AS pending_count,
      count(*) FILTER (WHERE review_state='accepted')::int AS accepted_count,
      count(*) FILTER (WHERE review_state='dismissed')::int AS dismissed_count
    FROM app.meeting_action_candidates WHERE meeting_id=r.id
  ) c
  LEFT JOIN LATERAL (
    SELECT artifact_version,history_write_status,history_index_status,history_updated_at
    FROM app.meeting_export_receipts WHERE meeting_id=r.id
    ORDER BY history_updated_at DESC,artifact_version DESC LIMIT 1
  ) v ON true
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS saved_count FROM app.meeting_export_receipts
    WHERE meeting_id=r.id AND history_write_status='saved'
  ) saved
)
SELECT to_jsonb(q) FROM (
  SELECT * FROM history WHERE /*STATE*/ ORDER BY history_date DESC,id DESC LIMIT /*LIMIT*/
) q ORDER BY q.history_date DESC,q.id DESC
"#;
