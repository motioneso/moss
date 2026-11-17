//! SQL for the understanding resources. Every statement runs in the caller's
//! transaction, so row-level security decides what is visible and writable.
//! The triage and suppression tables belong to Connectors' migrations and exist only
//! when Connectors is installed.
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use uuid::Uuid;

/// Failed attempts after which a message is left alone.
pub const MAX_ANALYSIS_ATTEMPTS: i32 = 5;

/// Lower-cased address of a `Name <address>` or bare address column expression.
fn addr(x: &str) -> String {
    format!("lower(coalesce((regexp_match({x}, '<([^>]+)>'))[1], btrim({x})))")
}

/// The signed-in person's timezone from the `locale` preference, else UTC.
const ZONE: &str = "COALESCE((SELECT NULLIF(value_json #>> '{}', '') FROM app.preferences
    WHERE owner_user_id = app.current_actor_user_id() AND key = 'locale'), 'UTC')";

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "email.understand") => {
            // A context-only read returns the date and own addresses with no messages.
            let limit = if p["contextOnly"] == true { 0 } else { p["limit"].as_i64().unwrap_or(10).clamp(1, 50) };
            pending(cx, limit).await
        }
        ("set", "email.understand") => write(cx, p).await,
        ("get", "email.suppression") => suppression(cx, p).await,
        ("set", "email.suppression") => suppression_set(cx, p).await,
        ("get", "email.triage-feedback") => feedback_counts(cx).await,
        ("set", "email.triage-feedback") => feedback_record(cx, p).await,
        _ => bail!("Unknown email resource"),
    }
}

async fn require(cx: &DataContext, table: &str) -> Result<()> {
    let found: Option<String> = cx
        .db()
        .query_one("SELECT to_regclass($1)::text", &[&table])
        .await?
        .get(0);
    if found.is_none() {
        bail!("Install Connectors to use email triage feedback and suppression");
    }
    Ok(())
}

/// Unanalysed messages, the person's own addresses and today's date in their timezone.
async fn pending(cx: &DataContext, limit: i64) -> Result<Value> {
    let recipient = addr("r");
    let sender_m = addr("m.sender");
    let sender_o = addr("o.sender");
    let sql = format!(
        "WITH me AS (SELECT app.current_actor_user_id() AS id),
         recent AS (
           SELECT id, recipients FROM app.email_messages
           WHERE owner_user_id = (SELECT id FROM me)
           ORDER BY received_at DESC, id LIMIT 500),
         counts AS (
           SELECT {recipient} AS a, count(DISTINCT x.id) AS n
           FROM recent x, unnest(x.recipients) AS r GROUP BY 1),
         own AS (
           SELECT COALESCE(array_agg(a ORDER BY a), '{{}}') AS list FROM counts
           WHERE n >= GREATEST((SELECT count(*) FROM recent) * 0.2,
                               (SELECT COALESCE(max(n), 0) FROM counts) * 0.8)),
         picked AS (
           SELECT m.* FROM app.email_messages m
           WHERE m.owner_user_id = (SELECT id FROM me)
             AND NOT (m.signals ? 'actionability') AND NOT (m.signals ? 'skipped')
             AND COALESCE(m.signals->>'pendingJudgement', '') <> 'true'
             AND m.analysis_attempts < {max}
           ORDER BY m.received_at DESC, m.id LIMIT $1)
         SELECT jsonb_build_object(
           'today', to_char(now() AT TIME ZONE ({zone}), 'YYYY-MM-DD'),
           'ownAddresses', to_jsonb((SELECT list FROM own)),
           'messages', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id', m.id::text, 'sender', m.sender, 'subject', m.subject,
             'snippet', m.snippet, 'bodyExcerpt', m.body_excerpt,
             'receivedDay', to_char(m.received_at AT TIME ZONE ({zone}), 'YYYY-MM-DD'),
             'hasListUnsubscribe', m.external_metadata->'hasListUnsubscribe',
             'attempts', m.analysis_attempts,
             'knownSender', EXISTS (
               SELECT 1 FROM app.email_messages o
               WHERE o.owner_user_id = (SELECT id FROM me)
                 AND {sender_o} = ANY(ARRAY(SELECT unnest(list) FROM own))
                 AND {sender_m} IN (SELECT {recipient} FROM unnest(o.recipients) AS r)),
             'threadLastSender', COALESCE((
               SELECT t.sender FROM app.email_messages t
               WHERE t.owner_user_id = (SELECT id FROM me)
                 AND (t.id = m.id
                   OR btrim(t.external_metadata->>'messageId', '<> ') = ANY(ARRAY(
                        SELECT btrim(v, '<> ') FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(m.external_metadata->'references') = 'array'
                               THEN m.external_metadata->'references' ELSE '[]'::jsonb END) v))
                   OR btrim(m.external_metadata->>'messageId', '<> ') = ANY(ARRAY(
                        SELECT btrim(v, '<> ') FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(t.external_metadata->'references') = 'array'
                               THEN t.external_metadata->'references' ELSE '[]'::jsonb END) v)))
               ORDER BY t.received_at DESC, t.id LIMIT 1), m.sender))
             ORDER BY m.received_at DESC, m.id) FROM picked m), '[]'::jsonb))",
        max = MAX_ANALYSIS_ATTEMPTS,
        zone = ZONE,
    );
    Ok(cx.db().query_one(&sql, &[&limit]).await?.get(0))
}

