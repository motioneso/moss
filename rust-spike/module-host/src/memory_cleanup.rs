//! Core-owned index cleanup. The guest can retain walked paths, but cannot
//! choose an account, source kind, allowed folder, or individual deletion target.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;
use vault::{AllowedRoots, EntryKind, VaultContext};

pub(crate) const MAX_ENTRIES: usize = 10_000;

pub struct MemoryCleanupSource {
    pub source_kind: String,
    pub preference_key: String,
    pub roots: BTreeMap<Uuid, Vec<PathBuf>>,
}

pub struct MemoryCleanupPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    sources: BTreeMap<(String, String), MemoryCleanupSource>,
    next: Arc<dyn Ports>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cleanup {
    source_path: String,
    walked_paths: Vec<String>,
}

impl MemoryCleanupPorts {
    pub fn new(
        database: Database,
        sources: BTreeMap<(String, String), MemoryCleanupSource>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            sources,
            next,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })
    }

    fn cleanup(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), "vault", r)?;
        let source = self
            .sources
            .get(&(scope.module().id.clone(), r.resource.clone()))
            .context("Memory cleanup source is not connected")?;
        let input: Cleanup = serde_json::from_value(r.parameters.clone())?;
        ensure!(
            input.walked_paths.len() <= MAX_ENTRIES && input.source_path.len() <= 4096,
            "Cleanup input is too large"
        );
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining()).await
                    .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                // Keep source changes/unlinking blocked until the entire sweep commits.
                let row = cx.db().query_opt(
                    "SELECT value_json FROM app.preferences WHERE key=$1 AND owner_user_id=app.current_actor_user_id() FOR SHARE",
                    &[&source.preference_key],
                ).await?.context("Notes source is not configured")?;
                let saved: Value = row.get(0);
                let saved = saved.as_str().filter(|s| !s.is_empty()).context("Notes source is not configured")?;
                let roots = source.roots.get(&scope.access().actor_user_id()).cloned().unwrap_or_default();
                ensure!(!roots.is_empty(), "Notes roots are not configured");
                let allowed = AllowedRoots::for_account(scope.access(), roots);
                let folder = VaultContext::at_allowed_root(scope.access(), Path::new(saved), &allowed)?;
                let root = folder.folder_identity().to_str().context("Invalid folder identity")?;
                ensure!(input.source_path == root, "Notes source has changed");
                let _lock = folder.try_lock_folder()?;
                let prefix = format!("{root}/");
                ensure!(input.walked_paths.iter().all(|p| p.len() <= 4096 && p.starts_with(&prefix)), "Invalid walked path");
                // A forged empty/partial guest walk cannot erase extant files. Original
                // walked paths also retain entries that vanished or became unreadable.
                let mut present = walk(&folder, scope)?;
                if present.is_empty() {
                    cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                    return Ok(json!({}));
                }
                present.extend(input.walked_paths);
                let rows = cx.db().query(
                    "SELECT source_path FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND left(source_path,char_length($2::text))=$2 LIMIT 10001 FOR UPDATE",
                    &[&source.source_kind, &prefix],
                ).await?;
                ensure!(rows.len() <= MAX_ENTRIES, "Cleanup index is too large");
                let removed: Vec<String> = rows.iter().map(|row| row.get::<_, String>(0))
                    .filter(|path| !present.contains(path)).collect();
                if !removed.is_empty() {
                    // The explicit owner filters match legacy as well as FORCE RLS.
                    // Any failed delete drops this DataContext and rolls back the sweep.
                    cx.db().execute("DELETE FROM app.memory_chunks WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=ANY($2::text[])", &[&source.source_kind, &removed]).await?;
                    // Links have no source-kind column: legacy removes outgoing links
                    // at the exact deleted Notes path, and retains incoming links.
                    cx.db().execute("DELETE FROM app.memory_links WHERE owner_user_id=app.current_actor_user_id() AND from_path=ANY($1::text[])", &[&removed]).await?;
                    cx.db().execute("DELETE FROM app.memory_file_index WHERE owner_user_id=app.current_actor_user_id() AND source_kind=$1 AND source_path=ANY($2::text[])", &[&source.source_kind, &removed]).await?;
                }
                cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory commit failed"))?;
                Ok(json!({}))
            }).await.context("Memory cleanup deadline exceeded")?
        })
    }
}

pub(crate) fn walk(folder: &VaultContext, scope: &CallScope) -> Result<BTreeSet<String>> {
    let mut directories = vec![String::new()];
    let mut present = BTreeSet::new();
    let mut count = 0;
    while let Some(directory) = directories.pop() {
        ensure!(!scope.remaining().is_zero(), "Memory cleanup timed out");
        let entries = folder.list_limited(&directory, MAX_ENTRIES - count)?;
        count += entries.len();
        for entry in entries {
            let path = if directory.is_empty() {
                entry.name
            } else {
                format!("{directory}/{}", entry.name)
            };
            match entry.kind {
                EntryKind::Dir => directories.push(path),
                EntryKind::File if path.ends_with(".md") => {
                    present.insert(
                        folder
                            .folder_identity()
                            .join(path)
                            .to_str()
                            .context("Invalid note path")?
                            .to_owned(),
                    );
                }
                _ => {} // Like legacy, do not follow symlinks or non-regular entries.
            }
        }
    }
    Ok(present)
}

impl Ports for MemoryCleanupPorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "vault" && r.operation == "index.sync-cleanup" {
            return self
                .cleanup(scope, r)
                .map_err(|_| anyhow::anyhow!("Notes cleanup is unavailable"));
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
