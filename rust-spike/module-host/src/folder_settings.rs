//! Trusted folder selection over existing account preferences. The host, never the
//! guest, binds a resource to preference keys and an account's allowed roots.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use uuid::Uuid;
use vault::{AllowedRoots, EntryKind, VaultContext};

pub struct FolderSetting {
    pub path_key: String,
    pub status_key: String,
    pub roots: BTreeMap<Uuid, Vec<PathBuf>>,
}

pub struct FolderSettingsPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    resources: BTreeMap<(String, String), FolderSetting>,
    next: Arc<dyn Ports>,
}
impl FolderSettingsPorts {
    pub fn new(
        database: Database,
        resources: BTreeMap<(String, String), FolderSetting>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            resources,
            next,
            runtime: tokio::runtime::Runtime::new()?,
        })
    }
    fn execute(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), "vault", request)?;
        let config = self
            .resources
            .get(&(scope.module().id.clone(), request.resource.clone()))
            .context("Folder settings are not connected")?;
        let params = request
            .parameters
            .as_object()
            .context("Folder parameters must be an object")?;
        ensure!(
            params.keys().all(|key| key == "path"),
            "Unknown folder parameter"
        );
        if request.operation == "folder.get" || request.operation == "folder.status" {
            ensure!(params.is_empty(), "Folder read takes no parameters");
            let key = if request.operation == "folder.get" {
                &config.path_key
            } else {
                &config.status_key
            };
            return self.runtime.block_on(async {
                tokio::time::timeout(scope.remaining(), async {
                    let cx = DataContext::open_bounded(
                        &self.database,
                        scope.access(),
                        scope.remaining(),
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("Folder settings data unavailable"))?;
                    let row = cx
                        .db()
                        .query_opt(
                            "SELECT value_json FROM app.preferences WHERE key=$1",
                            &[key],
                        )
                        .await?;
                    let value: Value = row.map(|r| r.get(0)).unwrap_or(Value::Null);
                    cx.commit_bounded(scope.remaining())
                        .await
                        .map_err(|_| anyhow::anyhow!("Folder settings commit failed"))?;
                    Ok::<_, anyhow::Error>(json!({"status":200,"body":value}))
                })
                .await
                .context("Folder settings deadline exceeded")?
            });
        }
        let path = params.get("path").unwrap_or(&Value::Null);
        ensure!(path.is_null() || path.is_string(), "Invalid folder path");
        if request.operation == "folder.set" && path.is_null() {
            return self.save(scope, &config.path_key, &Value::Null);
        }
        let roots = config
            .roots
            .get(&scope.access().actor_user_id())
            .cloned()
            .unwrap_or_default();
        if roots.is_empty() {
            return Ok(error(503, "Notes roots not configured on this server"));
        }
        let allowed = AllowedRoots::for_account(scope.access(), roots.clone());
        let available: Vec<_> = roots
            .iter()
            .filter(|root| VaultContext::at_allowed_root(scope.access(), root, &allowed).is_ok())
            .collect();
        if available.is_empty() {
            return Ok(error(
                503,
                "Configured notes roots are not available on this server",
            ));
        }
        let text = path.as_str().unwrap_or("");
        if request.operation == "folder.list" && text.is_empty() {
            let mut directories: Vec<_> = available.iter().map(|root| json!({"name":root.file_name().unwrap_or_default().to_string_lossy(),"path":root})).collect();
            directories.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
            return Ok(json!({"status":200,"body":{"path":null,"directories":directories}}));
        }
        let selected = PathBuf::from(text);
        let folder = match VaultContext::at_allowed_root(scope.access(), &selected, &allowed) {
            Ok(folder) => folder,
            Err(_) => {
                return Ok(error(
                    400,
                    "Path is not an available folder within an allowed notes root",
                ))
            }
        };
        if request.operation == "folder.set" {
            return self.save(scope, &config.path_key, path);
        }
        ensure!(
            request.operation == "folder.list",
            "Unknown folder operation"
        );
        let directories: Vec<_> = folder
            .list("")?
            .into_iter()
            .filter(|entry| entry.kind == EntryKind::Dir)
            .map(|entry| json!({"name":entry.name,"path":selected.join(&entry.name)}))
            .collect();
        Ok(json!({"status":200,"body":{"path":text,"directories":directories}}))
    }
    // A selection is an idempotent host-side configuration action, committed before
    // returning success. It is not part of the guest's module-table transaction.
    fn save(&self, scope: &CallScope, key: &str, value: &Value) -> Result<Value> {
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining()).await.map_err(|_| anyhow::anyhow!("Folder settings data unavailable"))?;
            cx.db().execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=now()", &[&scope.access().actor_user_id(), &key, value]).await?;
            cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Folder settings commit failed"))?;
            Ok::<_, anyhow::Error>(json!({"status":200,"body":{"path":value}}))
            }).await.context("Folder settings deadline exceeded")?
        })
    }
}
impl Ports for FolderSettingsPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "vault" || !request.operation.starts_with("folder.") {
            return self.next.invoke(scope, port, request);
        }
        ensure!(
            matches!(
                request.operation.as_str(),
                "folder.get" | "folder.status" | "folder.list" | "folder.set"
            ),
            "Unknown folder operation"
        );
        ensure!(!scope.remaining().is_zero(), "Folder request timed out");
        self.execute(scope, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
fn error(status: u16, message: &str) -> Value {
    json!({"status":status,"body":{"error":message}})
}