/// Stores a result, counts a failure, or marks a message as sent by the person.
async fn write(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = Uuid::parse_str(p["id"].as_str().unwrap_or("")).map_err(|_| anyhow::anyhow!("Invalid message id"))?;
    let changed = match p["action"].as_str() {
        Some("result") => {
            let summary = p["summary"].as_str().map(|s| s.chars().take(600).collect::<String>());
            let signals = if p["signals"].is_object() { p["signals"].clone() } else { json!({}) };
            cx.db()
                .execute(
                    "UPDATE app.email_messages SET summary = $2, signals = $3,
                       analysis_attempts = 0, updated_at = now()
                     WHERE id = $1 AND owner_user_id = app.current_actor_user_id()",
                    &[&id, &summary, &signals],
                )
                .await?
        }
        Some("fail") => {
            cx.db()
                .execute(
                    "UPDATE app.email_messages SET analysis_attempts = analysis_attempts + 1
                     WHERE id = $1 AND owner_user_id = app.current_actor_user_id()",
                    &[&id],
                )
                .await?
        }
        _ => bail!("Unknown understanding action"),
    };
    Ok(json!({"changed": changed}))
}

async fn suppression(cx: &DataContext, p: &Value) -> Result<Value> {
    require(cx, "app.email_action_suppression").await?;
    let signatures: Vec<String> = p["signatures"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    // Row-level security alone limits these reads to the signed-in person.
    let sql = "SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'subjectSignature', s.subject_signature, 'dismissalCount', s.dismissal_count,
          'deadlineEvidenceKeys', to_jsonb(ARRAY(SELECT DISTINCT k FROM unnest(
             ARRAY[s.last_deadline_evidence_key] || ARRAY(SELECT e.evidence_key
               FROM app.email_action_suppression_evidence e
               WHERE e.subject_signature = s.subject_signature AND e.evidence_kind = 'deadline')) k
             WHERE k IS NOT NULL)),
          'contextMessageKeys', to_jsonb(ARRAY(SELECT DISTINCT k FROM unnest(
             ARRAY[s.last_context_message_key] || ARRAY(SELECT e.evidence_key
               FROM app.email_action_suppression_evidence e
               WHERE e.subject_signature = s.subject_signature AND e.evidence_kind = 'context')) k
             WHERE k IS NOT NULL)))), '[]'::jsonb)
        FROM app.email_action_suppression s
        WHERE s.subject_signature = ANY($1)";
    Ok(cx.db().query_one(sql, &[&signatures]).await?.get(0))
}

