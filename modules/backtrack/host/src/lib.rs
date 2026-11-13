//! Backtrack host assembly. The guest keeps every rule. This side answers the store calls with
//! SQL under the caller's own row policies and checks the Mac link behind a narrow port.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use moss_module_host::transactional_database::join_call_session;
use safety_core::db::{DataContext, Database};
use serde_json::Value;
use std::sync::Arc;

pub mod link;
pub mod package;
pub mod store;

type Work<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + 'a>>;

pub struct BacktrackPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    links: Arc<dyn link::MacLinks>,
    storage_default: Option<String>,
}

impl BacktrackPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            links: Arc::new(link::Refusing),
            storage_default: std::env::var("MOSS_BACKTRACK_STORAGE").ok(),
        })
    }

    /// Connects the paired-Mac credential check for the upload route.
    pub fn with_links(mut self, links: Arc<dyn link::MacLinks>) -> Self {
        self.links = links;
        self
    }

    /// Runs one store operation in the call's shared transaction.
    fn run(&self, scope: &CallScope, work: impl for<'a> FnOnce(&'a DataContext) -> Work<'a>) -> Result<Value> {
        let session = join_call_session(&self.database, &self.runtime, scope)?;
        let session = session.lock().map_err(|_| anyhow::anyhow!("Backtrack store busy"))?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = session.context();
                cx.db().batch_execute("RESET ROLE").await?;
                let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
                cx.db().query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout]).await?;
                work(cx).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("Backtrack store deadline expired"))?
        })
    }

    fn link(&self, scope: &CallScope) -> Result<Value> {
        let owner = scope.access().actor_user_id();
        Ok(match self.links.resolve(owner, scope.access().request_id())? {
            link::Link::Device(id) => serde_json::json!({"link": "device", "deviceId": id.to_string()}),
            link::Link::Pending => serde_json::json!({"link": "pending"}),
            link::Link::Deactivated => serde_json::json!({"link": "deactivated"}),
            link::Link::None => serde_json::json!({"link": "none"}),
        })
    }

    fn store(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let p = request.parameters.clone();
        let environment = self.storage_default.clone();
        match request.operation.as_str() {
            "link" => self.link(scope),
            "lock" => self.run(scope, |cx| Box::pin(store::lock(cx))),
            "storage" => self.run(scope, move |cx| Box::pin(async move { store::storage(cx, environment.as_deref()).await })),
            "paused" => self.run(scope, |cx| Box::pin(store::paused(cx))),
            "set-paused" => self.run(scope, move |cx| Box::pin(async move { store::set_paused(cx, &p).await })),
            "overlaps" => self.run(scope, move |cx| Box::pin(async move { store::overlaps(cx, &p).await })),
            "insert" => self.run(scope, move |cx| Box::pin(async move { store::insert(cx, &p).await })),
            "delete" => self.run(scope, move |cx| Box::pin(async move { store::delete(cx, &p).await })),
            "upkeep" => self.run(scope, |cx| Box::pin(store::upkeep(cx))),
            "status" => self.run(scope, |cx| Box::pin(store::status(cx))),
            "export" => self.run(scope, |cx| Box::pin(store::export(cx))),
            _ => anyhow::bail!("Unsupported Backtrack store operation"),
        }
    }
}

impl Ports for BacktrackPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv" || request.resource != store::STORE || scope.module().id != "backtrack" {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        ensure!(request.parameters.is_object(), "Backtrack store takes an object");
        self.store(scope, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
