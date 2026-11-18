//! Opt-in last-sync outcomes for an account-bound linked-folder resource.
//! Place OUTSIDE TransactionalDatabasePorts: persistence runs in a fresh
//! transaction after commit/rollback and after continuation publication.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase", deny_unknown_fields)]
enum Outcome {
    Completed {
        ingested: u64,
        skipped: u64,
        errors: u64,
    },
    Failed {
        #[serde(rename = "lastError")]
        last_error: String,
    },
    Deferred,
}
impl Outcome {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Completed {
                ingested,
                skipped,
                errors,
            } => ensure!(
                [ingested, skipped, errors]
                    .into_iter()
                    .all(|n| *n <= (1u64 << 53) - 1),
                "Invalid sync counts"
            ),
            Self::Failed { last_error } => ensure!(
                !last_error.is_empty() && last_error.len() <= 1024,
                "Invalid sync failure"
            ),
            Self::Deferred => (),
        }
        Ok(())
    }
    fn value(self, success: bool) -> Option<Value> {
        let mut value = match self {
            Self::Failed { last_error } => {
                json!({"ingested":0,"skipped":0,"errors":0,"lastError":last_error})
            }
            _ if !success => {
                json!({"ingested":0,"skipped":0,"errors":0,"lastError":"notes sync failed (Error)"})
            }
            Self::Completed {
                ingested,
                skipped,
                errors,
            } => json!({"ingested":ingested,"skipped":skipped,"errors":errors}),
            Self::Deferred => return None,
        };
        value["at"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        Some(value)
    }
}

pub struct FolderSyncStatusPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    /// Trusted (module, resource) -> existing preference key. Never guest-selected.
    keys: BTreeMap<(String, String), String>,
    pending: Mutex<BTreeMap<Uuid, (String, Outcome)>>,
    next: Arc<dyn Ports>,
}
impl FolderSyncStatusPorts {
    pub fn new(
        database: Database,
        keys: BTreeMap<(String, String), String>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            keys,
            next,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
            pending: Mutex::new(BTreeMap::new()),
        })
    }
    fn save(&self, scope: &CallScope, key: &str, value: Value) -> Result<()> {
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await.map_err(|_| anyhow::anyhow!("Sync status data unavailable"))?;
                cx.db().execute(
                    "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=now()",
                    &[&scope.access().actor_user_id(), &key, &value],
                ).await?;
                cx.commit_bounded(scope.remaining()).await
                    .map_err(|_| anyhow::anyhow!("Sync status commit failed"))?;
                Ok(())
            }).await.context("Sync status deadline exceeded")?
        })
    }
}
impl Ports for FolderSyncStatusPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "vault" || request.operation != "folder.record-sync" {
            return self.next.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        let key = self
            .keys
            .get(&(scope.module().id.clone(), request.resource.clone()))
            .context("Sync status is not connected")?;
        let outcome: Outcome = serde_json::from_value(request.parameters.clone())?;
        outcome.validate()?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Sync status busy"))?;
        ensure!(
            !pending.contains_key(&scope.call_id()),
            "Sync outcome already recorded"
        );
        pending.insert(scope.call_id(), (key.clone(), outcome));
        Ok(json!({"deferred":true}))
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Sync status busy"))?
            .remove(&scope.call_id());
        let result = self.next.finish_call(scope, success);
        if let Some((key, outcome)) = pending {
            if let Some(value) = outcome.value(success && result.is_ok()) {
                // Deliberately best effort, matching legacy: a diagnostic write
                // must never mask an ingest or queue-publication result.
                let _ = self.save(scope, &key, value);
            }
        }
        result
    }
}
