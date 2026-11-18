//! Publishes a prepared proposal. The embedding is computed between `load` and `publish`, so
//! no transaction or lock is held while the embedding service runs.
use super::lineage::{admit, synchronize};
use super::receipt::{self, Proposal, Receipt};
use super::{changed, conflict, must, RecordingAuthority};
use crate::store::ensure_self;
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// Reads the proposal and the text to embed. A proposal that already applied returns its
/// result straight away.
pub(crate) async fn load(cx: &DataContext, owner: &str, proposal_id: &str) -> Result<Value> {
    let proposal = receipt::proposal(cx, owner, proposal_id).await?;
    let receipt = receipt::get(cx, owner, &proposal.receipt_id, false).await?;
    if proposal.state == "applied" {
        let json = receipt.json();
        let status = if json["state"] == "forgotten" {
            "forgotten"
        } else {
            "unchanged"
        };
        return Ok(json!({"done": {"status": status, "receipt": json}}));
    }
    let text = if proposal.kind == "undo" {
        None
    } else {
        proposal.proposed_text.clone().or(receipt.fact_text.clone())
    };
    Ok(json!({"embed": text}))
}

fn check_revision(r: &Receipt, p: &Proposal) -> Result<()> {
    if r.revision != p.expected_revision
        || r.fact_id != p.expected_fact_id
        || r.fact_revision != p.expected_fact_revision
        || r.state == "forgotten"
        || r.retired()
    {
        return Err(conflict());
    }
    Ok(())
}

pub(crate) async fn publish(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    p: &Value,
) -> Result<Value> {
    let proposal_id = must(p, "proposalId")?;
    let prepared = receipt::proposal(cx, owner, proposal_id).await?;
    let first = receipt::get(cx, owner, &prepared.receipt_id, false).await?;
    let ids: Vec<String> = first.fact_id.iter().cloned().collect();
    let reconciling = matches!(prepared.kind.as_str(), "reconcile_side" | "undo")
        .then(|| first.source_id.clone());
    admit(
        cx,
        authority,
        owner,
        &prepared.snapshot,
        &ids,
        reconciling.as_deref(),
    )
    .await?;
    let proposal = receipt::proposal(cx, owner, proposal_id).await?;
    let receipt = receipt::get(cx, owner, &proposal.receipt_id, true).await?;
    if proposal.state == "applied" {
        return Ok(json!({"status": "unchanged", "receipt": receipt.json()}));
    }
    check_revision(&receipt, &proposal)?;
    let current = authority
        .current(owner, &receipt.source_id)
        .ok_or_else(changed)?;
    if proposal.kind != "undo"
        && (current.version != receipt.source_version || current.side != proposal.side)
    {
        return Err(conflict());
    }
    let embedding = Embedding::from(&p["embedding"]);
    let status = transition(cx, owner, &receipt, &proposal, &embedding).await?;
    // Admission is asked again after the row locks are held, so a source fenced in between
    // rolls the publication back.
    let after_lock = authority
        .current(owner, &receipt.source_id)
        .ok_or_else(changed)?;
    if proposal.kind != "undo"
        && (after_lock.version != receipt.source_version || after_lock.side != proposal.side)
    {
        return Err(conflict());
    }
    cx.db()
        .execute(
            "UPDATE app.memory_recording_proposals SET state = 'applied'
             WHERE owner_user_id = $1::text::uuid AND proposal_id = $2::text::uuid",
            &[&owner, &proposal.id],
        )
        .await?;
    let after = receipt::get(cx, owner, &receipt.id, false).await?;
    Ok(json!({"status": status, "receipt": after.json()}))
}

/// A vector literal and the model that made it, or nothing when embedding was not possible.
struct Embedding(Option<(String, String, String)>);
impl Embedding {
    fn from(v: &Value) -> Self {
        Self(
            match (
                v["vector"].as_str(),
                v["model"][0].as_str(),
                v["model"][1].as_str(),
            ) {
                (Some(vector), Some(name), Some(version)) => {
                    Some((vector.to_owned(), name.to_owned(), version.to_owned()))
                }
                _ => None,
            },
        )
    }
    async fn write(&self, cx: &DataContext, owner: &str, fact_id: &str, text: &str) -> Result<()> {
        let Some((vector, name, version)) = &self.0 else {
            return Ok(());
        };
        cx.db()
            .execute(
                "UPDATE app.memory_search_documents SET search_text = $3, embedding = $4::text::vector,
                   embed_model_name = $5, embed_model_version = $6
                 WHERE owner_user_id = $1::text::uuid AND target_kind = 'fact'
                   AND target_id = $2::text::uuid AND status = 'active'",
                &[&owner, &fact_id, &text, vector, name, version],
            )
            .await?;
        Ok(())
    }
}

