//! Removal and export. Cleanup never calls a provider and never regenerates corrected or
//! retired facts. It runs in batches of twenty receipts and reports whether work remains.
use super::{changed, is_uuid, must, refuse, RecordingAuthority, INCOMPLETE};
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// Receipts of the operation's scope that cleanup has not yet processed.
struct Scope {
    operation: String,
    source: Option<String>,
}
impl Scope {
    fn parse(p: &Value) -> Result<Self> {
        let operation = must(p, "operationId")?.to_lowercase();
        let source = p["source"]["sourceId"].as_str().map(str::to_lowercase);
        if !is_uuid(&operation)
            || source.as_deref().is_some_and(|s| !is_uuid(s))
            || (!p["source"].is_null() && p["source"]["sourceModuleId"] != "meetings")
        {
            return Err(changed());
        }
        Ok(Self { operation, source })
    }
    /// `$1` owner, `$2` source (null for the whole account), `$3` operation.
    const WHERE: &'static str = "owner_user_id = $1::text::uuid
        AND ($2::text IS NULL OR (source_module_id = 'meetings' AND source_id = $2::text::uuid))";
}

async fn remaining(cx: &DataContext, owner: &str, s: &Scope) -> Result<bool> {
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM app.memory_recording_receipts WHERE {}
           AND cleanup_operation_id IS DISTINCT FROM $3::text::uuid)",
        Scope::WHERE
    );
    Ok(cx
        .db()
        .query_one(&sql, &[&owner, &s.source, &s.operation])
        .await?
        .get(0))
}

