//! Work mail appends for Connectors. This is the only way work mail reaches a
//! note. It reads the current note, refuses a private one, skips an entry that
//! is already there, and writes by compare-and-swap so a note changed in the
//! meantime is reported back instead of being overwritten.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidatesRequest {
    query: String,
    limit: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendRequest {
    path: String,
    entry: String,
}

fn unavailable() -> Error {
    Error::new("Notes service is unavailable")
}

/// Same rule Connectors applies before asking: front matter that sets
/// `private` to anything but false makes the note private, and unreadable
/// front matter counts as private.
pub fn is_private(content: &str) -> bool {
    let text = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return false;
    };
    let Some(end) = rest.find("\n---").or_else(|| rest.find("\n...")) else { return true };
    let front = &rest[..end];
    if front.len() > 64_000 {
        return true;
    }
    front.lines().any(|line| {
        let trimmed = line.trim_start();
        match trimmed.strip_prefix("private:") {
            Some(value) => !matches!(value.trim(), "false" | "~" | "null" | ""),
            None => trimmed.starts_with("private :"),
        }
    })
}

fn read_note(host: &impl Host, path: &str) -> Result<Value> {
    host.call("vault", "notes.read", "source", json!({"path": path})).map_err(|_| unavailable())
}

pub fn candidates(host: &impl Host, request: &CandidatesRequest) -> Result<Value> {
    let limit = request.limit.unwrap_or(5).min(5);
    let found = host
        .call("vault", "index.search", "source", json!({"query": request.query, "limit": limit}))
        .map_err(|_| unavailable())?;
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for chunk in found["chunks"].as_array().cloned().unwrap_or_default() {
        let Some(path) = chunk["sourcePath"].as_str() else { continue };
        if !path.ends_with(".md") || path.starts_with('/') || path.split('/').any(|part| part == "..") {
            continue;
        }
        if seen.contains(&path.to_string()) {
            continue;
        }
        seen.push(path.to_string());
        let note = read_note(host, path)?;
        let Some(content) = note["content"].as_str() else { continue };
        if is_private(content) {
            continue;
        }
        let title = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md").to_string();
        out.push(json!({
            "index": out.len(),
            "path": path,
            "title": title,
            "excerpt": content.chars().take(1000).collect::<String>(),
        }));
        if out.len() >= limit as usize {
            break;
        }
    }
    Ok(json!({"candidates": out}))
}

pub fn append(host: &impl Host, request: &AppendRequest) -> Result<Value> {
    let path = if request.path == "default" { "Work mail notes.md" } else { request.path.as_str() };
    if !path.ends_with(".md") || path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Ok(json!({"result": "unavailable"}));
    }
    let note = read_note(host, path)?;
    let existing = note["content"].as_str().unwrap_or("").to_string();
    if is_private(&existing) {
        return Ok(json!({"result": "private"}));
    }
    if let Some(receipt) = request
        .entry
        .split("<!-- work-mail:")
        .nth(1)
        .and_then(|tail| tail.split("-->").next())
        .map(|hex| hex.trim())
        .filter(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        if existing.contains(&format!("<!-- work-mail:{receipt} -->")) {
            return Ok(json!({"result": "written"}));
        }
    }
    let written = host.call(
        "vault",
        "notes.compare-write",
        "source",
        json!({
            "path": path,
            "destinationId": note["destinationId"],
            "expected": note["content"],
            "content": format!("{existing}{}", request.entry),
        }),
    );
    match written {
        Ok(_) => Ok(json!({"result": "written"})),
        Err(_) => Ok(json!({"result": "changed"})),
    }
}
