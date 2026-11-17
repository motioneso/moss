//! Receipt and proposal rows, and their response shapes.
use super::{receipt_id, unavailable, Source};
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use tokio_postgres::Row;

pub(crate) struct Receipt {
    pub id: String,
    pub source_id: String,
    pub source_version: i32,
    pub item_key: String,
    pub revision: i32,
    pub side: String,
    pub state: String,
    pub fact_id: Option<String>,
    pub episode_id: String,
    pub fact_text: Option<String>,
    pub fact_revision: Option<String>,
    pub fact_state: Option<String>,
    pub fact_status: Option<String>,
    pub corrected: Option<bool>,
}

impl Receipt {
    fn from(row: &Row) -> Self {
        Self {
            id: row.get(0),
            source_id: row.get(1),
            source_version: row.get(2),
            item_key: row.get(3),
            revision: row.get(4),
            side: row.get(5),
            state: row.get(6),
            fact_id: row.get(7),
            episode_id: row.get(8),
            fact_text: row.get(9),
            fact_revision: row.get(10),
            fact_state: row.get(11),
            fact_status: row.get(12),
            corrected: row.get(13),
        }
    }
    pub fn source(&self) -> Source {
        Source {
            id: self.source_id.clone(),
            version: self.source_version,
            item_key: self.item_key.clone(),
        }
    }
    pub fn retired(&self) -> bool {
        self.fact_id.is_some() && self.fact_state.as_deref() != Some("current")
    }
    pub fn json(&self) -> Value {
        let state = if self.retired() {
            "forgotten"
        } else {
            self.state.as_str()
        };
        let fact = match (&self.fact_id, &self.fact_revision, &self.fact_text) {
            (Some(id), Some(revision), Some(text)) => {
                let live = self.fact_state.as_deref() == Some("current")
                    && matches!(
                        self.fact_status.as_deref(),
                        Some("active" | "stale" | "conflicting")
                    )
                    && self.state == "applied";
                json!({"id": id, "text": text, "revision": revision,
                       "status": if live { "active" } else { "inactive" },
                       "corrected": self.corrected.unwrap_or(false)})
            }
            _ => Value::Null,
        };
        json!({"id": self.id, "source": self.source().json(), "revision": self.revision,
               "side": self.side, "state": state, "fact": fact})
    }
}

const SELECT: &str = "SELECT receipt.receipt_id, receipt.source_id::text, receipt.source_version,
    receipt.item_key, receipt.revision, receipt.side, receipt.state, receipt.fact_id::text,
    receipt.episode_id::text, fact.object_text, version.revision::text, version.state,
    fact.status, version.corrected
  FROM app.memory_recording_receipts receipt
  LEFT JOIN app.memory_recording_fact_versions version
    ON version.owner_user_id = receipt.owner_user_id AND version.fact_id = receipt.fact_id
  LEFT JOIN app.memory_facts fact
    ON fact.owner_user_id = receipt.owner_user_id AND fact.id = receipt.fact_id
  WHERE receipt.owner_user_id = $1::text::uuid AND receipt.receipt_id = $2";

pub(crate) async fn find(
    cx: &DataContext,
    owner: &str,
    id: &str,
    lock: bool,
) -> Result<Option<Receipt>> {
    let sql = if lock {
        format!("{SELECT} FOR UPDATE OF receipt NOWAIT")
    } else {
        SELECT.to_owned()
    };
    Ok(cx
        .db()
        .query_opt(&sql, &[&owner, &id])
        .await?
        .as_ref()
        .map(Receipt::from))
}

pub(crate) async fn get(cx: &DataContext, owner: &str, id: &str, lock: bool) -> Result<Receipt> {
    find(cx, owner, id, lock).await?.ok_or_else(unavailable)
}

pub(crate) async fn inspect(cx: &DataContext, owner: &str, source: &Value) -> Result<Value> {
    let id = receipt_id(owner, &Source::parse(source)?);
    Ok(json!({"receipt": find(cx, owner, &id, false).await?.map(|r| r.json())}))
}

/// The stored proposal, as the old code's row.
pub(crate) struct Proposal {
    pub id: String,
    pub input_digest: String,
    pub receipt_id: String,
    pub kind: String,
    pub expected_revision: i32,
    pub expected_fact_id: Option<String>,
    pub expected_fact_revision: Option<String>,
    pub source_generation: i32,
    pub side: String,
    pub proposed_text: Option<String>,
    pub state: String,
    pub snapshot: Value,
    pub before: Value,
}

const PROPOSAL: &str = "SELECT proposal_id::text, request_id, input_digest, receipt_id, kind,
    expected_receipt_revision, expected_fact_id::text, expected_fact_revision::text,
    source_generation, side, proposed_text, state, publication_snapshot, before
  FROM app.memory_recording_proposals WHERE owner_user_id = $1::text::uuid AND ";

fn proposal_from(row: &Row) -> Proposal {
    Proposal {
        id: row.get(0),
        input_digest: row.get(2),
        receipt_id: row.get(3),
        kind: row.get(4),
        expected_revision: row.get(5),
        expected_fact_id: row.get(6),
        expected_fact_revision: row.get(7),
        source_generation: row.get(8),
        side: row.get(9),
        proposed_text: row.get(10),
        state: row.get(11),
        snapshot: row.get(12),
        before: row.get(13),
    }
}

pub(crate) async fn proposal(cx: &DataContext, owner: &str, id: &str) -> Result<Proposal> {
    if !super::is_uuid(id) {
        return Err(unavailable());
    }
    let row = cx
        .db()
        .query_opt(
            &format!("{PROPOSAL}proposal_id = $2::text::uuid"),
            &[&owner, &id],
        )
        .await?;
    row.as_ref().map(proposal_from).ok_or_else(unavailable)
}

pub(crate) async fn by_request(
    cx: &DataContext,
    owner: &str,
    request_id: &str,
) -> Result<Option<Proposal>> {
    let row = cx
        .db()
        .query_opt(
            &format!("{PROPOSAL}request_id = $2"),
            &[&owner, &request_id],
        )
        .await?;
    Ok(row.as_ref().map(proposal_from))
}

pub(crate) fn proposal_json(row: &Proposal, source: &Source) -> Value {
    let before_fact = row.before["fact"].clone();
    let before_side = if row.before["state"] == "pending" {
        Value::Null
    } else {
        row.before["side"].clone()
    };
    let after = if row.kind == "undo" {
        Value::Null
    } else {
        row.proposed_text
            .as_ref()
            .map(|t| json!(t))
            .unwrap_or_else(|| before_fact["text"].clone())
    };
    json!({"id": row.id, "kind": row.kind, "receiptId": row.receipt_id, "source": source.json(),
           "expectedRevision": row.expected_revision, "side": row.side, "beforeSide": before_side,
           "before": before_fact, "after": after})
}
