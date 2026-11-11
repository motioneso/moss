//! Core-owned indexing of an account's private vault. The guest chooses no account, source
//! kind, folder, model or table. It names a vault-relative path at most, and the host decides
//! whether that path may be indexed. Only metadata and counts come back, never note text.
use crate::memory_ingest::{
    error_code, parse_document, sanitize, sha256, DocumentEmbeddings, MAX_ENTRIES, MAX_FILE_BYTES,
};
use crate::memory_snapshot::{self as snapshot, Snapshot, Source};
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::Arc,
};
use uuid::Uuid;
use vault::{AllowedRoots, EntryKind, VaultContext};

const SOURCE_KIND: &str = "vault";

/// A root under one of these can never become ingestable, whatever a provider returns.
pub const HARD_EXCLUDED_PREFIXES: [&str; 2] = ["attachments/", "exports/"];

pub struct MemoryVaultPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embeddings: Arc<dyn DocumentEmbeddings>,
    key: (String, String),
    base: PathBuf,
    fixed_roots: Vec<String>,
    preference_roots: Vec<String>,
    next: Arc<dyn Ports>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInput {
    path: String,
    chunk_limit: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathInput {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Debug, PartialEq, Eq)]
enum Norm {
    Escape,
    Empty,
    Path(String),
}

/// Collapses `.` and `..` the way `path.posix.normalize` does and refuses any escape.
fn normalize(raw: &str) -> Norm {
    let trimmed = raw.trim_start_matches('/');
    let dir = !trimmed.ends_with(".md");
    let mut parts: Vec<&str> = Vec::new();
    for part in trimmed.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Norm::Escape;
                }
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Norm::Empty;
    }
    let mut joined = parts.join("/");
    if dir {
        joined.push('/');
    }
    Norm::Path(joined)
}

