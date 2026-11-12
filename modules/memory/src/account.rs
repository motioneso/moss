//! Account data calls. Export reads one section at a time and deletion removes everything the
//! signed-in person has in Memory. The host owns the SQL and the acting person, so neither call
//! takes an owner and neither returns a vector.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const SECTIONS: &[&str] = &[
    "memoryChunks",
    "chatMemoryFacts",
    "memoryEntities",
    "memoryFacts",
    "memoryEpisodes",
    "memoryFactSources",
    "memoryAliases",
    "memoryConflictGroups",
    "memoryCandidates",
    "memorySearchDocuments",
    "memoryLegacyFactMigrations",
    "recordingFactVersions",
    "recordingReceipts",
    "recordingProposals",
];

fn only(p: &Value, allowed: &[&str]) -> Result<()> {
    match p.as_object() {
        Some(map) if map.keys().all(|k| allowed.contains(&k.as_str())) => Ok(()),
        _ => Err(Error::new(400, "Invalid memory request")),
    }
}

/// Without a section, lists the section names. With one, returns a page of its rows and the
/// cursor for the next page (null when the section is finished).
pub fn export(host: &impl Host, p: &Value) -> Result<Value> {
    only(p, &["section", "after"])?;
    if p.get("section").is_none() && p.get("after").is_some() {
        return Err(Error::new(400, "Invalid memory request"));
    }
    if let Some(section) = p.get("section") {
        if !section.as_str().is_some_and(|s| SECTIONS.contains(&s)) {
            return Err(Error::new(400, "Unknown export section"));
        }
    }
    if let Some(after) = p.get("after") {
        if !after
            .as_str()
            .is_some_and(|a| a.len() <= 128 && !a.contains('\0'))
        {
            return Err(Error::new(400, "Invalid memory request"));
        }
    }
    Ok(kv(host, "get", "memory.account", p.clone())?)
}

/// Removes every Memory row the signed-in person owns and returns how many each table lost.
pub fn delete(host: &impl Host, p: &Value) -> Result<Value> {
    only(p, &[])?;
    Ok(kv(host, "set", "memory.account", json!({}))?)
}