async fn suppression_set(cx: &DataContext, p: &Value) -> Result<Value> {
    require(cx, "app.email_action_suppression").await?;
    let sig = p["signature"].as_str().unwrap_or("");
    let key = p["key"].as_str().map(|k| k.chars().take(500).collect::<String>());
    let db = cx.db();
    match p["action"].as_str() {
        Some("dismiss") => {
            db.execute(
                "INSERT INTO app.email_action_suppression (owner_user_id, subject_signature, dismissal_count)
                 VALUES (app.current_actor_user_id(), $1, 1)
                 ON CONFLICT (owner_user_id, subject_signature) DO UPDATE SET
                   dismissal_count = app.email_action_suppression.dismissal_count + 1, updated_at = now()",
                &[&sig],
            )
            .await?;
        }
        Some("reset") => {
            let n = db
                .execute(
                    "UPDATE app.email_action_suppression SET dismissal_count = 0,
                       last_deadline_evidence_key = NULL, last_context_message_key = NULL, updated_at = now()
                     WHERE owner_user_id = app.current_actor_user_id() AND subject_signature = $1",
                    &[&sig],
                )
                .await?;
            if n > 0 {
                db.execute(
                    "DELETE FROM app.email_action_suppression_evidence
                     WHERE owner_user_id = app.current_actor_user_id() AND subject_signature = $1",
                    &[&sig],
                )
                .await?;
            }
        }
        Some(kind @ ("context" | "deadline")) => {
            let Some(key) = key else { bail!("Evidence key required") };
            db.execute(
                "INSERT INTO app.email_action_suppression_evidence
                   (owner_user_id, subject_signature, evidence_kind, evidence_key)
                 VALUES (app.current_actor_user_id(), $1, $2, $3) ON CONFLICT DO NOTHING",
                &[&sig, &kind, &key],
            )
            .await?;
            let column = if kind == "context" { "last_context_message_key" } else { "last_deadline_evidence_key" };
            db.execute(
                &format!(
                    "UPDATE app.email_action_suppression SET {column} = $2, updated_at = now()
                     WHERE owner_user_id = app.current_actor_user_id() AND subject_signature = $1"
                ),
                &[&sig, &key],
            )
            .await?;
        }
        _ => bail!("Unknown suppression action"),
    }
    Ok(json!({}))
}

async fn feedback_record(cx: &DataContext, p: &Value) -> Result<Value> {
    require(cx, "app.email_triage_feedback").await?;
    let verdict = match p["verdict"].as_str() {
        Some(v @ ("accepted" | "rejected")) => v,
        _ => bail!("Invalid verdict"),
    };
    let text = |name: &str| p[name].as_str().map(String::from);
    let (Some(actionability), Some(sender)) = (text("actionability"), text("sender")) else {
        bail!("Actionability and sender required");
    };
    let domain = sender.rsplit('@').next().unwrap_or("").trim_end_matches('>').to_lowercase();
    let prefix = text("subject").map(|s| s.chars().take(120).collect::<String>());
    let account = p["connectorAccountId"].as_str().and_then(|s| Uuid::parse_str(s).ok());
    let confidence = p["confidence"].as_f64().map(|c| c as f32);
    cx.db()
        .execute(
            "INSERT INTO app.email_triage_feedback
               (owner_user_id, connector_account_id, source, actionability, sender, sender_domain,
                subject_prefix, action_type, confidence, model_version, verdict, reason)
             VALUES (app.current_actor_user_id(), $1, 'email', $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            &[&account, &actionability, &sender, &domain, &prefix, &text("actionType"), &confidence,
              &text("modelVersion"), &verdict, &text("reason")],
        )
        .await?;
    Ok(json!({}))
}

/// Accepted and rejected counts per sender domain for the signed-in person.
async fn feedback_counts(cx: &DataContext) -> Result<Value> {
    require(cx, "app.email_triage_feedback").await?;
    Ok(cx
        .db()
        .query_one(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object('domain', sender_domain,
               'accepted', accepted, 'rejected', rejected) ORDER BY sender_domain), '[]'::jsonb)
             FROM (SELECT sender_domain,
                     count(*) FILTER (WHERE verdict = 'accepted') AS accepted,
                     count(*) FILTER (WHERE verdict = 'rejected') AS rejected
                   FROM app.email_triage_feedback
                   GROUP BY sender_domain) t",
            &[],
        )
        .await?
        .get(0))
}