fn hard_excluded(path: &str) -> bool {
    HARD_EXCLUDED_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// True only for `.md` under a resolved root and not under a hard-excluded prefix.
pub(crate) fn is_path_ingestable(path: &str, roots: &[String]) -> bool {
    let Norm::Path(path) = normalize(path) else {
        return false;
    };
    if path.ends_with('/') || !path.ends_with(".md") || hard_excluded(&path) {
        return false;
    }
    roots.iter().any(|root| match normalize(root) {
        Norm::Path(root) if root.ends_with(".md") => path == root,
        Norm::Path(root) => path.starts_with(&root),
        _ => false,
    })
}

/// Fails loudly on a root that escapes the vault or sits under a hard-excluded prefix.
fn checked_roots(candidates: Vec<String>) -> Result<Vec<String>> {
    let mut roots = Vec::new();
    for candidate in candidates {
        match normalize(&candidate) {
            Norm::Escape => anyhow::bail!("An ingest root escapes the vault"),
            Norm::Empty => {}
            Norm::Path(path) => {
                ensure!(
                    !hard_excluded(&path),
                    "An ingest root is under a hard-excluded folder"
                );
                roots.push(path);
            }
        }
    }
    Ok(roots)
}

impl MemoryVaultPorts {
    /// `fixed_roots` are vault-relative folders every account indexes. `preference_roots` name
    /// account preferences whose saved value is a vault-relative folder; absolute values give
    /// nothing, because the linked notes sweep already covers them.
    pub fn new(
        database: Database,
        embeddings: Arc<dyn DocumentEmbeddings>,
        key: (String, String),
        base: PathBuf,
        fixed_roots: Vec<String>,
        preference_roots: Vec<String>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            embeddings,
            key,
            base,
            fixed_roots,
            preference_roots,
            next,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })
    }

    fn authorize(&self, scope: &CallScope, r: &Request) -> Result<()> {
        crate::runtime::authorize(scope.module(), "vault", r)?;
        ensure!(
            (scope.module().id.clone(), r.resource.clone()) == self.key,
            "Memory vault source is not connected"
        );
        Ok(())
    }

    fn folder(&self, scope: &CallScope) -> Result<VaultContext> {
        let roots =
            crate::account_preferences::account_base_root(&self.base, scope.access().actor_user_id())?;
        let allowed = AllowedRoots::for_account(scope.access(), roots.clone());
        let root = roots.first().context("The private vault is unavailable")?;
        Ok(VaultContext::at_allowed_root(scope.access(), root, &allowed)?)
    }

    async fn open(&self, scope: &CallScope) -> Result<DataContext> {
        DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
            .await
            .map_err(|_| anyhow::anyhow!("Memory data unavailable"))
    }

    async fn commit(&self, cx: DataContext, scope: &CallScope) -> Result<()> {
        cx.commit_bounded(scope.remaining())
            .await
            .map_err(|_| anyhow::anyhow!("Memory commit failed"))
    }

    async fn roots(&self, scope: &CallScope) -> Result<Vec<String>> {
        let mut candidates = self.fixed_roots.clone();
        if !self.preference_roots.is_empty() {
            let cx = self.open(scope).await?;
            let rows = cx
                .db()
                .query(
                    "SELECT value_json FROM app.preferences WHERE key = ANY($1::text[]) AND owner_user_id=app.current_actor_user_id()",
                    &[&self.preference_roots],
                )
                .await?;
            for row in rows {
                let value: Value = row.get(0);
                if let Some(saved) = value.as_str().filter(|s| !s.is_empty() && !s.starts_with('/')) {
                    candidates.push(saved.to_owned());
                }
            }
            self.commit(cx, scope).await?;
        }
        checked_roots(candidates)
    }

    /// Every ingestable note under the account's roots, relative to the vault.
    fn walk(&self, scope: &CallScope, folder: &VaultContext, roots: &[String]) -> Result<Vec<String>> {
        let mut files = BTreeSet::new();
        for root in roots {
            if root.ends_with(".md") {
                files.insert(root.clone());
            } else {
                walk_dir(folder, root.trim_end_matches('/'), &mut files, scope, &mut 0)?;
            }
        }
        ensure!(files.len() <= MAX_ENTRIES, "The vault is too large");
        Ok(files
            .into_iter()
            .filter(|path| is_path_ingestable(path, roots))
            .collect())
    }

    fn list(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        self.authorize(scope, r)?;
        let _: Empty = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let roots = self.roots(scope).await?;
                let folder = self.folder(scope)?;
                let files = self.walk(scope, &folder, &roots)?;
                Ok(json!({"files": files}))
            })
            .await
            .context("Memory vault deadline exceeded")?
        })
    }

    fn purge(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        self.authorize(scope, r)?;
        let _: Empty = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let roots = self.roots(scope).await?;
                let folder = self.folder(scope)?;
                let allowed: BTreeSet<String> = self.walk(scope, &folder, &roots)?.into_iter().collect();
                let cx = self.open(scope).await?;
                let db = cx.db();
                let rows = db
                    .query(
                        "SELECT source_path FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 UNION SELECT source_path FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1",
                        &[&SOURCE_KIND],
                    )
                    .await?;
                let mut purged = 0;
                for row in rows {
                    let path: String = row.get(0);
                    if allowed.contains(&path) {
                        continue;
                    }
                    delete_rows(db, &path).await?;
                    purged += 1;
                }
                self.commit(cx, scope).await?;
                Ok(json!({"purged": purged}))
            })
            .await
            .context("Memory vault deadline exceeded")?
        })
    }

    /// Deletes a note's index rows when the note is gone or no longer ingestable.
    fn remove(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        self.authorize(scope, r)?;
        let input: PathInput = serde_json::from_value(r.parameters.clone())?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let roots = self.roots(scope).await?;
                let folder = self.folder(scope)?;
                let keep = is_path_ingestable(&input.path, &roots)
                    && !folder_missing(&folder, &input.path);
                if keep {
                    return Ok(json!({"removed": false}));
                }
                let cx = self.open(scope).await?;
                delete_rows(cx.db(), &input.path).await?;
                self.commit(cx, scope).await?;
                Ok(json!({"removed": true}))
            })
            .await
            .context("Memory vault deadline exceeded")?
        })
    }

    fn file(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        self.authorize(scope, r)?;
        let input: FileInput = serde_json::from_value(r.parameters.clone())?;
        ensure!(
            input.chunk_limit >= 1 && input.chunk_limit <= 100_000,
            "Invalid chunk limit"
        );
        let actor = scope.access().actor_user_id();
        let path = input.path.clone();
        let skipped = || Ok(json!({"status": "skipped", "chunksProcessed": 0}));
        // Read, label and embed before the write transaction.
        let prepared = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let roots = self.roots(scope).await?;
                if !is_path_ingestable(&path, &roots) {
                    return Ok(None);
                }
                let folder = self.folder(scope)?;
                let content = read_note(&folder, &path)?;
                let cx = self.open(scope).await?;
                let captured = capture(cx.db(), actor, &folder, &path, &content, false).await?;
                let Some(snap) = captured else {
                    self.commit(cx, scope).await?;
                    return Ok(None);
                };
                let (model_name, model_version) = self.embeddings.model(scope)?;
                let existing = cx
                    .db()
                    .query_opt(
                        "SELECT file_hash, embed_model_name, managed_snapshot->>'key' FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
                        &[&SOURCE_KIND, &path],
                    )
                    .await?;
                if let Some(row) = existing {
                    if row.get::<_, String>(0) == sha256(&content)
                        && row.get::<_, String>(1) == model_name
                        && row.get::<_, Option<String>>(2).as_deref() == Some(snap.key.as_str())
                    {
                        self.commit(cx, scope).await?;
                        return Ok(None);
                    }
                }
                let offset = progress(cx.db(), &path, &snap.key, &model_name, &model_version).await?;
                self.commit(cx, scope).await?;
                anyhow::Ok(Some((content, snap, model_name, model_version, offset)))
            })
            .await
            .context("Memory vault deadline exceeded")?
        })?;
        let Some((content, snap, model_name, model_version, found)) = prepared else {
            return skipped();
        };
        let (links, chunks) = parse_document(&content);
        let offset = match found {
            Some(count) if count <= chunks.len() => count,
            _ => 0,
        };
        let end = (offset + input.chunk_limit as usize).min(chunks.len());
        let mut embedded = Vec::new();
        for chunk in &chunks[offset..end] {
            ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
            let vector = self.embeddings.embed_document(scope, &chunk.text)?;
            ensure!(
                !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
                "Invalid document embedding"
            );
            embedded.push(vector);
        }
        ensure!(
            self.embeddings.model(scope)? == (model_name.clone(), model_version.clone()),
            "The embedding model changed during indexing"
        );
        let file_hash = sha256(&content);
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let folder = self.folder(scope)?;
                let _lock = folder.try_lock_folder()?;
                let current = read_note(&folder, &path)?;
                let cx = self.open(scope).await?;
                let db = cx.db();
                // The label is read again under shared locks. A changed note or label means
                // someone else owns the next version, so nothing is published.
                let Some(fresh) = capture(db, actor, &folder, &path, &current, true).await? else {
                    return Ok(json!({"status": "skipped", "chunksProcessed": 0}));
                };
                if fresh.key != snap.key {
                    return Ok(json!({"status": "skipped", "chunksProcessed": 0}));
                }
                if snap.side.is_none() && managed_rows_exist(db, &path).await? {
                    return Ok(json!({"status": "skipped", "chunksProcessed": 0}));
                }
                let now = progress(db, &path, &snap.key, &model_name, &model_version).await?;
                if now.unwrap_or(0) != offset {
                    return Ok(match now {
                        Some(count) if count == chunks.len() => {
                            json!({"status": "skipped", "chunksProcessed": 0})
                        }
                        _ => json!({"status": "ingested", "chunksProcessed": 0, "continuation": true}),
                    });
                }
                let stored = snap.json();
                if offset == 0 {
                    db.execute("DELETE FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&SOURCE_KIND, &path]).await?;
                }
                for (chunk, vector) in chunks[offset..end].iter().zip(&embedded) {
                    let literal = format!("[{}]", vector.iter().map(f64::to_string).collect::<Vec<_>>().join(","));
                    db.execute(
                        "INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,line_start,line_end,content_hash,text,embedding,embed_model_name,embed_model_version,managed_snapshot) VALUES(app.current_actor_user_id(),$1,$2,$3,$4,$5,$6,$7::text::vector,$8,$9,$10)",
                        &[&SOURCE_KIND, &path, &(chunk.line_start as i32), &(chunk.line_end as i32), &sha256(&chunk.text), &sanitize(&chunk.text), &literal, &model_name, &model_version, &stored],
                    ).await?;
                }
                if offset == 0 {
                    db.execute("DELETE FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2", &[&SOURCE_KIND, &path]).await?;
                }
                if end < chunks.len() {
                    self.commit(cx, scope).await?;
                    return Ok(json!({"status": "ingested", "chunksProcessed": embedded.len(), "continuation": true}));
                }
                db.execute("DELETE FROM app.memory_links WHERE owner_user_id=app.current_actor_user_id() AND from_path=$1", &[&path]).await?;
                for link in &links {
                    db.execute("INSERT INTO app.memory_links(owner_user_id,from_path,to_path) VALUES(app.current_actor_user_id(),$1,$2) ON CONFLICT(owner_user_id,from_path,to_path) DO NOTHING", &[&path, link]).await?;
                }
                ensure!(sha256(&current) == file_hash, "Note changed during indexing");
                db.execute(
                    "INSERT INTO app.memory_file_index(owner_user_id,source_kind,source_path,file_hash,chunk_count,embed_model_name,embed_model_version,managed_snapshot,ingested_at) VALUES(app.current_actor_user_id(),$1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(owner_user_id,source_kind,source_path) DO UPDATE SET file_hash=EXCLUDED.file_hash,chunk_count=EXCLUDED.chunk_count,embed_model_name=EXCLUDED.embed_model_name,embed_model_version=EXCLUDED.embed_model_version,managed_snapshot=EXCLUDED.managed_snapshot,ingested_at=now()",
                    &[&SOURCE_KIND, &path, &file_hash, &(chunks.len() as i32), &model_name, &model_version, &stored],
                ).await?;
                self.commit(cx, scope).await?;
                Ok(json!({"status": "ingested", "chunksProcessed": embedded.len()}))
            })
            .await
            .context("Memory vault deadline exceeded")?
        })
    }
}

