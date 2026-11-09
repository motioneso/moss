//! Core-owned Notes file ingestion. The guest chooses no account, source
//! kind, folder, model or table. Managed publication is not handled here:
//! a requested snapshot key is refused rather than silently dropped.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;
use vault::{AllowedRoots, EntryKind, VaultContext};

const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHUNK_CHARS: usize = 2000;

pub trait DocumentEmbeddings: Send + Sync {
    fn model_name(&self) -> &str;
    fn model_version(&self) -> &str;
    fn embed_document(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>>;
}

pub struct MemoryIngestSource {
    pub source_kind: String,
    pub preference_key: String,
    pub roots: BTreeMap<Uuid, Vec<PathBuf>>,
}

pub struct MemoryIngestPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embeddings: Arc<dyn DocumentEmbeddings>,
    sources: BTreeMap<(String, String), MemoryIngestSource>,
    next: Arc<dyn Ports>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    source_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct File {
    source_path: String,
    file_path: String,
    chunk_offset: u64,
    chunk_limit: u64,
    expected_file_hash: Option<String>,
    expected_snapshot_key: Option<String>,
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn sanitize(text: &str) -> String {
    text.chars()
        .filter(
            |c| !matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'),
        )
        .collect()
}
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}
fn count_newlines(text: &str) -> i64 {
    text.matches('\n').count() as i64
}
fn count_lines(text: &str) -> i64 {
    count_newlines(text) + 1
}

struct Chunk {
    text: String,
    line_start: i64,
    line_end: i64,
}

/// Port of the legacy document parser. Its size budget counts UTF-16 units,
/// matching the JavaScript string length the original code used.
fn parse_document(content: &str) -> (Vec<String>, Vec<Chunk>) {
    let (frontmatter, body) = match frontmatter_end(content) {
        Some((fm, end)) => (fm, &content[end..]),
        None => ("", content),
    };
    let _ = frontmatter;
    let mut links = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        let target = inner.split('|').next().unwrap_or("");
        if !target.contains(']') {
            links.push(target.trim().to_string());
        }
        rest = &after[end + 2..];
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return (links, Vec::new());
    }
    let mut sections: Vec<&str> = Vec::new();
    let mut start = 0;
    for (index, _) in trimmed.match_indices("\n## ") {
        sections.push(&trimmed[start..=index]);
        start = index + 1;
    }
    sections.push(&trimmed[start..]);
    let sections: Vec<&str> = sections
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    let mut running = count_lines(content) - count_lines(body);
    let mut chunks = Vec::new();
    for section in sections {
        let mut offset = 0i64;
        for part in cap_chunk_size(section) {
            let newlines = count_newlines(&part);
            let text = part.trim();
            if !text.is_empty() {
                chunks.push(Chunk {
                    text: text.to_string(),
                    line_start: running + offset,
                    line_end: running + offset + newlines,
                });
            }
            offset += newlines;
        }
        running += count_lines(section);
    }
    (links, chunks)
}

fn frontmatter_end(content: &str) -> Option<(&str, usize)> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    // Find the closing fence at the start of a line.
    let mut search = 0;
    loop {
        let idx = rest[search..].find("\n---")? + search;
        let after = &rest[idx + 4..];
        let fm = &rest[..idx];
        if let Some(tail) = after.strip_prefix("\r\n") {
            return Some((fm, content.len() - tail.len()));
        }
        if let Some(tail) = after.strip_prefix('\n') {
            return Some((fm, content.len() - tail.len()));
        }
        if after.is_empty() {
            return Some((fm, content.len()));
        }
        search = idx + 1;
    }
}

fn split_after_blank(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                parts.push(text[start..=j].to_string());
                start = j + 1;
                i = start;
                continue;
            }
        }
        i += 1;
    }
    if start < text.len() {
        parts.push(text[start..].to_string());
    }
    parts
}

fn cut_utf16(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    let mut len = 0;
    for c in text.chars() {
        if len + c.len_utf16() > MAX_CHUNK_CHARS && !current.is_empty() {
            units.push(std::mem::take(&mut current));
            len = 0;
        }
        current.push(c);
        len += c.len_utf16();
    }
    if !current.is_empty() {
        units.push(current);
    }
    units
}

