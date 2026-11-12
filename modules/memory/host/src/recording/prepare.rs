//! Prepares a reviewed change: validates it, reserves the receipt and saves a proposal.
//! Providers and publication come later, in `apply`.
use super::lineage::{discover, snapshot};
use super::receipt::{self, proposal_json};
use super::{conflict, receipt_id, unavailable, RecordingAuthority, Source, INPUT};
use anyhow::Result;
use moss_module_host::trust::digest;
use safety_core::db::DataContext;
use serde_json::{json, Value};

const SIDES: [&str; 2] = ["personal", "work"];

fn text_ok(text: &str) -> Result<()> {
    if text.trim().is_empty() || text.contains('\0') || text.len() > 2048 {
        return Err(super::refuse(400, INPUT));
    }
    Ok(())
}

pub(crate) async fn run(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    input: &Value,
) -> Result<Value> {
    let kind = input["kind"].as_str().unwrap_or("");
    let request_id = input["requestId"].as_str().unwrap_or("");
    if request_id.is_empty() || request_id.contains('\0') || request_id.len() > 256 {
        return Err(unavailable());
    }
    let has_text = matches!(kind, "apply" | "change");
    let text = input["text"].as_str();
    if has_text {
        text_ok(text.unwrap_or(""))?;
    }
    let expected_revision = input["expectedRevision"].as_i64().unwrap_or(0);
    let expected_fact = input["expectedFactRevision"].as_str();
    if kind != "apply" {
        let id = input["receiptId"].as_str().unwrap_or("");
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(unavailable());
        }
        if !(1..=2147483645).contains(&expected_revision) {
            return Err(conflict());
        }
        let ok = expected_fact.map_or(true, |s| {
            s == "0"
                || (s.len() <= 19 && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit()))
        });
        if !ok || (expected_fact.is_none() && !input["expectedFactRevision"].is_null()) {
            return Err(conflict());
        }
    }
    let digest = digest(input.to_string().as_bytes());
    let original = if kind == "apply" {
        None
    } else {
        Some(receipt::get(cx, owner, input["receiptId"].as_str().unwrap_or(""), false).await?)
    };
    let source = match &original {
        None => Source::parse(&input["source"])?,
        Some(r) => r.source(),
    };
    let rid = receipt_id(owner, &source);
    let current = authority
        .current(owner, &source.id)
        .ok_or_else(super::changed)?;
    if let Some(prior) = receipt::by_request(cx, owner, request_id).await? {
        if prior.input_digest != digest
            || prior.receipt_id != rid
            || prior.kind != kind
            || prior.proposed_text.as_deref() != text.filter(|_| has_text)
        {
            return Err(conflict());
        }
        return Ok(json!({"proposal": proposal_json(&prior, &source)}));
    }
    if kind != "undo" && current.version != source.version {
        return Err(conflict());
    }
    if !SIDES.contains(&current.side.as_str()) {
        return Err(conflict());
    }
    let receipt = if kind == "apply" {
        reserve(cx, owner, &rid, &source, current.generation, &current.side).await?
    } else {
        receipt::get(cx, owner, &rid, false).await?
    };
    if kind != "apply"
        && (i64::from(receipt.revision) != expected_revision
            || receipt.fact_revision.as_deref() != expected_fact)
    {
        return Err(conflict());
    }
    let bad = receipt.state == "forgotten"
        || receipt.retired()
        || (kind == "restore" && receipt.state != "undone")
        || (kind == "change" && receipt.state != "applied")
        || (kind == "reconcile_side" && receipt.state == "pending")
        || (!matches!(kind, "reconcile_side" | "undo") && receipt.side != current.side);
    if bad {
        return Err(conflict());
    }
    let ids: Vec<String> = receipt.fact_id.iter().cloned().collect();
    let set = discover(cx, owner, &ids).await?;
    let snap = snapshot(authority, owner, &[source.id.clone()], &set)?;
    let side = if kind == "undo" {
        receipt.side.clone()
    } else {
        current.side.clone()
    };
    let before = receipt.json();
    let saved = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_recording_proposals(owner_user_id, proposal_id, request_id, input_digest,
               receipt_id, kind, expected_receipt_revision, expected_fact_id, expected_fact_revision,
               actor_generation, source_generation, side, proposed_text, publication_snapshot, before)
             VALUES ($1::text::uuid, gen_random_uuid(), $2, $3, $4, $5, $6, $7::text::uuid, $8::text::bigint,
               $9, $10, $11, $12, $13, $14)
             RETURNING proposal_id::text",
            &[&owner, &request_id, &digest, &rid, &kind, &receipt.revision, &receipt.fact_id,
              &receipt.fact_revision, &current.actor_generation, &current.generation, &side,
              &text.filter(|_| has_text), &snap, &before],
        )
        .await?;
    let id: String = saved.get(0);
    let row = receipt::proposal(cx, owner, &id).await?;
    Ok(json!({"proposal": proposal_json(&row, &source)}))
}

async fn reserve(
    cx: &DataContext,
    owner: &str,
    id: &str,
    source: &Source,
    generation: i32,
    side: &str,
) -> Result<receipt::Receipt> {
    if let Some(existing) = receipt::find(cx, owner, id, false).await? {
        return Ok(existing);
    }
    let count: i32 = cx
        .db()
        .query_one(
            "SELECT count(*)::int FROM app.memory_recording_receipts
             WHERE owner_user_id = $1::text::uuid AND source_module_id = 'meetings'
               AND source_id = $2::text::uuid AND source_version = $3",
            &[&owner, &source.id, &source.version],
        )
        .await?
        .get(0);
    if count >= 20 {
        return Err(unavailable());
    }
    cx.db()
        .execute(
            "INSERT INTO app.memory_recording_receipts(owner_user_id, receipt_id, source_module_id, source_id,
               source_version, item_key, source_generation, side, state, episode_id)
             VALUES ($1::text::uuid, $2, 'meetings', $3::text::uuid, $4, $5, $6, $7, 'pending', gen_random_uuid())",
            &[&owner, &id, &source.id, &source.version, &source.item_key, &generation, &side],
        )
        .await?;
    receipt::get(cx, owner, id, false).await
}