fn folder_missing(folder: &VaultContext, path: &str) -> bool {
    match folder.list_limited(path.rsplit_once('/').map_or("", |(dir, _)| dir), MAX_ENTRIES) {
        Ok(entries) => {
            let name = path.rsplit('/').next().unwrap_or(path);
            !entries.iter().any(|entry| entry.name == name)
        }
        Err(error) => error_code(&anyhow::Error::new(error)) == "ENOENT",
    }
}

fn read_note(folder: &VaultContext, path: &str) -> Result<String> {
    let bytes = folder.read_limited(path, MAX_FILE_BYTES)?;
    String::from_utf8(bytes).context("Note is not UTF-8")
}

fn walk_dir(
    folder: &VaultContext,
    directory: &str,
    files: &mut BTreeSet<String>,
    scope: &CallScope,
    visited: &mut usize,
) -> Result<()> {
    ensure!(!scope.remaining().is_zero(), "Memory ingest timed out");
    let entries = match folder.list_limited(directory, MAX_ENTRIES) {
        Ok(entries) => entries,
        // A root that does not exist yet simply has nothing to index.
        Err(error) => {
            let error = anyhow::Error::new(error);
            return if error_code(&error) == "ENOENT" { Ok(()) } else { Err(error) };
        }
    };
    for entry in entries {
        *visited += 1;
        ensure!(*visited <= MAX_ENTRIES, "The vault is too large");
        let relative = if directory.is_empty() {
            entry.name.clone()
        } else {
            format!("{directory}/{}", entry.name)
        };
        match entry.kind {
            EntryKind::Dir => walk_dir(folder, &relative, files, scope, visited)?,
            EntryKind::File if relative.ends_with(".md") => {
                files.insert(relative);
            }
            _ => {}
        }
    }
    Ok(())
}

