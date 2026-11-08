//! Generic chosen-folder adapter. Trusted host configuration selects resources and account roots.
//! Files publish immediately; failed calls compensate only while their exact published bytes remain.
use crate::runtime::{CallScope, Ports, Request};
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;
use vault::{AllowedRoots, FolderLock, VaultContext};

const FILE_BYTES: usize = 256 * 1024;
const CALL_BYTES: usize = 4 * 1024 * 1024;
const FILES: usize = 32;

/// A configured folder is absent, invalid or outside the account's allowed roots.
/// Backend/lock/content failures must not be converted to this availability result.
#[derive(Debug)]
pub struct LinkedFolderUnavailable;
impl std::fmt::Display for LinkedFolderUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The linked notes folder is unavailable")
    }
}
impl std::error::Error for LinkedFolderUnavailable {}

pub struct LinkedFolder {
    actor: Uuid,
    identity: PathBuf,
    vault: VaultContext,
}
impl LinkedFolder {
    pub fn open(access: &AccessContext, selected: &Path, allowed: &AllowedRoots) -> Result<Self> {
        let vault = VaultContext::at_allowed_root(access, selected, allowed)
            .map_err(|_| LinkedFolderUnavailable)?;
        Ok(Self {
            actor: access.actor_user_id(),
            identity: vault.folder_identity().into(),
            vault,
        })
    }
}
/// Only trusted server code implements this. Guest parameters never choose a folder or account.
pub trait FolderProvider: Send + Sync {
    fn resolve(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        budget: Duration,
    ) -> Result<LinkedFolder>;
}

#[derive(Clone)]
pub struct PreferenceFolder {
    pub preference: String,
    /// Legacy relative settings resolve against this account's other folder preference.
    pub relative_to: Option<String>,
}
pub struct PreferenceFolders {
    database: safety_core::db::Database,
    runtime: tokio::runtime::Runtime,
    resources: BTreeMap<(String, String), PreferenceFolder>,
    roots: BTreeMap<Uuid, AllowedRoots>,
}
impl PreferenceFolders {
    pub fn new(
        database: safety_core::db::Database,
        resources: BTreeMap<(String, String), PreferenceFolder>,
        roots: BTreeMap<Uuid, AllowedRoots>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            resources,
            roots,
        })
    }
}
impl FolderProvider for PreferenceFolders {
    fn resolve(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        budget: Duration,
    ) -> Result<LinkedFolder> {
        let started = Instant::now();
        ensure!(!budget.is_zero(), "The linked notes lookup timed out");
        let config = self
            .resources
            .get(&(module.into(), resource.into()))
            .context("This notes resource is not connected")?;
        let roots = self
            .roots
            .get(&access.actor_user_id())
            .context("No notes roots are allowed for this account")?;
        let paths = self.runtime.block_on(async {
            tokio::time::timeout(budget.saturating_sub(started.elapsed()), async {
                let context = safety_core::db::DataContext::open_bounded(
                    &self.database,
                    access,
                    budget.saturating_sub(started.elapsed()),
                )
                .await
                .map_err(|_| anyhow::anyhow!("The linked notes settings are unavailable"))?;
                let keys: Vec<String> = std::iter::once(config.preference.clone())
                    .chain(config.relative_to.clone())
                    .collect();
                let rows = context
                    .db()
                    .query(
                        "SELECT key,value_json FROM app.preferences WHERE key = ANY($1::text[])",
                        &[&keys],
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("The linked notes settings are unavailable"))?;
                let paths: BTreeMap<String, Value> = rows
                    .into_iter()
                    .map(|row| (row.get(0), row.get(1)))
                    .collect();
                context
                    .commit_bounded(budget.saturating_sub(started.elapsed()))
                    .await
                    .map_err(|_| anyhow::anyhow!("The linked notes settings are unavailable"))?;
                Ok::<_, anyhow::Error>(paths)
            })
            .await
            .map_err(|_| anyhow::anyhow!("The linked notes lookup timed out"))?
        })?;
        let selected = selected_path(config, &paths)?;
        LinkedFolder::open(access, &selected, roots)
    }
}
fn selected_path(config: &PreferenceFolder, paths: &BTreeMap<String, Value>) -> Result<PathBuf> {
    let text = paths
        .get(&config.preference)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(LinkedFolderUnavailable)?;
    let selected = Path::new(text);
    if selected.is_absolute() {
        return Ok(selected.into());
    }
    ensure!(
        !text.contains(['\\', '\0'])
            && selected
                .components()
                .all(|p| matches!(p, Component::Normal(_))),
        LinkedFolderUnavailable
    );
    let base = config
        .relative_to
        .as_ref()
        .and_then(|key| paths.get(key))
        .and_then(Value::as_str)
        .filter(|s| Path::new(s).is_absolute())
        .ok_or(LinkedFolderUnavailable)?;
    Ok(Path::new(base).join(selected))
}

