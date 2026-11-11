//! Calendar-only host assembly. The generic module host remains unaware of Calendar preferences.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use safety_core::db::{DataContext, Database};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub mod package;
mod settings;
mod sources;
#[cfg(feature = "web")]
pub mod web;
pub const PREFERENCE_KEYS: [&str; 7] = [
    "calendar.briefing_lookahead_days",
    "calendar.signal_suggest_tasks",
    "calendar.signal_create_tasks",
    "calendar.signal_suggest_time_blocks",
    "calendar.signal_block_time",
    "calendar.prep_task_mode",
    "calendar.time_block_mode",
];
/// Host composition supplies projections through the owning public interface.
/// Implementations must use the supplied authenticated scope, never caller identities.
pub trait References: Send + Sync {
    fn task(&self, scope: &CallScope, id: &str) -> Result<Value>;
    fn briefing_run(&self, scope: &CallScope, id: &str) -> Result<Value>;
}
pub struct CalendarPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    references: Option<Arc<dyn References>>,
    settings_writes: Mutex<BTreeMap<String, DataContext>>,
}
impl CalendarPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            references: None,
            settings_writes: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn with_references(mut self, references: Arc<dyn References>) -> Self {
        self.references = Some(references);
        self
    }
}
impl Ports for CalendarPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "kv"
            && scope.module().id == "calendar"
            && matches!(
                request.resource.as_str(),
                "calendar.task-reference" | "calendar.briefing-reference"
            )
        {
            moss_module_host::runtime::authorize(scope.module(), port, request)?;
            ensure!(
                request.operation == "get",
                "Calendar references are read-only"
            );
            let parameters = request
                .parameters
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Invalid reference parameters"))?;
            ensure!(
                parameters.len() == 1 && parameters.contains_key("id"),
                "References accept only an id"
            );
            let id = parameters["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Reference id required"))?;
            if request.resource == "calendar.task-reference" && self.references.is_none() {
                // The Tasks package answers through its public API, under this account.
                let call = Request {
                    operation: "call".into(),
                    resource: "tasks".into(),
                    parameters: serde_json::json!({"name":"getTaskReference","parameters":{"id":id}}),
                };
                moss_module_host::runtime::authorize(scope.module(), "api", &call)?;
                return self.next.invoke(scope, "api", &call);
            }
            let references = self
                .references
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Calendar public reference adapters unavailable"))?;
            return match request.resource.as_str() {
                "calendar.task-reference" => references.task(scope, id),
                "calendar.briefing-reference" => references.briefing_run(scope, id),
                _ => unreachable!(),
            };
        }
        if port == "kv"
            && scope.module().id == "calendar"
            && request.resource == "calendar.source-behaviors"
        {
            moss_module_host::runtime::authorize(scope.module(), port, request)?;
            return self.source_behaviors(scope, request);
        }
        if port != "kv"
            || !matches!(
                request.resource.as_str(),
                "calendar.briefing-settings" | "calendar.chat-context"
            )
        {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        if scope.module().id == "calendar"
            && request.resource == "calendar.briefing-settings"
            && request.operation == "set"
        {
            return self.save_settings(scope, &request.parameters);
        }
        ensure!(
            scope.module().id == "calendar"
                && request.operation == "get"
                && request.parameters.as_object().is_some_and(|v| v.is_empty()),
            "Calendar preferences are read-only and take no parameters"
        );
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Calendar preferences unavailable"))?;
            let chat = request.resource == "calendar.chat-context";
            let keys: &[&str] = if chat { &["locale", "persona.bundle"] } else { &PREFERENCE_KEYS };
            let rows = cx
                .db()
                .query(
                    "SELECT key, CASE WHEN key='persona.bundle' THEN jsonb_build_object('assistantName',value_json->'assistantName') ELSE value_json END FROM app.preferences WHERE key = ANY($1)",
                    &[&keys],
                )
                .await?;
            let mut values = Map::new();
            for row in rows {
                values.insert(row.get(0), row.get(1));
            }
            cx.commit_bounded(scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Calendar preferences unavailable"))?;
            if chat {
                Ok(serde_json::json!({"timezone":values.get("locale").map(|v|v["timezone"].clone()),"dateFormat":values.get("locale").map(|v|v["dateFormat"].clone()),"assistantName":values.get("persona.bundle").map(|v|v["assistantName"].clone())}))
            } else {
                Ok(Value::Object(values))
            }
            }).await.map_err(|_| anyhow::anyhow!("Calendar preferences deadline expired"))?
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let pending = self
            .settings_writes
            .lock()
            .map_err(|_| anyhow::anyhow!("Calendar settings busy"))?
            .remove(&scope.call_id().to_string());
        self.next.finish_call(scope, success)?;
        if let Some(cx) = pending {
            if success {
                ensure!(
                    !scope.remaining().is_zero(),
                    "Calendar settings deadline expired"
                );
                self.runtime
                    .block_on(cx.commit_bounded(scope.remaining()))
                    .map_err(|_| anyhow::anyhow!("Calendar settings unavailable"))?;
            }
            // Drop without commit rolls the actor-scoped write back on failed guest calls.
        }
        Ok(())
    }
}
