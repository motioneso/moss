//! Read-only core-memory search through a trusted module/resource binding. The
//! embedding service must use the actor's configured query model (including its
//! query prefix); document embeddings and guest-selected vectors are not accepted.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

pub trait QueryEmbeddings: Send + Sync {
    fn embed_query(&self, scope: &CallScope, query: &str) -> Result<Vec<f64>>;
}

pub struct MemorySearchPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embeddings: Arc<dyn QueryEmbeddings>,
    /// (module, resource alias) -> source kind, supplied by host assembly only.
    sources: BTreeMap<(String, String), String>,
    next: Arc<dyn Ports>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
    limit: i64,
}
impl MemorySearchPorts {
    pub fn new(
        database: Database,
        embeddings: Arc<dyn QueryEmbeddings>,
        sources: BTreeMap<(String, String), String>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            embeddings,
            sources,
            next,
            runtime: tokio::runtime::Runtime::new()?,
        })
    }
    fn search(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), "vault", r)?;
        let source = self
            .sources
            .get(&(scope.module().id.clone(), r.resource.clone()))
            .context("Memory source is not connected")?;
        let input: Search = serde_json::from_value(r.parameters.clone())?;
        ensure!(
            !input.query.is_empty()
                && input.query.len() <= 64 * 1024
                && (1..=20).contains(&input.limit),
            "Invalid memory search input"
        );
        ensure!(!scope.remaining().is_zero(), "Memory search timed out");
        let vector = self.embeddings.embed_query(scope, &input.query)?;
        ensure!(
            !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
            "Invalid query embedding"
        );
        let vector = format!(
            "[{}]",
            vector
                .iter()
                .map(f64::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory data unavailable"))?;
                // The explicit owner predicate matches the legacy repository as
                // well as FORCE RLS. No table, source or actor comes from the guest.
                let rows = cx.db().query("SELECT source_path,line_start,line_end,text FROM app.memory_chunks WHERE embedding IS NOT NULL AND owner_user_id = app.current_actor_user_id() AND source_kind=$1 ORDER BY embedding <=> $2::text::vector LIMIT $3", &[source, &vector, &input.limit]).await?;
                let chunks: Vec<_> = rows.iter().map(|row| json!({"sourcePath":row.get::<_,String>(0),"lineStart":row.get::<_,i32>(1),"lineEnd":row.get::<_,i32>(2),"text":row.get::<_,String>(3)})).collect();
                cx.commit_bounded(scope.remaining()).await.map_err(|_| anyhow::anyhow!("Memory read commit failed"))?;
                Ok::<_, anyhow::Error>(json!({"chunks":chunks}))
            }).await.context("Memory search deadline exceeded")?
        }).map_err(|_| anyhow::anyhow!("Notes search is unavailable"))
    }
}
impl Ports for MemorySearchPorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "vault" && r.operation == "index.search" {
            return self
                .search(scope, r)
                .map_err(|_| anyhow::anyhow!("Notes search is unavailable"));
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
