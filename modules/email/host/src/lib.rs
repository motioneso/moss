//! Email host assembly. It answers the package's `email.*` resources with SQL under the
//! signed-in person's row-level security. The package never sees the person, a
//! connection or SQL.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use safety_core::db::{DataContext, Database};
use serde_json::Value;
use std::sync::Arc;

pub mod package;
pub mod store;
pub mod threads;
pub mod understand;

pub const MODULE_ID: &str = "email";

pub struct EmailPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
}

impl EmailPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
        })
    }
}

impl Ports for EmailPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv"
            || scope.module().id != MODULE_ID
            || !request.resource.starts_with("email.")
        {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        ensure!(!scope.remaining().is_zero(), "Email deadline expired");
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Email data unavailable"))?;
                let result = if request.resource.starts_with("email.understand")
                    || request.resource == "email.suppression"
                    || request.resource == "email.triage-feedback"
                {
                    understand::run(&cx, request).await?
                } else if request.resource == "email.thread" || request.resource == "email.recent" {
                    threads::run(&cx, request).await?
                } else {
                    store::run(&cx, request).await?
                };
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Email data unavailable"))?;
                Ok(result)
            })
            .await
            .map_err(|_| anyhow::anyhow!("Email deadline expired"))?
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
