//! Versioned private note copies for other modules. Each copy lives in the caller's
//! private vault root (resource `private-export`), never in the linked notes folder.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RESOURCE: &str = "private-export";
const REFERENCE_ROOT: &str = "notes/generated/";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    source_id: String,
    version: u64,
    content: String,
}

fn invalid() -> Error {
    Error::new("Invalid private note export identity")
}
fn unavailable() -> Error {
    Error::new("Notes service is unavailable")
}

/// Returns the source id in lowercase and the path inside the private export root.
fn target(request: &Request) -> Result<(String, String)> {
    let id = request.source_id.to_ascii_lowercase();
    let valid_id = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    if !valid_id || request.version < 1 || request.version > 2_147_483_647 {
        return Err(invalid());
    }
    Ok((id.clone(), format!("{id}/v{}.md", request.version)))
}

fn read(host: &impl Host, path: &str) -> Result<Option<String>> {
    let note = host
        .call("vault", "notes.read", RESOURCE, json!({"path":path}))
        .map_err(|_| unavailable())?;
    match &note["content"] {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(unavailable()),
    }
}

fn outcome(id: &str, version: u64, content: &str, status: &str) -> Value {
    let digest = Sha256::digest(content.as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    json!({
        "destination":"private-vault",
        "audience":"owner",
        "noteReference":format!("{REFERENCE_ROOT}{id}/v{version}.md"),
        "contentHash":hash,
        "status":status
    })
}

/// Reports whether the version is missing, identical or different, without writing.
pub fn inspect(host: &impl Host, request: &Request) -> Result<Value> {
    let (id, path) = target(request)?;
    let status = match read(host, &path)? {
        None => "missing",
        Some(text) if text == request.content => "unchanged",
        Some(_) => "conflict",
    };
    Ok(outcome(&id, request.version, &request.content, status))
}

/// Creates the version once. A retry compares complete bytes and never overwrites.
pub fn create_or_inspect(host: &impl Host, request: &Request) -> Result<Value> {
    let (id, path) = target(request)?;
    let mut created = false;
    if read(host, &path)?.is_none() {
        let note = host
            .call("vault", "notes.read", RESOURCE, json!({"path":path}))
            .map_err(|_| unavailable())?;
        host.call(
            "vault",
            "notes.compare-write",
            RESOURCE,
            json!({
                "path":path,
                "destinationId":note["destinationId"],
                "expected":null,
                "content":request.content
            }),
        )
        .map_err(|_| unavailable())?;
        created = true;
    }
    // Confirm the final bytes even after creation: another editor may have changed them.
    let status = match read(host, &path)? {
        Some(text) if text == request.content => {
            if created {
                "written"
            } else {
                "unchanged"
            }
        }
        _ => "conflict",
    };
    Ok(outcome(&id, request.version, &request.content, status))
}