async fn delete_rows(db: &tokio_postgres::Client, path: &str) -> Result<()> {
    for statement in [
        "DELETE FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
        "DELETE FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
    ] {
        db.execute(statement, &[&SOURCE_KIND, &path]).await?;
    }
    db.execute(
        "DELETE FROM app.memory_links WHERE owner_user_id=app.current_actor_user_id() AND from_path=$1",
        &[&path],
    )
    .await?;
    Ok(())
}

async fn managed_rows_exist(db: &tokio_postgres::Client, path: &str) -> Result<bool> {
    Ok(db
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2 AND managed_snapshot->>'side' IS NOT NULL UNION ALL SELECT 1 FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2 AND managed_snapshot->>'side' IS NOT NULL)",
            &[&SOURCE_KIND, &path],
        )
        .await?
        .get(0))
}

/// Chunks already saved for this exact label, or none when any saved chunk differs.
async fn progress(
    db: &tokio_postgres::Client,
    path: &str,
    key: &str,
    model_name: &str,
    model_version: &str,
) -> Result<Option<usize>> {
    let row = db
        .query_one(
            "SELECT count(*)::int, (count(*) FILTER (WHERE managed_snapshot->>'key'=$3 AND embed_model_name=$4 AND embed_model_version=$5))::int FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=$2",
            &[&SOURCE_KIND, &path, &key, &model_name, &model_version],
        )
        .await?;
    let (count, matching): (i32, i32) = (row.get(0), row.get(1));
    Ok((count == matching).then_some(count as usize))
}

