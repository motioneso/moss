//! Calendar-only host assembly. The generic module host remains unaware of Calendar preferences.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use safety_core::db::{DataContext, Database};
use serde_json::{Map, Value};
use std::sync::Arc;

pub mod package;
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
}
impl CalendarPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            references: None,
        })
    }
    pub fn with_references(mut self, references: Arc<dyn References>) -> Self {
        self.references = Some(references);
        self
    }
}
impl Ports for CalendarPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "api"
            && scope.module().id == "calendar"
            && matches!(request.resource.as_str(), "tasks" | "briefing")
        {
            moss_module_host::runtime::authorize(scope.module(), port, request)?;
            ensure!(
                request.operation == "call",
                "Unknown Calendar reference operation"
            );
            let fields = request
                .parameters
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Invalid reference request"))?;
            ensure!(
                fields.len() == 2
                    && fields.contains_key("name")
                    && fields.contains_key("parameters"),
                "Invalid reference envelope"
            );
            let parameters = request.parameters["parameters"]
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
            let references = self
                .references
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Calendar public reference adapters unavailable"))?;
            return match (
                request.resource.as_str(),
                request.parameters["name"].as_str(),
            ) {
                ("tasks", Some("getTask")) => references.task(scope, id),
                ("briefing", Some("getRun")) => references.briefing_run(scope, id),
                _ => anyhow::bail!("Unknown Calendar reference projection"),
            };
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
        ensure!(
            scope.module().id == "calendar"
                && request.operation == "get"
                && request.parameters.as_object().is_some_and(|v| v.is_empty()),
            "Calendar preferences are read-only and take no parameters"
        );
        self.runtime.block_on(async {
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                .await
                .map_err(|_| anyhow::anyhow!("Calendar preferences unavailable"))?;
            let chat = request.resource == "calendar.chat-context";
            let keys: &[&str] = if chat { &["locale"] } else { &PREFERENCE_KEYS };
            let rows = cx
                .db()
                .query(
                    "SELECT key,value_json FROM app.preferences WHERE key = ANY($1)",
                    &[&keys],
                )
                .await?;
            let mut values = Map::new();
            for row in rows {
                values.insert(row.get(0), row.get(1));
            }
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Calendar preferences unavailable"))?;
            if chat {
                Ok(serde_json::json!({"timezone":values.get("locale").map(|v|v["timezone"].clone())}))
            } else {
                Ok(Value::Object(values))
            }
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
