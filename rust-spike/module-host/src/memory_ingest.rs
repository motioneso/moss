//! Core-owned per-file indexing for a linked notes folder. The guest names a file inside
//! the account's selected folder and a chunk window. It cannot choose an account, source
//! kind, folder, model or vector. Managed (snapshot-published) derivatives are never
//! overwritten here; that publication authority is not part of this adapter.
use crate::memory_cleanup::{walk, MemoryCleanupSource};
use crate::memory_parser::parse_document;
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use vault::{AllowedRoots, VaultContext};

const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CHUNK_WINDOW: i64 = 1000;

/// Embeds note chunks with the account's configured document model. The guest never
/// supplies a vector, and the model identity comes from the same trusted service.
pub trait DocumentEmbeddings: Send + Sync {
    fn model(&self, scope: &CallScope) -> Result<(String, String)>;
    fn embed_document(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>>;
}

pub struct MemoryIngestPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embeddings: Arc<dyn DocumentEmbeddings>,
    sources: BTreeMap<(String, String), MemoryCleanupSource>,
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
    chunk_offset: i64,
    chunk_limit: i64,
    expected_file_hash: Option<String>,
    expected_snapshot_key: Option<String>,
}

fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(*c as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f))
        .collect()
}

fn vector_literal(vector: &[f64]) -> Result<String> {
    ensure!(
        !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
        "Invalid document embedding"
    );
    Ok(format!(
        "[{}]",
        vector
            .iter()
            .map(f64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

impl MemoryIngestPorts {
    pub fn new(
        database: Database,
        embeddings: Arc<dyn DocumentEmbeddings>,
        sources: BTreeMap<(String, String), MemoryCleanupSource>,
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

    fn source(&self, scope: &CallScope, r: &Request) -> Result<&MemoryCleanupSource> {
        crate::runtime::authorize(scope.module(), "vault", r)?;
        self.sources
            .get(&(scope.module().id.clone(), r.resource.clone()))
            .context("Memory source is not connected")
    }

    async fn folder(
        &self,
        scope: &CallScope,
        source: &MemoryCleanupSource,
        cx: &DataContext,
    ) -> Result<Option<VaultContext>> {
        let row = cx.db().query_opt(
            "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id() FOR SHARE",
            &[&source.preference_key],
        ).await?;
        let saved: Option<Value> = row.map(|r| r.get(0));
        let Some(saved) = saved
            .as_ref()
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        let roots = source
            .roots
            .get(&scope.access().actor_user_id())
            .cloned()
            .unwrap_or_default();
        ensure!(!roots.is_empty(), "Notes roots are not configured");
        let allowed = AllowedRoots::for_account(scope.access(), roots);
        Ok(Some(VaultContext::at_allowed_root(
            scope.access(),
            Path::new(saved),
            &allowed,
        )?))
    }

    fn open(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let source = self.source(scope, r)?;
        let input: Open = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx =
                    DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                        .await
                        .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                let Some(folder) = self.folder(scope, source, &cx).await? else {
                    cx.commit_bounded(scope.remaining())
                        .await
                        .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                    return Ok(json!({"sourcePath": null}));
                };
                let saved = row_saved(&cx, source).await?;
                if let Some(requested) = &input.source_path {
                    ensure!(*requested == saved, "Notes source has changed");
                }
                let root = folder
                    .folder_identity()
                    .to_str()
                    .context("Invalid folder identity")?
                    .to_owned();
                let files: Vec<String> = walk(&folder, scope)?.into_iter().collect();
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                Ok(json!({"sourcePath": saved, "resolvedSourcePath": root, "files": files}))
            })
            .await
            .context("Memory open deadline exceeded")?
        })
    }

    fn file(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        let source = self.source(scope, r)?;
        let input: File = serde_json::from_value(r.parameters.clone())?;
        ensure!(
            input.chunk_offset >= 0
                && (1..=MAX_CHUNK_WINDOW).contains(&input.chunk_limit)
                && input.file_path.len() <= 4096
                && input.source_path.len() <= 4096,
            "Invalid document ingest checkpoint"
        );
        let (model_name, model_version) = self.embeddings.model(scope)?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining()).await
                    .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                let folder = self.folder(scope, source, &cx).await?.context("Notes source is not configured")?;
                let root = folder.folder_identity().to_str().context("Invalid folder identity")?.to_owned();
                ensure!(input.source_path == root, "Notes source has changed");
                let _lock = folder.try_lock_folder()?;
                let relative = input.file_path.strip_prefix(&format!("{root}/")).context("Invalid note path")?;
                ensure!(
                    relative.ends_with(".md") && relative.split('/').all(|s| !s.is_empty() && s != "." && s != ".."),
                    "Invalid note path"
                );
                let bytes = folder.read_limited(relative, MAX_FILE_BYTES)?;
                let content = String::from_utf8_lossy(&bytes).into_owned();
                let file_hash = hex(&Sha256::digest(content.as_bytes()));
                // A checkpoint applies only to the same bytes, and a managed snapshot never matches.
                let mut offset = if input.expected_file_hash.as_deref() == Some(file_hash.as_str())
                    && input.expected_snapshot_key.is_none()
                { input.chunk_offset } else { 0 } as usize;
                let existing = cx.db().query_opt(
                    "SELECT file_hash, embed_model_name, managed_snapshot IS NULL FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2 FOR UPDATE",
                    &[&source.source_kind, &input.file_path],
                ).await?;
                if offset == 0 {
                    if let Some(row) = &existing {
                        if row.get::<_, String>(0) == file_hash && row.get::<_, String>(1) == model_name && row.get::<_, bool>(2) {
                            cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                            return Ok(json!({"status":"skipped","chunksProcessed":0}));
                        }
                    }
                }
                let managed: bool = cx.db().query_one(
                    "SELECT EXISTS (SELECT 1 FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2 AND managed_snapshot->>'side' IS NOT NULL) OR EXISTS (SELECT 1 FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2 AND managed_snapshot->>'side' IS NOT NULL)",
                    &[&source.source_kind, &input.file_path],
                ).await?.get(0);
                ensure!(!managed, "Managed derivatives require current snapshot publication authority");
                let parsed = parse_document(&content);
                ensure!(offset <= parsed.chunks.len(), "Document ingest checkpoint exceeds current document");
                let end = (offset + input.chunk_limit as usize).min(parsed.chunks.len());
                let mut embedded = Vec::new();
                for chunk in &parsed.chunks[offset..end] {
                    ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
                    embedded.push(vector_literal(&self.embeddings.embed_document(scope, &chunk.text)?)?);
                }
                if offset == 0 {
                    cx.db().execute("DELETE FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&source.source_kind, &input.file_path]).await?;
                }
                for (chunk, vector) in parsed.chunks[offset..end].iter().zip(&embedded) {
                    let hash = hex(&Sha256::digest(chunk.text.as_bytes()));
                    cx.db().execute(
                        "INSERT INTO app.memory_chunks (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text, embedding, embed_model_name, embed_model_version, managed_snapshot) VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7::text::vector, $8, $9, NULL)",
                        &[&source.source_kind, &input.file_path, &(chunk.line_start as i32), &(chunk.line_end as i32), &hash, &sanitize(&chunk.text), vector, &model_name, &model_version],
                    ).await?;
                }
                if offset == 0 {
                    cx.db().execute("DELETE FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&source.source_kind, &input.file_path]).await?;
                }
                let processed = embedded.len();
                offset = end;
                if offset < parsed.chunks.len() {
                    cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                    return Ok(json!({"status":"ingested","chunksProcessed":processed,"continuation":{"chunkOffset":offset,"fileHash":file_hash}}));
                }
                cx.db().execute("DELETE FROM app.memory_links WHERE owner_user_id=app.current_actor_user_id() AND from_path=$1", &[&input.file_path]).await?;
                for link in &parsed.wikilinks {
                    cx.db().execute(
                        "INSERT INTO app.memory_links (owner_user_id, from_path, to_path) VALUES (app.current_actor_user_id(), $1, $2) ON CONFLICT (owner_user_id, from_path, to_path) DO NOTHING",
                        &[&input.file_path, link],
                    ).await?;
                }
                cx.db().execute(
                    "INSERT INTO app.memory_file_index (owner_user_id, source_kind, source_path, file_hash, chunk_count, embed_model_name, embed_model_version, managed_snapshot, ingested_at) VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, NULL, now()) ON CONFLICT (owner_user_id, source_kind, source_path) DO UPDATE SET file_hash=EXCLUDED.file_hash, chunk_count=EXCLUDED.chunk_count, embed_model_name=EXCLUDED.embed_model_name, embed_model_version=EXCLUDED.embed_model_version, managed_snapshot=EXCLUDED.managed_snapshot, ingested_at=now()",
                    &[&source.source_kind, &input.file_path, &file_hash, &(parsed.chunks.len() as i32), &model_name, &model_version],
                ).await?;
                cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                Ok(json!({"status":"ingested","chunksProcessed":processed}))
            }).await.context("Memory ingest deadline exceeded")?
        })
    }
}

async fn row_saved(cx: &DataContext, source: &MemoryCleanupSource) -> Result<String> {
    let row = cx.db().query_one(
        "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id()",
        &[&source.preference_key],
    ).await?;
    let value: Value = row.get(0);
    Ok(value
        .as_str()
        .context("Notes source is not configured")?
        .to_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Ports for MemoryIngestPorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "vault" && r.operation == "index.sync-open" {
            return self
                .open(scope, r)
                .map_err(|_| anyhow::anyhow!("Notes sync is unavailable"));
        }
        if port == "vault" && r.operation == "index.sync-file" {
            return self
                .file(scope, r)
                .map_err(|_| anyhow::anyhow!("Notes sync is unavailable"));
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