pub(crate) async fn cleanup(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    p: &Value,
) -> Result<Value> {
    let s = Scope::parse(p)?;
    if !authority.cleaning(owner, &s.operation) {
        return Err(changed());
    }
    let db = cx.db();
    let sql = format!(
        "SELECT receipt_id, episode_id::text, fact_id::text FROM app.memory_recording_receipts
         WHERE {} AND cleanup_operation_id IS DISTINCT FROM $3::text::uuid ORDER BY receipt_id LIMIT 20",
        Scope::WHERE
    );
    let receipts = db.query(&sql, &[&owner, &s.source, &s.operation]).await?;
    if receipts.is_empty() {
        return Ok(json!({"status": "complete"}));
    }
    let receipt_ids: Vec<String> = receipts.iter().map(|r| r.get(0)).collect();
    let episodes: Vec<String> = receipts.iter().map(|r| r.get(1)).collect();
    let affected = db
        .query(
            "SELECT fact_id::text FROM app.memory_recording_receipts
               WHERE owner_user_id = $1::text::uuid AND receipt_id = ANY($2::text[]) AND fact_id IS NOT NULL
             UNION SELECT fact_id::text FROM app.memory_fact_sources
               WHERE owner_user_id = $1::text::uuid AND episode_id = ANY($3::text[]::uuid[])",
            &[&owner, &receipt_ids, &episodes],
        )
        .await?;
    let mut facts: Vec<String> = affected.iter().map(|r| r.get(0)).collect();
    facts.sort();
    // Graph parents are locked before facts and receipts, as in ordinary managed changes.
    let locks = [
        "SELECT id FROM app.memory_entities WHERE owner_user_id = $1::text::uuid AND id IN (
           SELECT subject_entity_id FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[])
           UNION SELECT object_entity_id FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]))
         ORDER BY id FOR SHARE NOWAIT",
        "SELECT id FROM app.memory_conflict_groups WHERE owner_user_id = $1::text::uuid AND id IN (
           SELECT conflict_group_id FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]))
         ORDER BY id FOR UPDATE NOWAIT",
        "SELECT id FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
        "SELECT fact_id FROM app.memory_recording_fact_versions WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]) ORDER BY fact_id FOR UPDATE NOWAIT",
    ];
    for lock in locks {
        db.query(lock, &[&owner, &facts]).await?;
    }
    db.query(
        "SELECT receipt_id FROM app.memory_recording_receipts WHERE owner_user_id = $1::text::uuid
           AND receipt_id = ANY($2::text[]) ORDER BY receipt_id FOR UPDATE NOWAIT",
        &[&owner, &receipt_ids],
    )
    .await?;
    db.query(
        "SELECT id FROM app.memory_search_documents WHERE owner_user_id = $1::text::uuid
           AND ((target_kind = 'episode' AND target_id = ANY($2::text[]::uuid[]))
             OR (target_kind = 'fact' AND target_id = ANY($3::text[]::uuid[]))) ORDER BY id FOR UPDATE NOWAIT",
        &[&owner, &episodes, &facts],
    )
    .await?;
    db.execute(
        "UPDATE app.memory_recording_receipts SET state = 'forgotten', revision = revision + 1,
           cleanup_operation_id = $3::text::uuid
         WHERE owner_user_id = $1::text::uuid AND receipt_id = ANY($2::text[])",
        &[&owner, &receipt_ids, &s.operation],
    )
    .await?;
    for sql in [
        "DELETE FROM app.memory_search_documents WHERE owner_user_id = $1::text::uuid
           AND target_kind = 'episode' AND target_id = ANY($2::text[]::uuid[])",
        "DELETE FROM app.memory_fact_sources WHERE owner_user_id = $1::text::uuid
           AND episode_id = ANY($2::text[]::uuid[])",
        "DELETE FROM app.memory_episodes WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[])",
    ] {
        db.execute(sql, &[&owner, &episodes]).await?;
    }
    // A retired fact has no live graph row but can keep inactive search text.
    db.execute(
        "DELETE FROM app.memory_search_documents document USING app.memory_recording_fact_versions version
         WHERE version.owner_user_id = $1::text::uuid AND version.fact_id = ANY($2::text[]::uuid[])
           AND version.state <> 'current' AND document.owner_user_id = version.owner_user_id
           AND document.target_kind = 'fact' AND document.target_id = version.fact_id",
        &[&owner, &facts],
    )
    .await?;
    // A fact another recording still supports keeps its text and side.
    let unsupported = db
        .query(
            "SELECT fact.id::text FROM app.memory_facts fact
             JOIN app.memory_recording_fact_versions version
               ON version.owner_user_id = fact.owner_user_id AND version.fact_id = fact.id
             WHERE fact.owner_user_id = $1::text::uuid AND fact.id = ANY($2::text[]::uuid[])
               AND NOT EXISTS (SELECT 1 FROM app.memory_recording_receipts receipt
                 WHERE receipt.owner_user_id = fact.owner_user_id AND receipt.fact_id = fact.id
                   AND receipt.state IN ('applied','undone'))
               AND NOT EXISTS (SELECT 1 FROM app.memory_fact_sources source
                 WHERE source.owner_user_id = fact.owner_user_id AND source.fact_id = fact.id)",
            &[&owner, &facts],
        )
        .await?;
    let retired: Vec<String> = unsupported.iter().map(|r| r.get(0)).collect();
    if !retired.is_empty() {
        db.execute(
            "DELETE FROM app.memory_search_documents WHERE owner_user_id = $1::text::uuid
               AND target_kind = 'fact' AND target_id = ANY($2::text[]::uuid[])",
            &[&owner, &retired],
        )
        .await?;
        // The memory trigger keeps durable forgotten and superseded history.
        db.execute(
            "DELETE FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[])",
            &[&owner, &retired],
        )
        .await?;
    }
    db.execute(
        "UPDATE app.memory_facts fact SET status = 'rejected', updated_at = now()
         WHERE fact.owner_user_id = $1::text::uuid AND fact.id = ANY($2::text[]::uuid[])
           AND fact.status IN ('active','conflicting','stale')
           AND NOT EXISTS (SELECT 1 FROM app.memory_recording_receipts receipt
             WHERE receipt.owner_user_id = fact.owner_user_id AND receipt.fact_id = fact.id AND receipt.state = 'applied')",
        &[&owner, &facts],
    )
    .await?;
    db.execute(
        "UPDATE app.memory_search_documents document SET
           status = CASE WHEN app.memory_recording_fact_eligible(version.owner_user_id, version.fact_id, version.side)
             THEN 'active' ELSE 'inactive' END, recording_revision = version.revision, updated_at = now()
         FROM app.memory_recording_fact_versions version
         WHERE version.owner_user_id = $1::text::uuid AND version.fact_id = ANY($2::text[]::uuid[])
           AND document.owner_user_id = version.owner_user_id AND document.target_kind = 'fact'
           AND document.target_id = version.fact_id",
        &[&owner, &facts],
    )
    .await?;
    let status = if remaining(cx, owner, &s).await? {
        "pending"
    } else {
        "complete"
    };
    Ok(json!({"status": status}))
}

