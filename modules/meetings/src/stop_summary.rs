//! Automatic summary after a recording stops or a transcript is pasted. A row per meeting records
//! the intent, a metadata-only job picks it up, and `admit` decides under the meeting lock whether
//! a summary should still be written.
use crate::output_service::Generate;
use crate::output_validation::template;
use crate::outputs;
use crate::preferences;
use chrono::{DateTime, Utc};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

pub const QUEUE: &str = "meetings.stop-summary";

/// How long a waiting intent stays valid after its due time.
const CAPTURE_WAIT_MS: i64 = 300_000;
const LONG_WAIT_MS: i64 = 1_209_600_000;

fn parse_time(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

fn now<H: Host + ?Sized>(host: &H) -> Result<DateTime<Utc>> {
    let context = host.call("context", "read", "call", json!({}))?;
    parse_time(&context["now"]).ok_or_else(|| Error::new("Clock unavailable"))
}

fn row<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Option<Value>> {
    let reply = outputs::call(host, "summary", meeting, json!({}))?;
    Ok(reply["row"].as_object().map(|_| reply["row"].clone()))
}

fn skip<H: Host + ?Sized>(host: &H, meeting: &str, code: &str) -> Result<Option<Generate>> {
    outputs::call(host, "summary-set", meeting, json!({"code": code}))?;
    Ok(None)
}

fn wait_ms(row: &Value) -> i64 {
    if !row["recording_import_id"].is_null() || row["manual_entry"] == true {
        LONG_WAIT_MS
    } else {
        CAPTURE_WAIT_MS
    }
}

fn first<H: Host + ?Sized>(host: &H, table: &str, column: &str, value: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq(column, value));
    query.limit = Some(1);
    Ok(Client(host).query(table, &query)?.into_iter().next())
}

/// The fixed input to generate with, or `None` when the summary should not run. Runs under the
/// meeting lock. A refusal is stored on the row so the screen can say why.
pub fn admit<H: Host + ?Sized>(host: &H, meeting: &str, key: &str) -> Result<Option<Generate>> {
    let Some(row) = row(host, meeting)? else { return Ok(None) };
    if row["request_key"].as_str() != Some(key) || row["status"] == "skipped" {
        return Ok(None);
    }
    if let Some(text) = row["input_json"].as_str() {
        return Ok(Some(serde_json::from_str(text)?));
    }
    let due = parse_time(&row["due_at"]).ok_or_else(|| Error::new("Summary row is invalid"))?;
    let clock = now(host)?;
    if due.timestamp_millis() + wait_ms(&row) <= clock.timestamp_millis() {
        return skip(host, meeting, "meeting_output_interrupted");
    }
    if let Some(import) = row["recording_import_id"].as_str() {
        let state = first(host, "app.meeting_recording_imports", "id", import)?;
        let complete = state.is_some_and(|s| s["meeting_id"].as_str() == Some(meeting) && s["state"] == "complete");
        if !complete {
            return skip(host, meeting, "import-interrupted");
        }
    } else if row["manual_entry"] == true {
        let entry = first(host, "app.meeting_manual_entries", "meeting_id", meeting)?;
        if entry.is_none_or(|e| e["transcript_revision"] != row["transcript_revision"]) {
            return skip(host, meeting, "manual-entry-interrupted");
        }
    } else {
        let grant = match row["grant_id"].as_str() {
            Some(id) => first(host, "app.meeting_capture_grants", "id", id)?,
            None => None,
        };
        let grant = grant.filter(|g| g["meeting_id"].as_str() == Some(meeting));
        let state: Option<Value> = grant
            .as_ref()
            .and_then(|g| g["state_json"].as_str())
            .and_then(|text| serde_json::from_str(text).ok());
        let stopped = state.as_ref().is_some_and(|s| s["desired"] == "stopped" && !s["stopCutoffMs"].is_null());
        if !stopped || grant.as_ref().is_some_and(|g| g["status"] == "revoked") {
            return skip(host, meeting, "capture-interrupted");
        }
        let state = state.unwrap_or(Value::Null);
        let deadline = parse_time(&state["finalizationDeadline"]);
        if state["finalized"] != true && deadline.is_none_or(|d| d >= clock) {
            return Err(Error::new("Meeting finalization is still pending"));
        }
    }
    if row["manual_entry"] != true && preferences::current(host)?["summarizeOnStop"] != true {
        return skip(host, meeting, "setting-off");
    }
    if outputs::head(host, meeting)?.is_some() {
        return skip(host, meeting, "existing-output");
    }
    if outputs::call(host, "expire-pending", meeting, json!({}))?["pendingKey"].is_string() {
        return skip(host, meeting, "existing-request");
    }
    let Some(inputs) = outputs::inputs(host, meeting, false)? else { return Ok(None) };
    if (!row["recording_import_id"].is_null() || row["manual_entry"] == true)
        && row["transcript_revision"].as_i64() != Some(inputs.transcript_revision)
    {
        return skip(host, meeting, "transcript-changed");
    }
    if inputs.provisional || !inputs.final_text {
        return skip(host, meeting, "no-meaningful-transcript");
    }
    let Some(chosen) = row["template_id"].as_str().and_then(|id| template(id, 1)) else {
        return skip(host, meeting, "template-unavailable");
    };
    let input = Generate {
        request_key: key.to_owned(),
        expected_output_version: 0,
        expected_transcript_revision: inputs.transcript_revision,
        expected_notes_revision: inputs.notes_revision,
        template_id: chosen.id.to_owned(),
        template_version: chosen.version,
    };
    outputs::call(
        host,
        "summary-set",
        meeting,
        json!({"inputJson": json!({"requestKey": key, "expectedOutputVersion": 0,
            "expectedTranscriptRevision": input.expected_transcript_revision,
            "expectedNotesRevision": input.expected_notes_revision,
            "templateId": input.template_id, "templateVersion": input.template_version}).to_string()}),
    )?;
    Ok(Some(input))
}