fn split_to_budget(paragraph: &str) -> Vec<String> {
    if utf16_len(paragraph) <= MAX_CHUNK_CHARS {
        return vec![paragraph.to_string()];
    }
    let mut units = Vec::new();
    let mut current = String::new();
    for line in paragraph.split_inclusive('\n') {
        if utf16_len(line) > MAX_CHUNK_CHARS {
            if !current.is_empty() {
                units.push(std::mem::take(&mut current));
            }
            units.extend(cut_utf16(line));
            continue;
        }
        if !current.is_empty() && utf16_len(&current) + utf16_len(line) > MAX_CHUNK_CHARS {
            units.push(std::mem::take(&mut current));
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        units.push(current);
    }
    units
}

fn cap_chunk_size(section: &str) -> Vec<String> {
    if utf16_len(section) <= MAX_CHUNK_CHARS {
        return vec![section.to_string()];
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    for paragraph in split_after_blank(section) {
        for unit in split_to_budget(&paragraph) {
            if !current.is_empty() && utf16_len(&current) + utf16_len(&unit) > MAX_CHUNK_CHARS {
                parts.push(std::mem::take(&mut current));
            }
            current.push_str(&unit);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

impl MemoryIngestPorts {
    pub fn new(
        database: Database,
        embeddings: Arc<dyn DocumentEmbeddings>,
        sources: BTreeMap<(String, String), MemoryIngestSource>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            embeddings,
            sources,
            next,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })
    }

    fn source<'a>(&'a self, scope: &CallScope, r: &Request) -> Result<&'a MemoryIngestSource> {
        crate::runtime::authorize(scope.module(), "vault", r)?;
        self.sources
            .get(&(scope.module().id.clone(), r.resource.clone()))
            .context("Memory ingest source is not connected")
    }

    async fn saved_source(
        &self,
        scope: &CallScope,
        source: &MemoryIngestSource,
        lock: bool,
    ) -> Result<Option<(String, VaultContext)>> {
        let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
            .await
            .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
        let sql = if lock {
            "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id() FOR SHARE"
        } else {
            "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id()"
        };
        let row = cx.db().query_opt(sql, &[&source.preference_key]).await?;
        let saved = row.and_then(|row| {
            let value: Value = row.get(0);
            value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
        });
        let Some(saved) = saved else {
            cx.commit_bounded(scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
            return Ok(None);
        };
        let roots = source
            .roots
            .get(&scope.access().actor_user_id())
            .cloned()
            .unwrap_or_default();
        ensure!(!roots.is_empty(), "Notes roots are not configured");
        let allowed = AllowedRoots::for_account(scope.access(), roots);
        let folder = VaultContext::at_allowed_root(scope.access(), Path::new(&saved), &allowed)?;
        Ok(Some((saved, folder)))
    }

    fn open(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let source = self.source(scope, r)?.clone_source();
        let input: Open = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let resolved = match &input.source_path {
                    Some(path) if !path.is_empty() => {
                        let roots = source
                            .roots
                            .get(&scope.access().actor_user_id())
                            .cloned()
                            .unwrap_or_default();
                        ensure!(!roots.is_empty(), "Notes roots are not configured");
                        let allowed = AllowedRoots::for_account(scope.access(), roots);
                        Some((
                            path.clone(),
                            VaultContext::at_allowed_root(
                                scope.access(),
                                Path::new(path),
                                &allowed,
                            )?,
                        ))
                    }
                    _ => self.saved_source(scope, &source, false).await?,
                };
                let Some((configured, folder)) = resolved else {
                    return Ok(json!({"sourcePath": null}));
                };
                let root = folder
                    .folder_identity()
                    .to_str()
                    .context("Invalid folder identity")?
                    .to_string();
                let mut files = Vec::new();
                walk_files(&folder, "", &root, &mut files, scope)?;
                files.sort();
                ensure!(files.len() <= MAX_ENTRIES, "Notes folder is too large");
                Ok(json!({"sourcePath": configured, "resolvedSourcePath": root, "files": files}))
            })
            .await
            .context("Memory ingest deadline exceeded")?
        })
    }

    fn file(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let source = self.source(scope, r)?.clone_source();
        let input: File = serde_json::from_value(r.parameters.clone())?;
        if input
            .expected_snapshot_key
            .as_deref()
            .is_some_and(|k| !k.is_empty())
        {
            return Ok(json!({"error": "managed publication is not connected"}));
        }
        ensure!(
            input.chunk_limit >= 1 && input.chunk_limit <= 100_000,
            "Invalid chunk limit"
        );
        // Read and embed outside the write transaction, then recheck the file.
        let prepared = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let Some((_, folder)) = self.saved_source(scope, &source, false).await? else {
                    anyhow::bail!("Notes source is not configured");
                };
                let root = folder
                    .folder_identity()
                    .to_str()
                    .context("Invalid folder identity")?
                    .to_string();
                ensure!(input.source_path == root, "Notes source has changed");
                let relative = input
                    .file_path
                    .strip_prefix(&format!("{root}/"))
                    .context("Note file is outside the source")?
                    .to_string();
                ensure!(relative.ends_with(".md"), "Not a Markdown note");
                let _lock = folder.try_lock_folder()?;
                let bytes = folder.read_limited(&relative, MAX_FILE_BYTES)?;
                let content = String::from_utf8(bytes).context("Note is not UTF-8")?;
                anyhow::Ok((root, relative, content))
            })
            .await
            .context("Memory ingest deadline exceeded")?
        })?;
        let (root, relative, content) = prepared;
        let file_hash = sha256(&content);
        let offset = if input.expected_file_hash.as_deref() == Some(file_hash.as_str()) {
            input.chunk_offset
        } else {
            0
        };
        // Unchanged files are skipped before any embedding work.
        let existing = self.runtime.block_on(async {
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
            let row = cx
                .db()
                .query_opt(
                    "SELECT file_hash, embed_model_name FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
                    &[&source.source_kind, &input.file_path],
                )
                .await?;
            cx.commit_bounded(scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
            Ok::<_, anyhow::Error>(row.map(|row| (row.get::<_, String>(0), row.get::<_, String>(1))))
        })?;
        if offset == 0 {
            if let Some((hash, model)) = &existing {
                if *hash == file_hash && *model == self.embeddings.model_name() {
                    return Ok(json!({"status": "skipped", "chunksProcessed": 0}));
                }
            }
        }
        let (links, chunks) = parse_document(&content);
        ensure!(
            (offset as usize) <= chunks.len(),
            "Document ingest checkpoint exceeds current document"
        );
        let end = (offset as usize + input.chunk_limit as usize).min(chunks.len());
        let mut embedded = Vec::new();
        for chunk in &chunks[offset as usize..end] {
            let vector = self.embeddings.embed_document(scope, &chunk.text)?;
            ensure!(
                !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
                "Invalid document embedding"
            );
            embedded.push(vector);
        }
        let processed = embedded.len();
        let actor = scope.access().actor_user_id();
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                let row = cx.db().query_opt(
                    "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id() FOR SHARE",
                    &[&source.preference_key],
                ).await?.context("Notes source is not configured")?;
                let saved: Value = row.get(0);
                let saved = saved.as_str().filter(|s| !s.is_empty()).context("Notes source is not configured")?;
                let roots = source.roots.get(&actor).cloned().unwrap_or_default();
                ensure!(!roots.is_empty(), "Notes roots are not configured");
                let allowed = AllowedRoots::for_account(scope.access(), roots);
                let folder = VaultContext::at_allowed_root(scope.access(), Path::new(saved), &allowed)?;
                ensure!(folder.folder_identity().to_str() == Some(root.as_str()), "Notes source has changed");
                let _lock = folder.try_lock_folder()?;
                let bytes = folder.read_limited(&relative, MAX_FILE_BYTES)?;
                ensure!(sha256(std::str::from_utf8(&bytes).map_err(|_| anyhow::anyhow!("Note is not UTF-8"))?) == file_hash, "Note changed during sync");
                let db = cx.db();
                if offset == 0 {
                    db.execute("DELETE FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&source.source_kind, &input.file_path]).await?;
                }
                for (chunk, vector) in chunks[offset as usize..end].iter().zip(&embedded) {
                    let literal = format!("[{}]", vector.iter().map(f64::to_string).collect::<Vec<_>>().join(","));
                    db.execute(
                        "INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,line_start,line_end,content_hash,text,embedding,embed_model_name,embed_model_version,managed_snapshot) VALUES(app.current_actor_user_id(),$1,$2,$3,$4,$5,$6,$7::text::vector,$8,$9,NULL)",
                        &[&source.source_kind, &input.file_path, &(chunk.line_start as i32), &(chunk.line_end as i32), &sha256(&chunk.text), &sanitize(&chunk.text), &literal, &self.embeddings.model_name(), &self.embeddings.model_version()],
                    ).await?;
                }
                if offset == 0 {
                    db.execute("DELETE FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&source.source_kind, &input.file_path]).await?;
                }
                if end < chunks.len() {
                    cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                    return Ok(json!({"status":"ingested","chunksProcessed":processed,"filePath":input.file_path,"continuation":{"chunkOffset":end,"fileHash":file_hash}}));
                }
                db.execute("DELETE FROM app.memory_links WHERE owner_user_id=app.current_actor_user_id() AND from_path=$1", &[&input.file_path]).await?;
                for link in &links {
                    db.execute("INSERT INTO app.memory_links(owner_user_id,from_path,to_path) VALUES(app.current_actor_user_id(),$1,$2) ON CONFLICT(owner_user_id,from_path,to_path) DO NOTHING", &[&input.file_path, link]).await?;
                }
                db.execute(
                    "INSERT INTO app.memory_file_index(owner_user_id,source_kind,source_path,file_hash,chunk_count,embed_model_name,embed_model_version,managed_snapshot,ingested_at) VALUES(app.current_actor_user_id(),$1,$2,$3,$4,$5,$6,NULL,now()) ON CONFLICT(owner_user_id,source_kind,source_path) DO UPDATE SET file_hash=EXCLUDED.file_hash,chunk_count=EXCLUDED.chunk_count,embed_model_name=EXCLUDED.embed_model_name,embed_model_version=EXCLUDED.embed_model_version,managed_snapshot=NULL,ingested_at=now()",
                    &[&source.source_kind, &input.file_path, &file_hash, &(chunks.len() as i32), &self.embeddings.model_name(), &self.embeddings.model_version()],
                ).await?;
                cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                Ok(json!({"status":"ingested","chunksProcessed":processed}))
            })
            .await
            .context("Memory ingest deadline exceeded")?
        })
    }
}