async fn update_receipt(
    cx: &DataContext,
    owner: &str,
    r: &Receipt,
    state: &str,
    p: &Proposal,
    fact_id: &str,
) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_recording_receipts SET state = $3, side = $4, source_generation = $5,
               fact_id = $6::text::uuid, revision = revision + 1
             WHERE owner_user_id = $1::text::uuid AND receipt_id = $2",
            &[&owner, &r.id, &state, &p.side, &p.source_generation, &fact_id],
        )
        .await?;
    Ok(())
}

async fn reject_unsupported(cx: &DataContext, owner: &str, fact_id: &str) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_facts fact SET updated_at = now(),
               status = CASE WHEN EXISTS (SELECT 1 FROM app.memory_recording_receipts receipt
                 WHERE receipt.owner_user_id = fact.owner_user_id AND receipt.fact_id = fact.id
                   AND receipt.state = 'applied') THEN fact.status ELSE 'rejected' END
             WHERE fact.owner_user_id = $1::text::uuid AND fact.id = $2::text::uuid",
            &[&owner, &fact_id],
        )
        .await?;
    Ok(())
}

async fn count_other(
    cx: &DataContext,
    owner: &str,
    fact_id: &str,
    except: Option<&str>,
) -> Result<i32> {
    Ok(cx
        .db()
        .query_one(
            "SELECT count(*)::int FROM app.memory_recording_receipts WHERE owner_user_id = $1::text::uuid
               AND fact_id = $2::text::uuid AND ($3::text IS NULL OR receipt_id <> $3)
               AND state IN ('applied','undone')",
            &[&owner, &fact_id, &except],
        )
        .await?
        .get(0))
}

async fn transition(
    cx: &DataContext,
    owner: &str,
    r: &Receipt,
    p: &Proposal,
    embedding: &Embedding,
) -> Result<&'static str> {
    if p.kind == "apply" && r.state != "pending" {
        return Ok("unchanged");
    }
    let fact = r.fact_id.clone();
    if p.kind == "undo" {
        if r.state == "undone" {
            return Ok("unchanged");
        }
        let (true, Some(fact)) = (r.state == "applied", &fact) else {
            return Err(conflict());
        };
        update_receipt(cx, owner, r, "undone", p, fact).await?;
        reject_unsupported(cx, owner, fact).await?;
        synchronize(cx, owner, &[fact.clone()]).await?;
        return Ok("undone");
    }
    if p.kind == "restore" {
        let (true, Some(fact)) = (r.state == "undone", &fact) else {
            return Err(conflict());
        };
        update_receipt(cx, owner, r, "applied", p, fact).await?;
        let n = cx
            .db()
            .execute(
                "UPDATE app.memory_facts SET status = 'active', updated_at = now()
                 WHERE owner_user_id = $1::text::uuid AND id = $2::text::uuid
                   AND conflict_group_id IS NULL AND status IN ('active','stale','rejected')",
                &[&owner, fact],
            )
            .await?;
        if n != 1 {
            return Err(conflict());
        }
        synchronize(cx, owner, &[fact.clone()]).await?;
        embedding
            .write(cx, owner, fact, r.fact_text.as_deref().unwrap_or(""))
            .await?;
        return Ok("applied");
    }
    if let (true, Some(fact)) = (p.kind == "reconcile_side", &fact) {
        if count_other(cx, owner, fact, Some(&r.id)).await? == 0 {
            cx.db()
                .execute(
                    "UPDATE app.memory_recording_fact_versions SET side = $3
                     WHERE owner_user_id = $1::text::uuid AND fact_id = $2::text::uuid AND state = 'current'",
                    &[&owner, fact, &p.side],
                )
                .await?;
            cx.db()
                .execute(
                    "UPDATE app.memory_facts SET recording_side = $3, updated_at = now()
                     WHERE owner_user_id = $1::text::uuid AND id = $2::text::uuid",
                    &[&owner, fact, &p.side],
                )
                .await?;
            update_receipt(cx, owner, r, &r.state, p, fact).await?;
            synchronize(cx, owner, &[fact.clone()]).await?;
            embedding
                .write(cx, owner, fact, r.fact_text.as_deref().unwrap_or(""))
                .await?;
            return Ok("applied");
        }
    }
    let text = p
        .proposed_text
        .clone()
        .or(r.fact_text.clone())
        .ok_or_else(conflict)?;
    let created = create_fact(cx, owner, r, p, &text).await?;
    update_receipt(
        cx,
        owner,
        r,
        if r.state == "undone" {
            "undone"
        } else {
            "applied"
        },
        p,
        &created,
    )
    .await?;
    if let Some(old) = &fact {
        cx.db()
            .execute(
                "DELETE FROM app.memory_fact_sources WHERE owner_user_id = $1::text::uuid
                   AND fact_id = $2::text::uuid AND episode_id = $3::text::uuid",
                &[&owner, old, &r.episode_id],
            )
            .await?;
        if count_other(cx, owner, old, None).await? == 0 {
            cx.db()
                .execute(
                    "UPDATE app.memory_facts SET status = 'superseded', superseded_by_fact_id = $3::text::uuid,
                       valid_to = now(), updated_at = now()
                     WHERE owner_user_id = $1::text::uuid AND id = $2::text::uuid",
                    &[&owner, old, &created],
                )
                .await?;
        } else {
            reject_unsupported(cx, owner, old).await?;
        }
    }
    let mut touched = vec![created.clone()];
    touched.extend(fact);
    synchronize(cx, owner, &touched).await?;
    embedding.write(cx, owner, &created, &text).await?;
    Ok("applied")
}