/// The note's index label, or none when a managed label blocks indexing right now.
/// With `lock`, every row the label depends on is held shared until commit.
async fn capture(
    db: &tokio_postgres::Client,
    actor: Uuid,
    folder: &VaultContext,
    path: &str,
    content: &str,
    lock: bool,
) -> Result<Option<Snapshot>> {
    let joined = folder.folder_identity().join(path);
    let canonical = std::fs::canonicalize(&joined).unwrap_or(joined);
    let canonical = canonical.to_str().context("Invalid note path")?;
    let destination = snapshot::destination_id(canonical);
    let content_hash = sha256(content);
    let share = if lock { " FOR SHARE" } else { "" };
    let available: bool = db
        .query_one("SELECT app.notes_destination_available($1)", &[&destination])
        .await?
        .get(0);
    if !available {
        return Ok(None);
    }
    let actor_row = db
        .query_opt(
            &format!("SELECT generation::int, state FROM app.notes_managed_actors WHERE owner_user_id=app.current_actor_user_id(){share}"),
            &[],
        )
        .await?;
    let actor_row = actor_row.map(|row| (row.get::<_, i32>(0), row.get::<_, String>(1)));
    if actor_row.as_ref().is_some_and(|(_, state)| state != "active") {
        return Ok(None);
    }
    let binding = db
        .query_opt(
            &format!("SELECT side, revision::int FROM app.notes_destination_bindings WHERE destination_id=$1{share}"),
            &[&destination],
        )
        .await?;
    let Some(binding) = binding else {
        return Ok(Some(snapshot::unmanaged(actor, destination, content_hash)));
    };
    let (side, revision): (String, i32) = (binding.get(0), binding.get(1));
    let Some((actor_generation, _)) = actor_row else {
        return Ok(None);
    };
    let pending: bool = db
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM app.notes_contribution_operations WHERE state IN ('pending','conflict') AND $1=ANY(destination_ids))",
            &[&destination],
        )
        .await?
        .get(0);
    if pending {
        return Ok(None);
    }
    let rows = db
        .query(
            "SELECT c.receipt_id, c.side, c.source_module_id, c.source_id::text, c.source_generation::int, s.generation::int, s.state, c.block_bytes FROM app.notes_recording_contributions c JOIN app.notes_managed_sources s USING (owner_user_id, source_module_id, source_id) WHERE c.destination_id=$1 AND c.state='applied' ORDER BY c.source_module_id, c.source_id, c.receipt_id",
            &[&destination],
        )
        .await?;
    let mut sources: Vec<Source> = Vec::new();
    for row in rows {
        let (receipt, row_side, module, id): (String, String, String, String) =
            (row.get(0), row.get(1), row.get(2), row.get(3));
        let (represented, generation, state, bytes): (i32, i32, String, String) =
            (row.get(4), row.get(5), row.get(6), row.get(7));
        if row_side != side
            || state != "active"
            || represented != generation
            || !snapshot::block_unchanged(content, &receipt, &bytes)
        {
            return Ok(None);
        }
        if !sources.iter().any(|s| s.module == module && s.id == id) {
            sources.push(Source { module, id, generation });
        }
    }
    if lock {
        for source in &sources {
            db.query(
                "SELECT 1 FROM app.notes_managed_sources WHERE owner_user_id=app.current_actor_user_id() AND source_module_id=$1 AND source_id=$2::text::uuid FOR SHARE",
                &[&source.module, &source.id],
            )
            .await?;
        }
    }
    Ok(Some(snapshot::managed(
        actor,
        destination,
        content_hash,
        revision,
        &side,
        actor_generation,
        sources,
    )?))
}

