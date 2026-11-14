//! Scratchpad host assembly. The guest keeps every rule. This side answers the store calls with
//! SQL under the caller's own row policies.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use moss_module_host::transactional_database::join_call_session;
use safety_core::db::{DataContext, Database};
use serde_json::Value;
use std::sync::Arc;

pub mod package;
pub mod store;

type Work<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + 'a>>;

pub struct ScratchpadPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
}

impl ScratchpadPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self { database, runtime: tokio::runtime::Runtime::new()?, next })
    }

    /// Runs one store operation in the call's shared transaction.
    fn run(&self, scope: &CallScope, work: impl for<'a> FnOnce(&'a DataContext) -> Work<'a>) -> Result<Value> {
        let session = join_call_session(&self.database, &self.runtime, scope)?;
        let session = session.lock().map_err(|_| anyhow::anyhow!("Scratchpad store busy"))?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = session.context();
                cx.db().batch_execute("RESET ROLE").await?;
                let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
                cx.db().query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout]).await?;
                work(cx).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("Scratchpad store deadline expired"))?
        })
    }

    fn store(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let p = request.parameters.clone();
        match request.operation.as_str() {
            "get" => self.run(scope, |cx| Box::pin(store::get(cx))),
            "put" => self.run(scope, move |cx| Box::pin(async move { store::put(cx, &p).await })),
            "append" => self.run(scope, move |cx| Box::pin(async move { store::append(cx, &p).await })),
            "settings" => self.run(scope, move |cx| Box::pin(async move { store::settings(cx, &p).await })),
            _ => anyhow::bail!("Unsupported Scratchpad store operation"),
        }
    }
}

impl Ports for ScratchpadPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv" || request.resource != store::STORE || scope.module().id != "scratchpad" {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        ensure!(request.parameters.is_object(), "Scratchpad store takes an object");
        self.store(scope, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
