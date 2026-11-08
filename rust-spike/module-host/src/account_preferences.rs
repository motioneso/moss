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
}
pub struct AccountPreferencesPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    bindings: BTreeMap<(String, String), Binding>,
    next: Arc<dyn Ports>,
}
impl AccountPreferencesPorts {
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
            let roots = roots
                .get(&access.actor_user_id())
                .context("No allowed notes roots")?;
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
            Binding::Folder { key, .. } | Binding::BooleanOverride { key, .. } => key,
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
                        let roots = roots
                            .get(&access.actor_user_id())
                            .context("No allowed notes roots")?;
                        VaultContext::at_allowed_root(
                            access,
                            &PathBuf::from(path),
                            &AllowedRoots::for_account(access, roots.clone()),
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
