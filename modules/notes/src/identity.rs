//! Stable legacy identities. Domain strings and array ordering are data compatibility rules.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub fn hex_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn digest(domain: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(value);
    format!("{:x}", hash.finalize())
}
fn uuid(s: &str, label: &str) -> Result<String> {
    if s.len() != 36 || uuid::Uuid::parse_str(s).is_err() {
        return Err(Error(format!("{label} must be a UUID")));
    }
    Ok(s.to_ascii_lowercase())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSource {
    pub source_module_id: String,
    pub source_id: String,
    pub source_version: i64,
    pub item_key: String,
}
impl RecordingSource {
    pub fn validate(&self) -> Result<()> {
        if self.source_module_id != "meetings" {
            return Err(Error("Unsupported recording source module".into()));
        }
        uuid(&self.source_id, "Recording source ID")?;
        if !(1..=i32::MAX as i64).contains(&self.source_version) {
            return Err(Error("Invalid recording source version".into()));
        }
        if self.item_key.is_empty()
            || self.item_key.len() > 80
            || !self
                .item_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(Error("Invalid recording item key".into()));
        }
        Ok(())
    }
}
pub fn block_id(owner: &str, source: &RecordingSource) -> Result<String> {
    let owner = uuid(owner, "Recording note owner")?;
    source.validate()?;
    Ok(digest(
        "moss:recording-note-block:v1\0",
        &json!([
            owner,
            source.source_module_id,
            uuid(&source.source_id, "Recording source ID")?,
            source.source_version,
            source.item_key
        ])
        .to_string(),
    ))
}
pub fn fallback_reference(source: &RecordingSource, side: &str) -> Result<String> {
    source.validate()?;
    side_valid(side)?;
    Ok(format!(
        "notes/recordings/{side}/{}/v{}.md",
        uuid(&source.source_id, "Recording source ID")?,
        source.source_version
    ))
}
pub fn destination_id(canonical_path: &str) -> String {
    digest("moss:managed-note-destination:v1\0", canonical_path)
}
fn side_valid(side: &str) -> Result<()> {
    if matches!(side, "personal" | "work") {
        Ok(())
    } else {
        Err(Error("Invalid recording side".into()))
    }
}
fn generation(n: i64) -> Result<()> {
    if (0..=i32::MAX as i64).contains(&n) {
        Ok(())
    } else {
        Err(Error("Invalid managed snapshot revision".into()))
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceKey {
    pub owner_user_id: String,
    pub source_module_id: String,
    pub source_id: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct SourceRevision {
    pub source: SourceKey,
    pub generation: i64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub owner_user_id: String,
    pub actor_generation: i64,
    pub sources: Vec<SourceRevision>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub destination_id: String,
    pub content_hash: String,
    pub binding_revision: i64,
    pub side: String,
    pub lifecycle: Lifecycle,
}
pub fn snapshot_key(input: &Snapshot) -> Result<String> {
    if !hex_digest(&input.destination_id) || !hex_digest(&input.content_hash) {
        return Err(Error("Invalid managed snapshot identity".into()));
    }
    if !matches!(input.side.as_str(), "personal" | "work") {
        return Err(Error("Invalid managed snapshot side".into()));
    }
    generation(input.binding_revision)?;
    generation(input.lifecycle.actor_generation)?;
    let owner = uuid(&input.lifecycle.owner_user_id, "Managed snapshot owner")?;
    if input.lifecycle.sources.len() > 2048 {
        return Err(Error(
            "A managed snapshot permits at most 2048 represented sources".into(),
        ));
    }
    let mut sources = BTreeMap::new();
    for entry in &input.lifecycle.sources {
        if entry.source.owner_user_id.to_ascii_lowercase() != owner {
            return Err(Error(
                "Managed snapshot sources require the same owner".into(),
            ));
        }
        let id = uuid(&entry.source.source_id, "Managed snapshot source")?;
        let module = &entry.source.source_module_id;
        if module.is_empty()
            || module.len() > 64
            || !module.as_bytes()[0].is_ascii_lowercase()
            || !module
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        {
            return Err(Error("Invalid managed snapshot module".into()));
        }
        generation(entry.generation)?;
        let key = json!([module, id]).to_string();
        if sources
            .insert(key, entry.generation)
            .is_some_and(|g| g != entry.generation)
        {
            return Err(Error(
                "A managed source cannot have conflicting generations".into(),
            ));
        }
    }
    let sources: Vec<_> = sources.into_iter().collect();
    Ok(digest(
        "moss:managed-note-snapshot:v1\0",
        &json!([
            owner,
            input.destination_id,
            input.content_hash,
            input.binding_revision,
            input.side,
            input.lifecycle.actor_generation,
            sources
        ])
        .to_string(),
    ))
}
