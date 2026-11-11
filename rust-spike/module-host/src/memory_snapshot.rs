//! Index snapshots for private vault notes. A snapshot names the exact note content plus any
//! managed note label, so stale index rows are never published over a newer label.
//! Domain strings and array order match the TypeScript identities byte for byte.
use anyhow::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) fn digest(domain: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(value);
    format!("{:x}", hash.finalize())
}

pub(crate) fn destination_id(canonical_path: &str) -> String {
    digest("moss:managed-note-destination:v1\0", canonical_path)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub module: String,
    pub id: String,
    pub generation: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub owner: String,
    pub destination_id: String,
    pub content_hash: String,
    pub key: String,
    pub side: Option<String>,
    pub binding_revision: Option<i32>,
    pub actor_generation: Option<i32>,
    pub sources: Vec<Source>,
}

impl Snapshot {
    /// The stored `managed_snapshot` value, in the shape the TypeScript code writes.
    pub fn json(&self) -> Value {
        json!({
            "ownerUserId": self.owner,
            "destinationId": self.destination_id,
            "contentHash": self.content_hash,
            "key": self.key,
            "side": self.side,
            "bindingRevision": self.binding_revision,
            "actorGeneration": self.actor_generation,
            "sources": self.sources.iter().map(|s| json!({
                "sourceModuleId": s.module, "sourceId": s.id, "generation": s.generation
            })).collect::<Vec<_>>(),
        })
    }
}

pub(crate) fn unmanaged(owner: Uuid, destination: String, content_hash: String) -> Snapshot {
    let owner = owner.to_string().to_ascii_lowercase();
    let key = digest(
        "",
        &json!([
            "moss:unmanaged-vault-snapshot:v1",
            owner,
            destination,
            content_hash
        ])
        .to_string(),
    );
    Snapshot {
        owner,
        destination_id: destination,
        content_hash,
        key,
        side: None,
        binding_revision: None,
        actor_generation: None,
        sources: Vec::new(),
    }
}

pub(crate) fn managed(
    owner: Uuid,
    destination: String,
    content_hash: String,
    binding_revision: i32,
    side: &str,
    actor_generation: i32,
    sources: Vec<Source>,
) -> Result<Snapshot> {
    anyhow::ensure!(matches!(side, "personal" | "work"), "Invalid managed snapshot side");
    anyhow::ensure!(sources.len() <= 2048, "Too many represented sources");
    let owner = owner.to_string().to_ascii_lowercase();
    let mut keyed = BTreeMap::new();
    for source in &sources {
        let id = source.id.to_ascii_lowercase();
        let name = json!([source.module, id]).to_string();
        anyhow::ensure!(
            keyed
                .insert(name, source.generation)
                .is_none_or(|g| g == source.generation),
            "A managed source cannot have conflicting generations"
        );
    }
    let ordered: Vec<_> = keyed.into_iter().collect();
    let key = digest(
        "moss:managed-note-snapshot:v1\0",
        &json!([
            owner,
            destination,
            content_hash,
            binding_revision,
            side,
            actor_generation,
            ordered
        ])
        .to_string(),
    );
    Ok(Snapshot {
        owner,
        destination_id: destination,
        content_hash,
        key,
        side: Some(side.to_owned()),
        binding_revision: Some(binding_revision),
        actor_generation: Some(actor_generation),
        sources,
    })
}

/// True when the note still holds exactly one intact block for this receipt.
pub(crate) fn block_unchanged(note: &str, receipt_id: &str, bytes: &str) -> bool {
    let prefix = format!("<!-- moss-recording:v1:{receipt_id}:");
    let begin = format!("{prefix}begin -->");
    let end = format!("{prefix}end -->");
    note.matches(&prefix).count() == 2
        && note.matches(&begin).count() == 1
        && note.matches(&end).count() == 1
        && note.contains(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values come from node's crypto over the TypeScript formulas.
    const OWNER: &str = "11111111-2222-3333-4444-555555555555";
    const DESTINATION: &str = "30dba93608b439b2fdbd8624c758238c7e4d94220283cde7691d652dc091a5ae";
    const CONTENT: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn identities_match_the_typescript_values() {
        let owner = Uuid::parse_str(OWNER).unwrap();
        assert_eq!(destination_id("/vault/notes/generated/a/v1.md"), DESTINATION);
        assert_eq!(digest("", "hello"), CONTENT);
        let plain = unmanaged(owner, DESTINATION.into(), CONTENT.into());
        assert_eq!(
            plain.key,
            "4e07fec3c0cd3a1a017e04bf40b0441a5e5194f431f39e7af7395c5dec403c9c"
        );
        assert_eq!(plain.json()["side"], Value::Null);
        let source = Source {
            module: "meetings".into(),
            id: Uuid::nil().to_string(),
            generation: 1,
        };
        let labelled =
            managed(owner, DESTINATION.into(), CONTENT.into(), 2, "work", 3, vec![source]).unwrap();
        assert_eq!(
            labelled.key,
            "84800718ec1f1f659b63843325818e419d4e2a98748a50a418c74da997603f36"
        );
    }

    #[test]
    fn managed_key_changes_with_any_label_part() {
        let owner = Uuid::nil();
        let source = Source {
            module: "meetings".into(),
            id: Uuid::nil().to_string(),
            generation: 1,
        };
        let base = managed(owner, "a".repeat(64), "b".repeat(64), 1, "work", 3, vec![source.clone()])
            .unwrap();
        let moved = managed(owner, "a".repeat(64), "b".repeat(64), 2, "work", 3, vec![source.clone()])
            .unwrap();
        let flipped = managed(owner, "a".repeat(64), "b".repeat(64), 1, "personal", 3, vec![source])
            .unwrap();
        assert_ne!(base.key, moved.key);
        assert_ne!(base.key, flipped.key);
    }

    #[test]
    fn block_check_requires_one_intact_pair() {
        let id = "c".repeat(64);
        let bytes = format!("\n<!-- moss-recording:v1:{id}:begin -->\nhi\n<!-- moss-recording:v1:{id}:end -->\n");
        assert!(block_unchanged(&bytes, &id, &bytes));
        assert!(!block_unchanged("nothing", &id, &bytes));
        let doubled = format!("{bytes}{bytes}");
        assert!(!block_unchanged(&doubled, &id, &bytes));
        assert!(!block_unchanged(&bytes.replace("hi", "bye"), &id, &bytes));
    }
}