impl Ports for MemoryVaultPorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "vault" {
            let handled = match r.operation.as_str() {
                "index.vault-list" => Some(self.list(scope, r)),
                "index.vault-file" => Some(self.file(scope, r)),
                "index.vault-remove" => Some(self.remove(scope, r)),
                "index.vault-purge" => Some(self.purge(scope, r)),
                _ => None,
            };
            if let Some(result) = handled {
                return match result {
                    Ok(value) => Ok(value),
                    Err(error) => Ok(json!({"error": error_code(&error)})),
                };
            }
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_markdown_under_a_root_is_ingestable() {
        let r = roots(&["notes/generated/"]);
        assert!(is_path_ingestable("notes/generated/a/v1.md", &r));
        assert!(!is_path_ingestable("notes/generated/a/v1.txt", &r));
        assert!(!is_path_ingestable("notes/other/a.md", &r));
        assert!(!is_path_ingestable("notes/generated/../other/a.md", &r));
    }

    #[test]
    fn hard_excluded_folders_never_index() {
        let r = roots(&["attachments", "exports", "notes"]);
        assert!(!is_path_ingestable("attachments/a.md", &r));
        assert!(!is_path_ingestable("exports/a.md", &r));
        assert!(checked_roots(roots(&["attachments"])).is_err());
        assert!(checked_roots(roots(&["exports/deep"])).is_err());
        assert!(checked_roots(roots(&["people/../exports"])).is_err());
    }

    #[test]
    fn escaping_roots_and_paths_are_refused() {
        assert!(checked_roots(roots(&["../outside"])).is_err());
        assert!(checked_roots(roots(&["a/../../b"])).is_err());
        assert!(!is_path_ingestable("../x.md", &roots(&["notes"])));
        assert_eq!(checked_roots(roots(&["people/.."])).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn file_roots_match_exactly() {
        let r = roots(&["people/me.md"]);
        assert!(is_path_ingestable("people/me.md", &r));
        assert!(!is_path_ingestable("people/me.md.md", &r));
    }
}
