//! Host-owned, millisecond precision time, account identity and fresh identifiers.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use std::sync::Arc;
pub struct ContextPorts {
    next: Arc<dyn Ports>,
}
impl ContextPorts {
    pub fn new(next: Arc<dyn Ports>) -> Self {
        Self { next }
    }
}
impl Ports for ContextPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "context" || request.operation == "local-date" {
            return self.next.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        ensure!(
            request.parameters.as_object().is_some_and(|p| p.is_empty()),
            "Context takes no parameters"
        );
        match (request.operation.as_str(), request.resource.as_str()) {
            ("read", "call") => Ok(
                json!({"actorUserId":scope.access().actor_user_id(),"now":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
            ),
            ("uuid", "new") => Ok(json!({"id":uuid::Uuid::new_v4()})),
            _ => bail!("Unknown context operation"),
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
