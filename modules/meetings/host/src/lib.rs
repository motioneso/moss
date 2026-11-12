//! Meetings-only host assembly. The generic module host stays unaware of Meetings preferences.
//! Capture preferences live in the account's shared preference rows under six fixed keys.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use safety_core::db::{DataContext, Database};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub mod package;

pub const RESOURCE: &str = "meetings.preferences";
pub const PREFERENCE_KEYS: [&str; 6] = [
    "meetings.capture.default-mode",
    "meetings.capture.remembered-source",
    "meetings.summarize-on-stop",
    "meetings.summary-template",
    "meetings.transcript-language",
    "meetings.transcript-vocabulary",
];

pub struct MeetingsPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    /// One transaction per guest call, opened by the first preference operation.
    pending: Mutex<BTreeMap<String, DataContext>>,
}
impl MeetingsPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            pending: Mutex::new(BTreeMap::new()),
        })
    }

    fn take(&self, scope: &CallScope) -> Result<Option<DataContext>> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Meetings preferences busy"))?
            .remove(&scope.call_id().to_string()))
    }

    fn preferences(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let writes = match request.operation.as_str() {
            "get" | "lock" => {
                ensure!(
                    request.parameters.as_object().is_some_and(|v| v.is_empty()),
                    "Meetings preferences take no parameters"
                );
                None
            }
            "set" => {
                let map = request
                    .parameters
                    .as_object()
                    .filter(|v| v.len() == 1)
                    .and_then(|v| v.get("writes"))
                    .and_then(Value::as_object)
                    .ok_or_else(|| anyhow::anyhow!("Invalid Meetings preference write"))?;
                ensure!(
                    map.len() <= PREFERENCE_KEYS.len()
                        && map.keys().all(|k| PREFERENCE_KEYS.contains(&k.as_str())),
                    "Unknown Meetings preference key"
                );
                Some(map.clone())
            }
            _ => anyhow::bail!("Unsupported Meetings preference operation"),
        };
        let reused = self.take(scope)?;
        let (cx, out) = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = match reused {
                    Some(cx) => cx,
                    None => DataContext::open_bounded(
                        &self.database,
                        scope.access(),
                        scope.remaining(),
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("Meetings preferences unavailable"))?,
                };
                let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
                cx.db()
                    .query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout])
                    .await?;
                if request.operation == "lock" {
                    cx.db()
                        .execute(
                            "SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':meetings.capture-preferences',0))",
                            &[],
                        )
                        .await?;
                }
                if let Some(writes) = &writes {
                    for (key, value) in writes {
                        cx.db()
                            .execute(
                                "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES(app.current_actor_user_id(),$1,$2,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=EXCLUDED.updated_at",
                                &[key, value],
                            )
                            .await?;
                    }
                }
                let keys: &[&str] = &PREFERENCE_KEYS;
                let rows = cx
                    .db()
                    .query(
                        "SELECT key,value_json FROM app.preferences WHERE key=ANY($1)",
                        &[&keys],
                    )
                    .await?;
                let mut values = Map::new();
                for row in rows {
                    values.insert(row.get(0), row.get(1));
                }
                Ok::<_, anyhow::Error>((cx, Value::Object(values)))
            })
            .await
            .map_err(|_| anyhow::anyhow!("Meetings preferences deadline expired"))?
        })?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Meetings preferences busy"))?;
        pending.insert(scope.call_id().to_string(), cx);
        Ok(out)
    }
}
impl Ports for MeetingsPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv" || request.resource != RESOURCE || scope.module().id != "meetings" {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        self.preferences(scope, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let pending = self.take(scope)?;
        self.next.finish_call(scope, success)?;
        if let Some(cx) = pending {
            if success {
                ensure!(!scope.remaining().is_zero(), "Meetings preferences deadline expired");
                self.runtime
                    .block_on(cx.commit_bounded(scope.remaining()))
                    .map_err(|_| anyhow::anyhow!("Meetings preferences unavailable"))?;
            }
            // Dropping without a commit rolls the account's write back on a failed call.
        }
        Ok(())
    }
}