/// The state shown on the summary screen, or `None` when no automatic summary was planned.
pub fn status<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Value> {
    let Some(row) = row(host, meeting)? else { return Ok(Value::Null) };
    let key = row["request_key"].clone();
    let code = row["code"].as_str();
    if row["status"] == "skipped" {
        let mut out = json!({"status": if code.is_some_and(|c| c.starts_with("meeting_output_")) { "failed" } else { "skipped" },
            "requestKey": key, "expiresAt": null});
        if let Some(code) = code {
            out["code"] = json!(code);
        }
        return Ok(out);
    }
    let request = outputs::call(host, "request", meeting, json!({"requestKey": row["request_key"]}))?;
    if request["found"] != true {
        let due = parse_time(&row["due_at"]).ok_or_else(|| Error::new("Summary row is invalid"))?;
        let expires = due.timestamp_millis() + wait_ms(&row);
        let gone = expires <= now(host)?.timestamp_millis();
        let mut out = json!({"status": if gone { "failed" } else { "waiting" }, "requestKey": key,
            "expiresAt": DateTime::<Utc>::from_timestamp_millis(expires).map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())});
        if gone {
            out["code"] = json!("meeting_output_interrupted");
        }
        return Ok(out);
    }
    let Some(text) = request["resultJson"].as_str() else {
        let gone = request["expired"] == true;
        let mut out = json!({"status": if gone { "failed" } else { "pending" }, "requestKey": key,
            "expiresAt": request["expiresAt"]});
        if gone {
            out["code"] = json!("meeting_output_interrupted");
        }
        return Ok(out);
    };
    let result: Value = outputs::parse(text)?;
    let mut out = json!({"status": result["status"], "requestKey": key, "expiresAt": null});
    if let Some(code) = result["code"].as_str() {
        out["code"] = json!(code);
    }
    Ok(out)
}

/// Queues the summary job. The idempotency key makes a repeat call a no-op.
pub fn enqueue<H: Host + ?Sized>(host: &H, meeting: &str, key: &str, available_at: &str) -> Result<()> {
    host.call(
        "jobs",
        "enqueue-after-commit",
        QUEUE,
        json!({"params": {"meeting-id": meeting}, "idempotencyKey": key, "availableAt": available_at}),
    )?;
    Ok(())
}

/// Records a pasted transcript's intent and asks for its job. The job is published after the
/// transaction commits, so a failed publish can leave the paste saved without a job.
pub fn schedule_manual<H: Host + ?Sized>(host: &H, meeting: &str, revision: i64, template_id: &str) -> Result<()> {
    let key = host.call("context", "uuid", "new", json!({}))?["id"].as_str().unwrap_or_default().to_owned();
    outputs::call(
        host,
        "summary-insert-manual",
        meeting,
        json!({"requestKey": key, "templateId": template_id, "transcriptRevision": revision}),
    )?;
    let at = host.call("context", "read", "call", json!({}))?["now"].as_str().unwrap_or_default().to_owned();
    enqueue(host, meeting, &key, &at)
}

/// Called whenever a capture stops or its status changes after a stop. The first call after a
/// stop records the intent and queues the job at the finalization deadline. A later call, once
/// the Mac confirms it finished, queues one early run. Both keys make a repeat a no-op.
pub fn schedule_capture<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    grant: &str,
    deadline: &str,
    finalized: bool,
    stopped_now: bool,
) -> Result<()> {
    let mut existing = row(host, meeting)?;
    if existing.is_none() && stopped_now {
        let prefs = preferences::current(host)?;
        let key = host.call("context", "uuid", "new", json!({}))?["id"].as_str().unwrap_or_default().to_owned();
        let on = prefs["summarizeOnStop"] == json!(true);
        let mut params = json!({"requestKey": key, "templateId": prefs["summaryTemplateId"], "grantId": grant, "dueAt": deadline});
        if !on {
            params["code"] = json!("setting-off");
        }
        outputs::call(host, "summary-insert-capture", meeting, params)?;
        if on {
            enqueue(host, meeting, &format!("{key}:stop"), deadline)?;
        }
        existing = row(host, meeting)?;
    }
    if let Some(row) = existing.filter(|r| r["status"] == "waiting" && r["grant_id"] == json!(grant) && finalized && r["early_enqueued"] != json!(true)) {
        let key = row["request_key"].as_str().unwrap_or_default();
        let at = now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        enqueue(host, meeting, &format!("{key}:finalized"), &at)?;
        outputs::call(host, "summary-set", meeting, json!({"earlyEnqueued": true}))?;
    }
    Ok(())
}