impl MemoryIngestSource {
    fn clone_source(&self) -> Self {
        Self {
            source_kind: self.source_kind.clone(),
            preference_key: self.preference_key.clone(),
            roots: self.roots.clone(),
        }
    }
}

fn walk_files(
    folder: &VaultContext,
    directory: &str,
    root: &str,
    files: &mut Vec<String>,
    scope: &CallScope,
) -> Result<()> {
    ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
    ensure!(files.len() <= MAX_ENTRIES, "Notes folder is too large");
    for entry in folder.list_limited(directory, MAX_ENTRIES)? {
        let relative = if directory.is_empty() {
            entry.name.clone()
        } else {
            format!("{directory}/{}", entry.name)
        };
        match entry.kind {
            EntryKind::Dir => walk_files(folder, &relative, root, files, scope)?,
            EntryKind::File if relative.ends_with(".md") => {
                files.push(format!("{root}/{relative}"));
            }
            _ => {}
        }
    }
    Ok(())
}

impl Ports for MemoryIngestPorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "vault" && r.operation == "index.sync-open" {
            return match self.open(scope, r) {
                Ok(value) => Ok(value),
                Err(error) => Ok(json!({"error": error_code(&error)})),
            };
        }
        if port == "vault" && r.operation == "index.sync-file" {
            return match self.file(scope, r) {
                Ok(value) => Ok(value),
                Err(error) => Ok(json!({"error": error_code(&error)})),
            };
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[cfg(test)]
mod tests {
    use super::parse_document;

    #[test]
    fn parser_matches_legacy_boundaries() {
        let (links, chunks) = parse_document("---\ntitle: T\n---\n# Head\n\nSee [[Other Note|label]] and [[Plain]].\n\n## Two\n\nBody two.\n");
        assert_eq!(links, vec!["Other Note", "Plain"]);
        assert!(chunks.iter().all(|c| !c.text.is_empty()));
        assert!(chunks.iter().any(|c| c.text.contains("Body two.")));
        // Line numbers count the frontmatter lines, as the legacy parser does.
        assert!(chunks[0].line_start >= 3);
        let long = "word ".repeat(600);
        let (_, chunks) = parse_document(&long);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.text.chars().count() <= 2000));
        let (_, empty) = parse_document("---\ntitle: T\n---\n");
        assert!(empty.is_empty());
    }
}

fn error_code(error: &anyhow::Error) -> &'static str {
    let text = format!("{error:#}");
    if text.contains("no longer exists")
        || text.contains("No such file")
        || text.contains("not found")
    {
        "ENOENT"
    } else if text.contains("outside") || text.contains("Outside") || text.contains("not within") {
        "OUTSIDE"
    } else if text.contains("Permission denied") {
        "EACCES"
    } else {
        "failed"
    }
}
