//! Trusted bindings to existing account preferences. Modules never choose keys, actors or roots.
//! Like the local KV port, successful writes commit immediately, independently of guest finalization.
use crate::runtime::{authorize, CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use uuid::Uuid;
use vault::{AllowedRoots, EntryKind, VaultContext};

#[derive(Clone)]
pub enum Binding {
    Folder {
        key: String,
        roots: BTreeMap<Uuid, Vec<PathBuf>>,
    },
    BooleanOverride {
        key: String,
        entry: String,
        default: bool,
    },
    /// A whole JSON value under one key, replaced on write after the host checks its shape.
    Json {
        key: String,
        shape: JsonShape,
    },
}
/// Shapes the host accepts for a `Binding::Json` value. `null` clears the value.
#[derive(Clone, Copy)]
pub enum JsonShape {
    /// An array of strings, each 1..=`max_len` bytes, at most `max_items` entries.
    TextList { max_items: usize, max_len: usize },
    /// An object with a `competitionKey` string and `viewKey` and `viewLabel` strings or nulls, within bounds.
    LastViewed,
}
impl JsonShape {
    fn accepts(self, value: &Value) -> bool {
        if value.is_null() {
            return true;
        }
        match self {
            JsonShape::TextList { max_items, max_len } => value.as_array().is_some_and(|items| {
                items.len() <= max_items
                    && items.iter().all(|i| i.as_str().is_some_and(|t| !t.is_empty() && t.len() <= max_len))
            }),
            JsonShape::LastViewed => value.as_object().is_some_and(|o| {
                let text = |k: &str, max: usize| o.get(k).and_then(Value::as_str).is_some_and(|t| !t.is_empty() && t.len() <= max);
                let maybe = |k: &str, max: usize| o.get(k).is_some_and(|v| v.is_null() || v.as_str().is_some_and(|t| t.chars().count() <= max));
                o.len() == 3 && text("competitionKey", 200) && maybe("viewKey", 100) && maybe("viewLabel", 200)
            }),
        }
    }
}
pub struct AccountPreferencesPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    bindings: BTreeMap<(String, String), Binding>,
    next: Arc<dyn Ports>,
    account_base: Option<PathBuf>,
}
/// Per-account notes root under a host-owned base: `<base>/<account id>`, created on demand.
pub fn account_base_root(base: &std::path::Path, actor: Uuid) -> Result<Vec<PathBuf>> {
    let root = base.join(actor.to_string());
    // A linked account folder could point outside the base or at another account.
    if std::fs::symlink_metadata(&root).is_ok_and(|m| m.file_type().is_symlink()) {
        anyhow::bail!("The notes root could not be prepared");
    }
    private_dir(&root).context("The notes root could not be prepared")?;
    Ok(vec![root])
}
/// Creates the directory owner-only and tightens an existing one.
#[cfg(unix)]
fn private_dir(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}
impl AccountPreferencesPorts {
    /// Accounts without an explicit root get `<base>/<account id>`.
    pub fn with_account_base(mut self, base: PathBuf) -> Self {
        self.account_base = Some(base);
        self
    }
    fn roots_for(&self, roots: &BTreeMap<Uuid, Vec<PathBuf>>, actor: Uuid) -> Result<Vec<PathBuf>> {
        match (roots.get(&actor), &self.account_base) {
            (Some(roots), _) => Ok(roots.clone()),
            (None, Some(base)) => account_base_root(base, actor),
            _ => anyhow::bail!("No allowed notes roots"),
        }
    }
    pub fn new(
        database: Database,
        bindings: BTreeMap<(String, String), Binding>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            bindings,
            next,
            account_base: None,
        })
    }
    fn preference(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        authorize(scope.module(), "kv", request)?;
        let binding = self
            .bindings
            .get(&(scope.module().id.clone(), request.resource.clone()))
            .context("Preference is not connected")?;
        let access = scope.access();
        let write = request.operation == "preference.write";
        if request.operation == "preference.folders" {
            let Binding::Folder { roots, .. } = binding else {
                anyhow::bail!("Not a folder preference")
            };
            let roots = self.roots_for(roots, access.actor_user_id())?;
            let path = request
                .parameters
                .get("path")
                .and_then(Value::as_str)
                .context("Missing folder path")?;
            ensure!(
                request.parameters.as_object().is_some_and(|p| p.len() == 1),
                "Unknown folder parameter"
            );
            let allowed = AllowedRoots::for_account(access, roots.clone());
            let directories: Vec<_> = if path.is_empty() {
                roots.iter().filter_map(|root| {
                    VaultContext::at_allowed_root(access, root, &allowed).ok()?;
                    Some(json!({"name":root.file_name().and_then(|n| n.to_str()).unwrap_or("Notes"),"path":root}))
                }).collect()
            } else {
                let folder = VaultContext::at_allowed_root(access, &PathBuf::from(path), &allowed)?;
                folder
                    .list_limited("", 2000)?
                    .into_iter()
                    .filter(|e| e.kind == EntryKind::Dir)
                    .map(|e| json!({"path":PathBuf::from(path).join(&e.name),"name":e.name}))
                    .collect()
            };
            return Ok(json!({"directories":directories}));
        }
        let key = match binding {
            Binding::Folder { key, .. }
            | Binding::BooleanOverride { key, .. }
            | Binding::Json { key, .. } => key,
        };
        let update = if write {
            ensure!(
                request.parameters.as_object().is_some_and(|p| p.len() == 1),
                "Invalid preference parameters"
            );
            match binding {
                Binding::Folder { roots, .. } => {
                    let value = request.parameters.get("folder").context("Missing folder")?;
                    ensure!(value.is_null() || value.is_string(), "Invalid folder");
                    if let Some(path) = value.as_str() {
                        let roots = self.roots_for(roots, access.actor_user_id())?;
                        VaultContext::at_allowed_root(
                            access,
                            &PathBuf::from(path),
                            &AllowedRoots::for_account(access, roots),
                        )?;
                    }
                    Some(value.clone())
                }
                Binding::BooleanOverride { entry, .. } => {
                    let enabled = request
                        .parameters
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .context("Invalid preference boolean")?;
                    Some(json!({entry:enabled}))
                }
                Binding::Json { shape, .. } => {
                    let value = request.parameters.get("value").context("Missing preference value")?;
                    ensure!(shape.accepts(value), "Invalid preference value");
                    Some(value.clone())
                }
            }
        } else {
            ensure!(
                request.operation == "preference.read" && request.parameters == json!({}),
                "Unknown preference operation"
            );
            None
        };
        let value = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, access, scope.remaining()).await.map_err(|_| anyhow::anyhow!("Account preferences are unavailable"))?;
                let value = if let Some(update) = update {
                    // Merge only the declared boolean member in SQL, preserving concurrent sibling settings.
                    let merge = matches!(binding, Binding::BooleanOverride { .. });
                    let row = cx.db().query_one(
                        "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=CASE WHEN $4 THEN (CASE WHEN jsonb_typeof(app.preferences.value_json)='object' THEN app.preferences.value_json ELSE '{}'::jsonb END) || EXCLUDED.value_json ELSE EXCLUDED.value_json END, revision=app.preferences.revision+1,updated_at=now() RETURNING value_json",
                        &[&access.actor_user_id(),key,&update,&merge]).await?;
                    row.get::<_,Value>(0)
                } else {
                    cx.db().query_opt("SELECT value_json FROM app.preferences WHERE key=$1", &[key]).await?
                        .map(|r| r.get(0)).unwrap_or(Value::Null)
                };
                cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Account preferences could not be saved"))?;
                Ok::<_, anyhow::Error>(value)
            }).await.context("Preference request timed out")?
        })?;
        Ok(match binding {
            Binding::Folder { .. } => json!({"folder":value.as_str().filter(|s|!s.is_empty())}),
            Binding::BooleanOverride { entry, default, .. } => {
                json!({"enabled":value.get(entry).and_then(Value::as_bool).unwrap_or(*default)})
            }
            Binding::Json { .. } => json!({"value":value}),
        })
    }
}
impl Ports for AccountPreferencesPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "kv" && request.operation.starts_with("preference.") {
            self.preference(scope, request)
        } else {
            self.next.invoke(scope, port, request)
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[cfg(all(test, unix))]
mod root_tests {
    use super::account_base_root;
    use uuid::Uuid;

    #[test]
    fn a_linked_account_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let actor = Uuid::new_v4();
        std::os::unix::fs::symlink(&elsewhere, base.join(actor.to_string())).unwrap();
        assert!(account_base_root(&base, actor).is_err());
        assert!(account_base_root(&base, Uuid::new_v4()).is_ok());
    }
}