struct Mutation {
    original: Option<String>,
    current: Option<String>,
}
struct PendingFolder {
    folder: LinkedFolder,
    lock: FolderLock,
    mutations: BTreeMap<String, Mutation>,
}
struct PendingCall {
    actor: Uuid,
    folders: BTreeMap<PathBuf, PendingFolder>,
}
pub struct LinkedNotesPorts {
    provider: Arc<dyn FolderProvider>,
    next: Arc<dyn Ports>,
    calls: Mutex<BTreeMap<Uuid, Arc<Mutex<PendingCall>>>>,
}
impl LinkedNotesPorts {
    pub fn new(provider: Arc<dyn FolderProvider>, next: Arc<dyn Ports>) -> Self {
        Self {
            provider,
            next,
            calls: Mutex::new(BTreeMap::new()),
        }
    }
    fn notes(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), "vault", request)?;
        if request.operation == "notes.status" {
            ensure!(
                request.parameters == json!({}),
                "Notes status takes no parameters"
            );
            return match self.provider.resolve(
                scope.access(),
                &scope.module().id,
                &request.resource,
                scope.remaining(),
            ) {
                Ok(folder) => {
                    ensure!(
                        folder.actor == scope.access().actor_user_id(),
                        "The linked folder belongs to another account"
                    );
                    Ok(json!({"available":true}))
                }
                Err(error) if error.is::<LinkedFolderUnavailable>() => {
                    Ok(json!({"available":false}))
                }
                Err(error) => Err(error),
            };
        }
        ensure!(
            matches!(
                request.operation.as_str(),
                "notes.read" | "notes.list" | "notes.compare-write" | "notes.remove"
            ),
            "Unknown linked notes operation"
        );
        let params = request
            .parameters
            .as_object()
            .context("Notes parameters must be an object")?;
        ensure!(
            params.keys().all(|key| matches!(
                key.as_str(),
                "path" | "expected" | "content" | "destinationId"
            )),
            "Unknown notes parameter"
        );
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .context("Notes needs a relative path")?;
        ensure!(path.len() <= 1024, "The relative note path is too long");
        if request.operation != "notes.list" {
            ensure!(path.ends_with(".md"), "Notes requires a Markdown file");
        }
        let folder = self.provider.resolve(
            scope.access(),
            &scope.module().id,
            &request.resource,
            scope.remaining(),
        )?;
        ensure!(
            folder.actor == scope.access().actor_user_id(),
            "The linked folder belongs to another account"
        );
        let identity = folder.identity.clone();
        let mut calls = self
            .calls
            .lock()
            .map_err(|_| anyhow::anyhow!("Notes files are busy"))?;
        ensure!(
            calls.contains_key(&scope.call_id()) || calls.len() < 128,
            "Too many pending notes calls"
        );
        let call = calls
            .entry(scope.call_id())
            .or_insert_with(|| {
                Arc::new(Mutex::new(PendingCall {
                    actor: scope.access().actor_user_id(),
                    folders: BTreeMap::new(),
                }))
            })
            .clone();
        // Only this invocation's mutex spans filesystem I/O. Unrelated accounts never
        // wait for it while looking up their own pending state.
        drop(calls);
        let mut call = call
            .lock()
            .map_err(|_| anyhow::anyhow!("Notes files are busy"))?;
        ensure!(
            call.actor == scope.access().actor_user_id(),
            "This notes call belongs to another account"
        );
        if !call.folders.contains_key(&folder.identity) {
            ensure!(
                call.folders.len() < 8,
                "Too many linked folders in one call"
            );
            let lock = folder
                .vault
                .try_lock_folder()
                .map_err(|_| anyhow::anyhow!("The linked notes folder is busy or unavailable"))?;
            call.folders.insert(
                folder.identity.clone(),
                PendingFolder {
                    folder,
                    lock,
                    mutations: BTreeMap::new(),
                },
            );
        }
        let used: usize = call
            .folders
            .values()
            .flat_map(|f| f.mutations.values())
            .map(|m| {
                m.original.as_ref().map_or(0, String::len)
                    + m.current.as_ref().map_or(0, String::len)
            })
            .sum();
        let count: usize = call.folders.values().map(|f| f.mutations.len()).sum();
        let pending = call
            .folders
            .get_mut(&identity)
            .context("The linked notes folder changed during this call")?;
        let canonical_path = pending.folder.identity.join(path);
        let destination_id = crate::trust::digest(
            format!(
                "moss:managed-note-destination:v1\0{}",
                canonical_path
                    .to_str()
                    .context("The note path is unavailable")?
            )
            .as_bytes(),
        );
        let result = match request.operation.as_str() {
            "notes.list" => {
                let entries = pending
                    .folder
                    .vault
                    .list_limited(path, 2000)
                    .map_err(|_| anyhow::anyhow!("The notes folder cannot be listed"))?;
                let entries: Vec<_> = entries
                    .into_iter()
                    .filter_map(|entry| {
                        let kind = match entry.kind {
                            vault::EntryKind::Dir => "directory",
                            vault::EntryKind::File if entry.name.ends_with(".md") => "file",
                            _ => return None,
                        };
                        Some(json!({"name":entry.name,"kind":kind}))
                    })
                    .collect();
                json!({"entries":entries})
            }
            "notes.read" => {
                json!({"path":path,"destinationId":destination_id,"content":pending.folder.vault.current_text(path,FILE_BYTES)
                .map_err(|_|anyhow::anyhow!("The note is unavailable or too large"))?})
            }
            _ => {
                let expected_destination = params.get("destinationId").and_then(Value::as_str);
                ensure!(
                    expected_destination == Some(destination_id.as_str()),
                    "The linked note destination changed; read its current identity and retry"
                );
                let expected = params
                    .get("expected")
                    .context("A note change requires its expected text or null")?;
                ensure!(
                    expected.is_null() || expected.is_string(),
                    "Expected note text must be a string or null"
                );
                let content = if request.operation == "notes.remove" {
                    None
                } else {
                    Some(
                        params
                            .get("content")
                            .and_then(Value::as_str)
                            .context("A note write requires text")?,
                    )
                };
                let expected = expected.as_str();
                ensure!(
                    expected.map_or(0, str::len) <= FILE_BYTES
                        && content.map_or(0, str::len) <= FILE_BYTES,
                    "The note is too large"
                );
                ensure!(
                    count < FILES || pending.mutations.contains_key(path),
                    "Too many note changes in one call"
                );
                ensure!(
                    used + expected.map_or(0, str::len) + content.map_or(0, str::len) <= CALL_BYTES,
                    "Note changes exceed the call size limit"
                );
                pending
                    .folder
                    .vault
                    .compare_replace(&pending.lock, path, expected, content, FILE_BYTES)
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "The note changed or is unavailable; read its current text and retry"
                        )
                    })?;
                pending
                    .mutations
                    .entry(path.into())
                    .and_modify(|mutation| mutation.current = content.map(str::to_owned))
                    .or_insert_with(|| Mutation {
                        original: expected.map(str::to_owned),
                        current: content.map(str::to_owned),
                    });
                json!({"path":path,"destinationId":destination_id,"saved":true})
            }
        };
        Ok(result)
    }
}
impl Ports for LinkedNotesPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "vault" && request.operation.starts_with("notes.") {
            self.notes(scope, request)
        } else {
            self.next.invoke(scope, port, request)
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let next = self.next.finish_call(scope, success);
        let call = self
            .calls
            .lock()
            .map_err(|_| anyhow::anyhow!("Notes files are busy"))?
            .remove(&scope.call_id());
        let mut conflict = false;
        if !success || next.is_err() {
            if let Some(call) = call {
                let call = call
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Notes files are busy"))?;
                for pending in call.folders.values() {
                    for (path, mutation) in &pending.mutations {
                        if pending
                            .folder
                            .vault
                            .compare_replace(
                                &pending.lock,
                                path,
                                mutation.current.as_deref(),
                                mutation.original.as_deref(),
                                FILE_BYTES,
                            )
                            .is_err()
                        {
                            conflict = true;
                        }
                    }
                }
            }
        }
        if conflict {
            bail!(
                "A note changed outside Moss; automatic rollback left that current text untouched"
            )
        }
        next
    }
}

#[cfg(test)]
#[path = "linked_notes_concurrency.rs"]
mod concurrency_tests;
