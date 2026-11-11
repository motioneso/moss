//! Answers the package's `memory.*` calls with SQL under the signed-in person's row-level
//! security. Memory text goes only to the configured embedding service and never into logs.
use crate::{lifecycle, store};
use anyhow::{ensure, Result};
use moss_module_host::{
    memory_ingest::DocumentEmbeddings,
    memory_search::QueryEmbeddings,
    runtime::{authorize, CallScope, Ports, Request},
};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::{future::Future, sync::Arc};

/// Query and document vectors from the configured embedding service.
pub trait Embedder: Send + Sync {
    fn query(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>>;
    /// The document vector with the model name and version that made it.
    fn document(&self, scope: &CallScope, text: &str) -> Result<(Vec<f64>, (String, String))>;
}
impl<T: QueryEmbeddings + DocumentEmbeddings> Embedder for T {
    fn query(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.embed_query(scope, text)
    }
    fn document(&self, scope: &CallScope, text: &str) -> Result<(Vec<f64>, (String, String))> {
        Ok((self.embed_document(scope, text)?, self.model(scope)?))
    }
}

fn literal(vector: &[f64]) -> Result<String> {
    ensure!(
        !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
        "Invalid embedding"
    );
    Ok(format!(
        "[{}]",
        vector.iter().map(f64::to_string).collect::<Vec<_>>().join(",")
    ))
}

pub struct MemoryPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embedder: Arc<dyn Embedder>,
    next: Arc<dyn Ports>,
}
impl MemoryPorts {
    pub fn new(database: Database, embedder: Arc<dyn Embedder>, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            embedder,
            next,
        })
    }

    fn within<F, Fut>(&self, scope: &CallScope, work: F) -> Result<Value>
    where
        F: FnOnce(DataContext) -> Fut,
        Fut: Future<Output = Result<(DataContext, Value)>>,
    {
        ensure!(!scope.remaining().is_zero(), "Memory deadline expired");
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                let (cx, value) = work(cx).await?;
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                Ok(value)
            })
            .await
            .map_err(|_| anyhow::anyhow!("Memory deadline expired"))?
        })
    }

    fn recall(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let query = request.parameters["query"].as_str().unwrap_or("");
        ensure!(!query.is_empty() && query.len() <= 64 * 1024, "Invalid memory query");
        let vector = match self.embedder.query(scope, query).and_then(|v| literal(&v)) {
            Ok(vector) => vector,
            Err(error) => return Ok(refusal(&error)),
        };
        self.within(scope, |cx| async {
            let value = store::recall(&cx, &request.parameters, &vector).await?;
            Ok((cx, value))
        })
    }

    /// Embeds the fact's saved text and stores the vector. A failed embedding is reported as
    /// `indexed: false`; the fact stays saved either way.
    fn index(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let fact_id = request.parameters["factId"].as_str().unwrap_or("").to_owned();
        let pending = self.within(scope, |cx| async {
            let text = store::pending_text(&cx, &fact_id).await?;
            Ok((cx, json!(text)))
        })?;
        let Some(search) = pending.as_str() else {
            return Ok(json!({"indexed": false}));
        };
        let stored = self
            .embedder
            .document(scope, search)
            .and_then(|(vector, model)| Ok((literal(&vector)?, model)));
        let Ok((vector, model)) = stored else {
            return Ok(json!({"indexed": false}));
        };
        self.within(scope, |cx| async {
            let done = store::store_vector(&cx, &fact_id, search, &vector, &model).await?;
            Ok((cx, json!({"indexed": done})))
        })
    }
}

/// A refusal the guest turns into a plain status. Only the fixed "not set up" wording is
/// passed through; anything else becomes a generic message.
fn refusal(error: &anyhow::Error) -> Value {
    let message = error.to_string();
    if message.starts_with("No embedding model is set up") {
        json!({"refused": {"status": 503, "message": "No embedding model is set up"}})
    } else {
        json!({"refused": {"status": 503, "message": "Memory search is unavailable"}})
    }
}

impl Ports for MemoryPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv" || scope.module().id != crate::MODULE_ID || !request.resource.starts_with("memory.") {
            return self.next.invoke(scope, port, request);
        }
        authorize(scope.module(), port, request)?;
        match (request.operation.as_str(), request.resource.as_str()) {
            ("get", "memory.recall") => self.recall(scope, request),
            ("set", "memory.index") => self.index(scope, request),
            (_, "memory.lifecycle" | "memory.target" | "memory.forget") => {
                self.within(scope, |cx| async {
                    let value = lifecycle::run(&cx, request).await?;
                    Ok((cx, value))
                })
            }
            _ => self.within(scope, |cx| async {
                let value = store::run(&cx, request, None).await?;
                Ok((cx, value))
            }),
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
