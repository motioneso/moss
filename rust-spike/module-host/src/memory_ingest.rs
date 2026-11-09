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

/// JavaScript trim also removes the byte-order mark, and keeps U+0085,
/// which Rust treats as whitespace. Match the JavaScript set.
fn trim_js(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Port of the legacy document parser. Its size budget counts UTF-16 units,
/// matching the JavaScript string length the original code used.
fn parse_document(content: &str) -> (Vec<String>, Vec<Chunk>) {
    let body = match frontmatter_end(content) {
        Some((_, end)) => &content[end..],
        None => content,
    };
    // Match the legacy wiki-link pattern, including its retry at the next
    // character after a failed match at an opening bracket pair.
    let mut links = Vec::new();
    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i].1 == '[' && chars[i + 1].1 == '[' {
            let mut j = i + 2;
            let mut target = String::new();
            while j < chars.len() && chars[j].1 != ']' && chars[j].1 != '|' {
                target.push(chars[j].1);
                j += 1;
            }
            let matched = if !target.is_empty() && j < chars.len() && chars[j].1 == '|' {
                let mut k = j + 1;
                while k < chars.len() && chars[k].1 != ']' {
                    k += 1;
                }
                // The legacy pattern needs at least one character after the bar.
                k > j + 1 && k + 1 < chars.len() && chars[k].1 == ']' && chars[k + 1].1 == ']'
            } else {
                !target.is_empty()
                    && j + 1 < chars.len()
                    && chars[j].1 == ']'
                    && chars[j + 1].1 == ']'
            };
            if matched {
                links.push(trim_js(&target).to_string());
                // Continue after the closing brackets.
                let mut k = i + 2;
                while k + 1 < chars.len() && !(chars[k].1 == ']' && chars[k + 1].1 == ']') {
                    k += 1;
                }
                i = k + 2;
                continue;
            }
        }
        i += 1;
    }
    let trimmed = trim_js(body);
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
        .filter(|s| !trim_js(s).is_empty())
        .collect();
    let mut running = count_lines(content) - count_lines(body);
    let mut chunks = Vec::new();
    for section in sections {
        let mut offset = 0i64;
        for part in cap_chunk_size(section) {
            let newlines = count_newlines(&part);
            let text = trim_js(&part);
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
    // The legacy pattern closes at the first line-start fence. Its trailing
    // newline is optional, so any text after the fence starts the body.
    {
        let idx = rest.find("\n---")?;
        // The fence may be preceded by a carriage return as part of the
        // frontmatter line ending, which the legacy capture excludes.
        let fm_end = if idx > 0 && rest.as_bytes()[idx - 1] == b'\r' {
            idx - 1
        } else {
            idx
        };
        let fm = &rest[..fm_end];
        let after = &rest[idx + 4..];
        if let Some(tail) = after.strip_prefix("\r\n") {
            return Some((fm, content.len() - tail.len()));
        }
        if let Some(tail) = after.strip_prefix('\n') {
            return Some((fm, content.len() - tail.len()));
        }
        // The legacy trailing pattern also swallows a lone carriage return.
        if let Some(tail) = after.strip_prefix('\r') {
            return Some((fm, content.len() - tail.len()));
        }
        Some((fm, content.len() - after.len()))
    }
}

fn split_after_blank(text: &str) -> Vec<String> {
    // Every position whose prefix ends with a newline, optional spaces or
    // tabs, and a newline is a split point, including overlapping ones.
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    for p in 1..=bytes.len() {
        if bytes[p - 1] != b'\n' {
            continue;
        }
        let mut j = p - 1;
        while j > 0 && (bytes[j - 1] == b' ' || bytes[j - 1] == b'\t') {
            j -= 1;
        }
        if j > 0 && bytes[j - 1] == b'\n' {
            parts.push(text[start..p].to_string());
            start = p;
        }
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
    ) -> Result<Option<(String, VaultContext)>> {
        let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
            .await
            .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
        let row = cx
            .db()
            .query_opt(
                "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id()",
                &[&source.preference_key],
            )
            .await?;
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
        // Commit the read so the pooled connection returns to the pool
        // instead of being discarded when this context drops.
        cx.commit_bounded(scope.remaining())
            .await
            .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
        Ok(Some((saved, folder)))
    }

    fn open(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let source = self.source(scope, r)?.clone_source();
        let input: Open = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                // The saved folder is the only source this adapter ingests.
                // A coordinator override must name that same folder, so a
                // mismatched request fails here instead of failing every file.
                let resolved = self.saved_source(scope, &source).await?;
                let Some((configured, folder)) = resolved else {
                    if input.source_path.as_deref().is_some_and(|p| !p.is_empty()) {
                        anyhow::bail!("Note source is outside the saved folder");
                    }
                    return Ok(json!({"sourcePath": null}));
                };
                if let Some(path) = input.source_path.as_deref().filter(|p| !p.is_empty()) {
                    let roots = source
                        .roots
                        .get(&scope.access().actor_user_id())
                        .cloned()
                        .unwrap_or_default();
                    ensure!(!roots.is_empty(), "Notes roots are not configured");
                    let allowed = AllowedRoots::for_account(scope.access(), roots);
                    let requested =
                        VaultContext::at_allowed_root(scope.access(), Path::new(path), &allowed)?;
                    ensure!(
                        requested.folder_identity() == folder.folder_identity(),
                        "Note source is outside the saved folder"
                    );
                }
                let root = folder
                    .folder_identity()
                    .to_str()
                    .context("Invalid folder identity")?
                    .to_string();
                let mut files = Vec::new();
                walk_files(&folder, "", &root, &mut files, scope, &mut 0)?;
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
                let Some((_, folder)) = self.saved_source(scope, &source).await? else {
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
                    "SELECT file_hash, embed_model_name, managed_snapshot FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
                    &[&source.source_kind, &input.file_path],
                )
                .await?;
            cx.commit_bounded(scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
            Ok::<_, anyhow::Error>(row.map(|row| {
                (
                    row.get::<_, String>(0),
                    row.get::<_, String>(1),
                    row.get::<_, Option<Value>>(2),
                )
            }))
        })?;
        if offset == 0 {
            if let Some((hash, model, snapshot)) = &existing {
                // Legacy also requires the saved snapshot key to match the
                // current one, which is always none here. A managed row is
                // therefore read again instead of skipped.
                if *hash == file_hash
                    && *model == self.embeddings.model_name()
                    && snapshot.is_none()
                {
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
            ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
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
    visited: &mut usize,
) -> Result<()> {
    ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
    ensure!(files.len() <= MAX_ENTRIES, "Notes folder is too large");
    for entry in folder.list_limited(directory, MAX_ENTRIES)? {
        *visited += 1;
        ensure!(*visited <= MAX_ENTRIES, "Notes folder is too large");
        let relative = if directory.is_empty() {
            entry.name.clone()
        } else {
            format!("{directory}/{}", entry.name)
        };
        match entry.kind {
            EntryKind::Dir => walk_files(folder, &relative, root, files, scope, visited)?,
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
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks[0].text,
            "# Head\n\nSee [[Other Note|label]] and [[Plain]]."
        );
        assert_eq!((chunks[0].line_start, chunks[0].line_end), (3, 7));
        assert_eq!(chunks[1].text, "## Two\n\nBody two.");
        assert_eq!((chunks[1].line_start, chunks[1].line_end), (8, 10));
        // Failed matches retry at the next character, as the legacy pattern does.
        let (links, _) = parse_document("[[]] [[|x]] [[a|b]c]] [[a|]] [[x] text [[y]]");
        assert_eq!(links, vec!["y"]);
        // A byte-order mark is trimmed the way JavaScript trim trims it.
        let (_, chunks) = parse_document("\u{feff}# Hi\n\nText.\n");
        assert_eq!(chunks[0].text, "# Hi\n\nText.");
        // Text after a closing fence on the same line starts the body.
        let (_, chunks) = parse_document("---\na: 1\n---foo\nBody.\n");
        assert_eq!(chunks[0].text, "foo\nBody.");
        let long = "word ".repeat(600);
        let (_, chunks) = parse_document(&long);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| super::utf16_len(&c.text) <= 2000));
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