pub(crate) async fn assert_complete(cx: &DataContext, owner: &str, p: &Value) -> Result<Value> {
    if remaining(cx, owner, &Scope::parse(p)?).await? {
        return Err(refuse(409, INCOMPLETE));
    }
    Ok(json!({"ok": true}))
}

/// Drops the source's receipts once Meetings has sealed it and cleanup has finished.
pub(crate) async fn retire_source(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    p: &Value,
) -> Result<Value> {
    let s = Scope::parse(p)?;
    let Some(source) = &s.source else {
        return Err(refuse(400, "Source cleanup requires a source"));
    };
    if !authority.sealed(owner, &s.operation) {
        return Err(changed());
    }
    assert_complete(cx, owner, p).await?;
    cx.db()
        .execute(
            "DELETE FROM app.memory_recording_receipts WHERE owner_user_id = $1::text::uuid
               AND source_module_id = 'meetings' AND source_id = $2::text::uuid",
            &[&owner, source],
        )
        .await?;
    Ok(json!({"ok": true}))
}

/// The three tables as the old export section, scoped to the signed-in person.
pub(crate) async fn export(cx: &DataContext) -> Result<Value> {
    let q = |sql: &'static str| async move {
        Ok::<Value, anyhow::Error>(cx.db().query_one(sql, &[]).await?.get(0))
    };
    let versions = q("SELECT COALESCE(jsonb_agg(jsonb_build_object('ownerUserId', owner_user_id::text,
          'factId', fact_id::text, 'lineageId', lineage_id::text, 'revision', revision::text, 'side', side,
          'state', state, 'corrected', corrected, 'replacementFactId', replacement_fact_id::text)
          ORDER BY fact_id), '[]'::jsonb)
        FROM app.memory_recording_fact_versions WHERE owner_user_id = app.current_actor_user_id()")
    .await?;
    let receipts = q("SELECT COALESCE(jsonb_agg(jsonb_build_object('ownerUserId', owner_user_id::text,
          'receiptId', receipt_id, 'sourceModuleId', source_module_id, 'sourceId', source_id::text,
          'sourceVersion', source_version, 'itemKey', item_key, 'sourceGeneration', source_generation,
          'revision', revision, 'side', side, 'state', state, 'factId', fact_id::text,
          'episodeId', episode_id::text, 'cleanupOperationId', cleanup_operation_id::text)
          ORDER BY receipt_id), '[]'::jsonb)
        FROM app.memory_recording_receipts WHERE owner_user_id = app.current_actor_user_id()")
    .await?;
    let proposals = q("SELECT COALESCE(jsonb_agg(jsonb_build_object('ownerUserId', owner_user_id::text,
          'proposalId', proposal_id::text, 'requestId', request_id, 'receiptId', receipt_id, 'kind', kind,
          'expectedReceiptRevision', expected_receipt_revision, 'expectedFactId', expected_fact_id::text,
          'expectedFactRevision', expected_fact_revision::text, 'actorGeneration', actor_generation,
          'sourceGeneration', source_generation, 'side', side, 'proposedText', proposed_text, 'state', state,
          'publicationSnapshot', publication_snapshot, 'before', before,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))
          ORDER BY created_at, proposal_id), '[]'::jsonb)
        FROM app.memory_recording_proposals WHERE owner_user_id = app.current_actor_user_id()")
    .await?;
    Ok(json!({"factVersions": versions, "receipts": receipts, "proposals": proposals}))
}
