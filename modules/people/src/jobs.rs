//! Queue payloads contain only an immutable, account-scoped command reference.
//! Source hashes/versions stay in module records; a new cycle needs a new UUID.
use crate::{
    matching::{match_result, normalize_identity},
    repository::Repository,
    repository_mutations::{IdentityInput, LinkInput},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{Client, Error, Host, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const INDEX: &str = "person-index";
pub const MEMORY: &str = "sync-person-memory";
pub const COMMANDS: &str = "people-commands";
pub const PROVIDERS: &str = "person-providers";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexCommand {
    pub command_id: String,
    pub source: String,
    pub source_ref_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_version: Option<String>,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCommand {
    pub command_id: String,
    pub person_id: String,
    pub person_updated_at: String,
    pub reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    queue: String,
    command: Value,
    available_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    commands: Vec<IndexCommand>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Reference,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    #[serde(rename = "command-id")]
    command_id: String,
}

fn read(host: &impl Host, id: &str) -> Result<Option<Record>> {
    let value = host.call("kv", "records.get", COMMANDS, json!({"id":id}))?;
    if value.is_null() {
        Ok(None)
    } else {
        Ok(Some(serde_json::from_value(value)?))
    }
}
fn store(host: &impl Host, queue: &str, id: &str, command: Value) -> Result<Record> {
    if let Some(old) = read(host, id)? {
        return same(old, queue, &command);
    }
    let now = host.call("context", "read", "call", json!({}))?["now"]
        .as_str()
        .ok_or_else(|| Error::new("Missing job time"))?
        .parse::<DateTime<Utc>>()
        .map_err(|_| Error::new("Invalid job time"))?;
    let available = if queue == INDEX {
        now + Duration::minutes(15)
    } else {
        now
    };
    let value = json!({"queue":queue,"command":command,"availableAt":available.to_rfc3339_opts(SecondsFormat::Millis,true)});
    let reply = host.call(
        "kv",
        "records.put",
        COMMANDS,
        json!({"id":id,"value":value}),
    )?;
    same(
        serde_json::from_value(reply["value"].clone())?,
        queue,
        &command,
    )
}
fn same(record: Record, queue: &str, command: &Value) -> Result<Record> {
    if record.queue != queue || record.command != *command {
        return Err(Error::new("The People command reference is already in use"));
    }
    Ok(record)
}
fn enqueue(host: &impl Host, id: &str, record: &Record, deferred: bool) -> Result<()> {
    host.call(
        "jobs",
        if deferred {
            "enqueue-after-commit"
        } else {
            "enqueue-options"
        },
        &record.queue,
        json!({"params":{"command-id":id},"idempotencyKey":id,"availableAt":record.available_at}),
    )?;
    Ok(())
}
pub fn enqueue_index(host: &impl Host, command: &IndexCommand) -> Result<()> {
    let record = store(
        host,
        INDEX,
        &command.command_id,
        serde_json::to_value(command)?,
    )?;
    enqueue(host, &command.command_id, &record, false)
}
pub fn enqueue_memory(host: &impl Host, command: &MemoryCommand, deferred: bool) -> Result<()> {
    let record = store(
        host,
        MEMORY,
        &command.command_id,
        serde_json::to_value(command)?,
    )?;
    enqueue(host, &command.command_id, &record, deferred)
}
pub fn api(host: &impl Host, name: &str, parameters: Value) -> Result<Value> {
    match name {
        "enqueueIndex" => {
            enqueue_index(host, &serde_json::from_value(parameters)?)?;
            Ok(json!({"enqueued":true}))
        }
        "enqueueIndexBatch" => {
            let batch: Batch = serde_json::from_value(parameters)?;
            for command in batch.commands.iter().take(50) {
                enqueue_index(host, command)?;
            }
            Ok(json!({"enqueued":batch.commands.len().min(50)}))
        }
        "enqueueMemorySync" => {
            enqueue_memory(host, &serde_json::from_value(parameters)?, false)?;
            Ok(json!({"enqueued":true}))
        }
        _ => Err(Error::new("Unknown People job API")),
    }
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    let record = read(host, &job.parameters.command_id)?
        .ok_or_else(|| Error::new("People command not found"))?;
    if job.queue != record.queue {
        return Err(Error::new("The People command has another job kind"));
    }
    match record.queue.as_str() {
        INDEX => index(host, &serde_json::from_value(record.command)?)?,
        // The old worker performs no memory writes. Do not invent one in the port.
        MEMORY => {
            let _: MemoryCommand = serde_json::from_value(record.command)?;
        }
        _ => return Err(Error::new("Unknown People job")),
    }
    Ok("{}".into())
}

fn index(host: &impl Host, command: &IndexCommand) -> Result<()> {
    // Trusted composition supplies source-kind -> declared provider module. Missing
    // providers are a no-op, exactly as in the old worker. Providers read as this actor.
    let providers = host.call("kv", "get", PROVIDERS, json!({}))?;
    let Some(provider) = providers.get(&command.source).and_then(Value::as_str) else {
        return Ok(());
    };
    let mut input = json!({"sourceRefHash":command.source_ref_hash});
    if let Some(version) = &command.source_version {
        input["sourceVersion"] = json!(version);
    }
    // No People DB query precedes provider I/O. The host opens the invocation's
    // transaction lazily; all subsequent People writes share it.
    let batch = Client(host).api(provider, "collectPersonSignals", input)?;
    let signals = batch["signals"]
        .as_array()
        .ok_or_else(|| Error::new("Invalid People signals"))?;
    let entries = match_result(signals).map_err(Error::new)?;
    let repo = Repository::new(host);
    let mut people = Vec::new();
    let mut seen = BTreeSet::new();
    for (_, entry) in entries {
        let person = repo.find_or_create_person(&entry.display_value)?;
        let person_id = text(&person, "id")?;
        if seen.insert(person_id.to_owned()) {
            people.push(person_id.to_owned());
        }
        let first = entry.signals.first();
        repo.upsert_identity(&IdentityInput {
            person_id: Some(person_id.into()),
            identity_kind: entry.identity_kind.clone(),
            source_kind: command.source.clone(),
            normalized_value: normalize_identity(&entry.identity_kind, &entry.normalized_value),
            display_value: entry.display_value,
            source_ref: first
                .and_then(|s| s["sourceRef"].as_str())
                .map(str::to_owned),
            source_ref_hash: Some(command.source_ref_hash.clone()),
            status: Some("active".into()),
            confidence: Some(entry.confidence),
            provenance: Some("source".into()),
        })?;
        for signal in entry.signals {
            let hash = text(&signal, "sourceRefHash")?;
            let kind = text(&signal, "linkKind")?;
            let confidence = signal["confidence"]
                .as_f64()
                .ok_or_else(|| Error::new("Missing signal confidence"))?;
            let link = repo.upsert_link(&LinkInput {
                person_id: person_id.into(),
                source_kind: command.source.clone(),
                source_ref: text(&signal, "sourceRef")?.into(),
                source_ref_hash: hash.into(),
                link_kind: kind.into(),
                source_label: optional(&signal, "sourceLabel"),
                summary: optional(&signal, "summary"),
                occurred_at: optional(&signal, "occurredAt"),
                source_updated_at: None,
                confidence: Some(confidence),
                provenance: Some(text(&signal, "provenance")?.into()),
            })?;
            repo.upsert_link_source(text(&link, "id")?, None, hash, kind, confidence)?;
        }
        repo.event(
            "identity_linked",
            Some(person_id),
            None,
            None,
            None,
            Some(&command.source_ref_hash),
        )?;
    }
    let source_ref = signals
        .first()
        .and_then(|s| s["sourceRef"].as_str())
        .unwrap_or(&command.source_ref_hash);
    repo.save_indexing_state(&command.source,&command.source_ref_hash,source_ref,
        json!({"last_indexed_at":repo.now()?,"last_source_version":command.source_version,"failure_count":0}))?;
    // These enqueues are published only after the invocation's database commit.
    // A queue failure after commit can retry indexing, matching the old at-least-once seam.
    for person_id in people {
        let id = child_id(&command.command_id, &person_id);
        let memory = match read(host, &id)? {
            Some(record) if record.queue == MEMORY => serde_json::from_value(record.command)?,
            Some(_) => return Err(Error::new("The People command reference is already in use")),
            None => MemoryCommand {
                command_id: id,
                person_id,
                person_updated_at: repo.now()?,
                reason: "index_complete".into(),
            },
        };
        enqueue_memory(host, &memory, true)?;
    }
    Ok(())
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| Error::new("Invalid People signal or projection"))
}
fn optional(value: &Value, field: &str) -> Option<String> {
    value[field].as_str().map(str::to_owned)
}
fn child_id(parent: &str, person: &str) -> String {
    let mut digest: [u8; 32] =
        Sha256::digest(format!("people-memory:{parent}:{person}").as_bytes()).into();
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // Format the digest bytes directly; no random source is imported by the guest.
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
