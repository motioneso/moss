//! Recording memory: facts the Meetings feature derives from a recording, with their receipts,
//! proposals, lineage, cleanup and export. Every statement runs in the caller's transaction
//! under row-level security. Meetings owns source generations and removal state, so this code
//! asks a `RecordingAuthority` about them; with none connected every change is refused.
//! Fact text never leaves the database except in the caller's own response.
mod apply;
mod cleanup;
mod lineage;
mod prepare;
mod receipt;

use anyhow::{anyhow, Result};
use moss_module_host::{runtime::Request, trust::digest};
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::fmt;

pub const UNAVAILABLE: &str = "This recording memory is unavailable";
pub const CONFLICT: &str = "This recording memory has changed; refresh its current review";
pub const INPUT: &str = "Recording facts require nonempty text of at most 2048 UTF-8 bytes";
pub const CHANGED: &str =
    "This recording's memory has changed or is being removed; refresh its saved state before continuing";
pub const INCOMPLETE: &str = "Recording Memory cleanup is incomplete";

/// A refusal the guest turns into a plain status. Returning it as an error rolls the
/// transaction back, so a refused call never leaves partial writes.
#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    pub message: &'static str,
}
impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Refusal {}

pub(crate) fn refuse(status: u16, message: &'static str) -> anyhow::Error {
    anyhow::Error::new(Refusal { status, message })
}
pub(crate) fn unavailable() -> anyhow::Error {
    refuse(404, UNAVAILABLE)
}
pub(crate) fn conflict() -> anyhow::Error {
    refuse(409, CONFLICT)
}
pub(crate) fn changed() -> anyhow::Error {
    refuse(409, CHANGED)
}

/// The refusal for an error, if it is one. A lock that cannot be taken, or a database check
/// that rejects a stale write, means the recording changed under the caller.
pub fn refusal_of(error: &anyhow::Error) -> Option<(u16, &'static str)> {
    if let Some(r) = error.downcast_ref::<Refusal>() {
        return Some((r.status, r.message));
    }
    let code = error
        .downcast_ref::<tokio_postgres::Error>()?
        .code()?
        .code();
    matches!(code, "55P03" | "23514" | "40001" | "40P01").then_some((409, CHANGED))
}

/// What Meetings reports about one source recording.
#[derive(Clone, Debug)]
pub struct SourceState {
    pub generation: i32,
    pub version: i32,
    pub side: String,
    pub actor_generation: i32,
}

/// Meetings' answers about generations and removal. Implemented by the Meetings feature.
pub trait RecordingAuthority: Send + Sync {
    /// The source's current state, or none when it is unknown, fenced or being removed.
    fn current(&self, owner: &str, source_id: &str) -> Option<SourceState>;
    /// True while the cleanup operation is open for this owner and covers exactly this scope
    /// (one source, or the whole account when `source_id` is none).
    fn cleaning(&self, owner: &str, operation_id: &str, source_id: Option<&str>) -> bool;
    /// True once the operation has sealed its source.
    fn sealed(&self, owner: &str, operation_id: &str) -> bool;
}

/// Used until Meetings is ported. Nothing is ever admitted.
pub struct NoAuthority;
impl RecordingAuthority for NoAuthority {
    fn current(&self, _: &str, _: &str) -> Option<SourceState> {
        None
    }
    fn cleaning(&self, _: &str, _: &str, _: Option<&str>) -> bool {
        false
    }
    fn sealed(&self, _: &str, _: &str) -> bool {
        false
    }
}

pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

pub(crate) fn item_key_ok(s: &str) -> bool {
    (1..=80).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A validated source identity from a request.
pub(crate) struct Source {
    pub id: String,
    pub version: i32,
    pub item_key: String,
}
impl Source {
    pub fn parse(v: &Value) -> Result<Self> {
        let id = v["sourceId"].as_str().unwrap_or("");
        let version = v["sourceVersion"].as_i64().unwrap_or(0);
        let key = v["itemKey"].as_str().unwrap_or("");
        if v["sourceModuleId"] != "meetings"
            || !is_uuid(id)
            || !(1..=2147483645).contains(&version)
            || !item_key_ok(key)
        {
            return Err(unavailable());
        }
        Ok(Self {
            id: id.to_lowercase(),
            version: version as i32,
            item_key: key.to_owned(),
        })
    }
    pub fn json(&self) -> Value {
        json!({"sourceModuleId": "meetings", "sourceId": self.id, "sourceVersion": self.version, "itemKey": self.item_key})
    }
}

/// The receipt id the old code derived, byte for byte, so rows written by either side match.
pub(crate) fn receipt_id(owner: &str, source: &Source) -> String {
    let text = json!([
        "recording-memory-v1",
        owner.to_lowercase(),
        "meetings",
        source.id,
        source.version,
        source.item_key
    ]);
    digest(text.to_string().as_bytes())
}

pub(crate) async fn actor(cx: &DataContext) -> Result<String> {
    Ok(cx
        .db()
        .query_one("SELECT app.current_actor_user_id()::text", &[])
        .await?
        .get(0))
}

pub(crate) async fn settle(cx: &DataContext) -> Result<()> {
    cx.db()
        .batch_execute("SET CONSTRAINTS ALL IMMEDIATE")
        .await?;
    Ok(())
}

pub(crate) fn must<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p[name].as_str().ok_or_else(|| anyhow!("Missing {name}"))
}

pub async fn run(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    let owner = actor(cx).await?;
    let out = match (request.operation.as_str(), p["action"].as_str()) {
        ("get", Some("inspect")) => receipt::inspect(cx, &owner, &p["source"]).await?,
        ("get", Some("export")) => cleanup::export(cx).await?,
        ("set", Some("prepare")) => prepare::run(cx, authority, &owner, &p["input"]).await?,
        ("set", Some("applyLoad")) => apply::load(cx, &owner, must(p, "proposalId")?).await?,
        ("set", Some("applyPublish")) => apply::publish(cx, authority, &owner, p).await?,
        ("set", Some("transfer")) => lineage::transfer_call(cx, authority, &owner, p).await?,
        ("set", Some("synchronize")) => lineage::synchronize_call(cx, authority, &owner, p).await?,
        ("set", Some("cleanup")) => cleanup::cleanup(cx, authority, &owner, p).await?,
        ("set", Some("assertComplete")) => cleanup::assert_complete(cx, &owner, p).await?,
        ("set", Some("retireSource")) => cleanup::retire_source(cx, authority, &owner, p).await?,
        _ => return Err(anyhow!("Unknown recording memory request")),
    };
    settle(cx).await?;
    Ok(out)
}
