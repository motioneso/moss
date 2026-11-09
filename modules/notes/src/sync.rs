//! Sync coordinator parity checkpoint. Core owns filesystem admission, embedding,
//! indexing transactions and managed publication. No sync service is shipped yet.
//! These calls are exercised only by the write-tools checkpoint component.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MAX_CHUNKS: u64 = 100;
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parameters {
    source_path: Option<String>,
    file_path: Option<String>,
    #[serde(default)]
    chunk_offset: u64,
    file_hash: Option<String>,
    snapshot_key: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    name: String,
    parameters: Parameters,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    source_path: Option<String>,
    files: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    status: Status,
    chunks_processed: u64,
    continuation: Option<Continuation>,
    file_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ingested,
    Skipped,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Continuation {
    chunk_offset: u64,
    file_hash: String,
    snapshot_key: Option<String>,
}
#[derive(Default)]
struct Counts {
    ingested: u64,
    skipped: u64,
    errors: u64,
}
impl Counts {
    fn value(&self) -> Value {
        json!({"ingested":self.ingested,"skipped":self.skipped,"errors":self.errors})
    }
    fn deferred(
        &self,
        source: &str,
        file: &str,
        offset: u64,
        hash: &str,
        snapshot: Option<&str>,
    ) -> Value {
        let mut result = self.value();
        result["deferred"] = json!(true);
        let mut next =
            json!({"sourcePath":source,"filePath":file,"chunkOffset":offset,"fileHash":hash});
        if let Some(snapshot) = snapshot.filter(|s| !s.is_empty()) {
            next["snapshotKey"] = json!(snapshot);
        }
        result["continuation"] = next;
        result
    }
}
fn safe_error(code: Option<&str>) -> String {
    let sentence = match code {
        Some("ENOENT") => "a file in the linked notes source no longer exists",
        Some("EACCES" | "EPERM") => "permission denied reading a file in the linked notes source",
        Some("ENOTDIR") => "a folder in the linked notes source is not a folder",
        Some("EISDIR") => "expected a file in the linked notes source but found a folder",
        Some("ELOOP") => "a symlink loop in the linked notes source could not be resolved",
        Some("EMFILE") => "too many open files while reading the linked notes source",
        Some("ENFILE") => "too many open files while reading the linked notes source",
        Some("ENAMETOOLONG") => "a path in the linked notes source is too long",
        Some("EIO") => "a read error occurred in the linked notes source",
        Some("OUTSIDE") => return "path is not within the linked notes source".into(),
        Some(code)
            if (2..=16).contains(&code.len())
                && code.starts_with('E')
                && code.bytes().all(|b| b.is_ascii_uppercase()) =>
        {
            return format!("notes sync failed ({code})")
        }
        _ => return "notes sync failed (Error)".into(),
    };
    format!("notes sync failed: {sentence}")
}
fn service_error() -> Error {
    Error::new(safe_error(None))
}
fn call(host: &impl Host, operation: &str, parameters: Value) -> Result<Value> {
    let value = host
        .call("vault", operation, "source", parameters)
        .map_err(|_| service_error())?;
    if value.get("error").is_some() {
        return Err(Error::new(safe_error(value["error"].as_str())));
    }
    Ok(value)
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    if job.name != "notes.sync" || job.parameters.chunk_offset > (1u64 << 53) - 1 {
        return Err(Error::new("Invalid Notes sync checkpoint"));
    }
    Ok(run(host, job.parameters)?.to_string())
}
fn run(host: &impl Host, input: Parameters) -> Result<Value> {
    let open: Open = serde_json::from_value(call(
        host,
        "index.sync-open",
        json!({"sourcePath":input.source_path}),
    )?)?;
    let mut counts = Counts::default();
    let Some(source) = open.source_path.filter(|s| !s.is_empty()) else {
        let mut result = counts.value();
        result["noOp"] = json!(true);
        return Ok(result);
    };
    let start = input
        .file_path
        .as_ref()
        .and_then(|file| open.files.iter().position(|path| path == file))
        .unwrap_or(0);
    let mut budget = MAX_CHUNKS;
    let mut last_error = safe_error(None);
    for (index, file) in open.files.iter().enumerate().skip(start) {
        if budget == 0 {
            return Ok(counts.deferred(&source, file, 0, "", None));
        }
        let mut parameters = json!({"sourcePath":source,"filePath":file,"chunkOffset":if index == start {input.chunk_offset} else {0},"chunkLimit":budget});
        if index == start {
            if let Some(hash) = &input.file_hash {
                parameters["expectedFileHash"] = json!(hash);
            }
            if let Some(snapshot) = &input.snapshot_key {
                parameters["expectedSnapshotKey"] = json!(snapshot);
            }
        }
        let progress = match call(host, "index.sync-file", parameters) {
            Ok(value) => serde_json::from_value::<Progress>(value).ok(),
            Err(error) => {
                counts.errors += 1;
                last_error = error.message;
                continue;
            }
        };
        let Some(progress) = progress.filter(|p| p.chunks_processed <= budget) else {
            counts.errors += 1;
            last_error = safe_error(None);
            continue;
        };
        budget -= progress.chunks_processed;
        if let Some(next) = progress.continuation {
            return Ok(counts.deferred(
                &source,
                progress.file_path.as_deref().unwrap_or(file),
                next.chunk_offset,
                &next.file_hash,
                next.snapshot_key.as_deref(),
            ));
        }
        match progress.status {
            Status::Ingested => counts.ingested += 1,
            Status::Skipped => counts.skipped += 1,
        }
    }
    purge_deleted(host, &source, &open.files)?;
    if counts.ingested == 0 && counts.skipped == 0 && counts.errors > 0 {
        return Err(Error::new(format!(
            "notes sync: all {} file(s) failed; last error: {last_error}",
            counts.errors
        )));
    }
    Ok(counts.value())
}

/// Preserve the source-of-truth walk, including entries whose realpath/read failed.
/// An empty walk may mean an unmounted folder and must leave the index untouched.
fn purge_deleted(host: &impl Host, source: &str, files: &[String]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let mut present: BTreeSet<String> = files.iter().cloned().collect();
    for file in files {
        if let Ok(value) = call(
            host,
            "index.sync-canonical",
            json!({"sourcePath":source,"filePath":file}),
        ) {
            if let Some(path) = value["path"].as_str() {
                present.insert(path.into());
            }
        }
    }
    let value = call(host, "index.sync-indexed", json!({"sourcePath":source}))?;
    let paths: Vec<String> = serde_json::from_value(value["paths"].clone())?;
    let prefix = format!("{source}/");
    for path in paths {
        if path.starts_with(&prefix) && !present.contains(&path) {
            // Core must atomically remove the actor's Notes chunks, file links and
            // index row. It must repeat source/account admission, never trust paths.
            call(
                host,
                "index.sync-remove",
                json!({"sourcePath":source,"filePath":path}),
            )?;
        }
    }
    Ok(())
}