async fn create_fact(
    cx: &DataContext,
    owner: &str,
    r: &Receipt,
    p: &Proposal,
    text: &str,
) -> Result<String> {
    let id: String = cx
        .db()
        .query_one("SELECT gen_random_uuid()::text", &[])
        .await?
        .get(0);
    let own = ensure_self(cx).await?;
    let (lineage, corrected) = match &r.fact_id {
        Some(old) => {
            let row = cx
                .db()
                .query_one(
                    "SELECT lineage_id::text, corrected FROM app.memory_recording_fact_versions
                     WHERE owner_user_id = $1::text::uuid AND fact_id = $2::text::uuid",
                    &[&owner, old],
                )
                .await?;
            (row.get::<_, String>(0), row.get::<_, bool>(1))
        }
        None => (id.clone(), false),
    };
    let corrected = corrected || p.kind == "change";
    cx.db()
        .execute(
            "INSERT INTO app.memory_recording_fact_versions(owner_user_id, fact_id, lineage_id, side, corrected)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5)",
            &[&owner, &id, &lineage, &p.side, &corrected],
        )
        .await?;
    let source_ref = format!(
        "recording:{}:{}:{}",
        r.source_id, r.source_version, r.item_key
    );
    let undone = r.state == "undone";
    cx.db()
        .execute(
            "INSERT INTO app.memory_episodes(id, owner_user_id, source_kind, source_ref, source_label, excerpt,
               recording_side, recording_active)
             VALUES ($3::text::uuid, $1::text::uuid, 'note', $2, 'Recording', $4, $5, $6)
             ON CONFLICT(owner_user_id, id) DO NOTHING",
            &[&owner, &source_ref, &r.episode_id, &text, &p.side, &!undone],
        )
        .await?;
    let (status, provenance) = (
        if undone { "rejected" } else { "active" },
        if p.kind == "change" {
            "confirmed"
        } else {
            "inferred"
        },
    );
    cx.db()
        .execute(
            "INSERT INTO app.memory_facts(id, owner_user_id, subject_entity_id, predicate, object_text,
               recording_side, status, confidence, provenance)
             VALUES ($2::text::uuid, $1::text::uuid, $3::text::uuid, 'related_to', $4, $5, $6, 0.8, $7)",
            &[&owner, &id, &own, &text, &p.side, &status, &provenance],
        )
        .await?;
    cx.db()
        .execute(
            "INSERT INTO app.memory_fact_sources(owner_user_id, fact_id, episode_id)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid)",
            &[&owner, &id, &r.episode_id],
        )
        .await?;
    cx.db()
        .execute(
            "INSERT INTO app.memory_search_documents(owner_user_id, target_kind, target_id, search_text, status,
               recording_side, recording_revision)
             SELECT $1::text::uuid, kind, target, $4, 'inactive', $5, version.revision
             FROM app.memory_recording_fact_versions version,
               (VALUES ('fact', $2::text::uuid), ('episode', $3::text::uuid)) AS targets(kind, target)
             WHERE version.owner_user_id = $1::text::uuid AND version.fact_id = $2::text::uuid
             ON CONFLICT(owner_user_id, target_kind, target_id) DO UPDATE
               SET search_text = excluded.search_text, status = 'inactive',
                 recording_side = excluded.recording_side, recording_revision = excluded.recording_revision,
                 embedding = NULL, embed_model_name = NULL, embed_model_version = NULL",
            &[&owner, &id, &r.episode_id, &text, &p.side],
        )
        .await?;
    Ok(id)
}
