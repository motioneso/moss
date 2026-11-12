//! Answers the package's `memory.*` calls with SQL under the signed-in person's row-level
//! security. Memory text goes only to the configured embedding service and never into logs.
use crate::recording::{self, NoAuthority, RecordingAuthority};
use crate::{dashboard, lifecycle, public, reembed, store};
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
    /// The model name and version the configured service makes vectors with right now.
    fn model(&self, scope: &CallScope) -> Result<(String, String)>;
}
impl<T: QueryEmbeddings + DocumentEmbeddings> Embedder for T {
    fn query(&self, scope: &CallScope, text: &str) -> Result<Vec<f64>> {
        self.embed_query(scope, text)
    }
    fn document(&self, scope: &CallScope, text: &str) -> Result<(Vec<f64>, (String, String))> {
        Ok((self.embed_document(scope, text)?, DocumentEmbeddings::model(self, scope)?))
    }
    fn model(&self, scope: &CallScope) -> Result<(String, String)> {
        DocumentEmbeddings::model(self, scope)
    }
}

fn literal(vector: &[f64]) -> Result<String> {
    ensure!(
        !vector.is_empty() && vector.len() <= 65536 && vector.iter().all(|n| n.is_finite()),
        "Invalid embedding"
    );
    Ok(format!(
        "[{}]",
        vector
            .iter()
            .map(f64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

pub struct MemoryPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    embedder: Arc<dyn Embedder>,
    next: Arc<dyn Ports>,
    authority: Arc<dyn RecordingAuthority>,
}
impl MemoryPorts {
    pub fn new(
        database: Database,
        embedder: Arc<dyn Embedder>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            embedder,
            next,
            authority: Arc::new(NoAuthority),
        })
    }

    /// Connects Meetings' answers about recordings. Without it no recording change is admitted.
    pub fn with_authority(mut self, authority: Arc<dyn RecordingAuthority>) -> Self {
        self.authority = authority;
        self
    }

    fn within<F, Fut>(&self, scope: &CallScope, work: F) -> Result<Value>
    where
        F: FnOnce(DataContext) -> Fut,
        Fut: Future<Output = Result<(DataContext, Value)>>,
    {
        ensure!(!scope.remaining().is_zero(), "Memory deadline expired");
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx =
                    DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
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
        ensure!(
            !query.is_empty() && query.len() <= 64 * 1024,
            "Invalid memory query"
        );
        let vector = match self.embedder.query(scope, query).and_then(|v| literal(&v)) {
            Ok(vector) => vector,
            Err(error) => return Ok(refusal(&error)),
        };
        let model = match self.embedder.model(scope) {
            Ok(model) => model.0,
            Err(error) => return Ok(refusal(&error)),
        };
        self.within(scope, |cx| async {
            let value = store::recall(&cx, &request.parameters, &vector, &model).await?;
            Ok((cx, value))
        })
    }

    fn recording_step(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        self.within(scope, |cx| async {
            let value = recording::run(&cx, &*self.authority, request).await?;
            Ok((cx, value))
        })
    }

    /// Recording memory. Applying a proposal embeds its text between two transactions, so no
    /// lock is held while the embedding service runs. A failed embedding publishes the fact
    /// without a vector; the search index fills it in later.
    fn recording(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let result = (|| {
            if request.parameters["action"] != "apply" {
                return self.recording_step(scope, request);
            }
            let step = |action: &str, extra: Value| {
                let mut parameters = request.parameters.clone();
                parameters["action"] = json!(action);
                parameters["embedding"] = extra;
                Request {
                    operation: "set".into(),
                    resource: request.resource.clone(),
                    parameters,
                }
            };
            let loaded = self.recording_step(scope, &step("applyLoad", Value::Null))?;
            if !loaded["done"].is_null() {
                return Ok(loaded["done"].clone());
            }
            let embedding = loaded["embed"]
                .as_str()
                .and_then(|text| self.embedder.document(scope, text).ok())
                .and_then(|(vector, model)| {
                    Some(json!({"vector": literal(&vector).ok()?, "model": [model.0, model.1]}))
                })
                .unwrap_or(Value::Null);
            self.recording_step(scope, &step("applyPublish", embedding))
        })();
        match result {
            Err(error) => match recording::refusal_of(&error) {
                Some((status, message)) => {
                    Ok(json!({"refused": {"status": status, "message": message}}))
                }
                None => Err(error),
            },
            ok => ok,
        }
    }

    /// The public API for other modules. The caller never supplies an owner or a vector.
    fn public(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let p = &request.parameters;
        let name = p["call"].as_str().unwrap_or("");
        let embed_doc = |text: &str| -> Result<(String, (String, String))> {
            ensure!(text.len() <= 64 * 1024, "Memory text too long");
            let (vector, model) = self.embedder.document(scope, text)?;
            Ok((literal(&vector)?, model))
        };
        match name {
            "searchChunks" => {
                let query = p["query"].as_str().unwrap_or("");
                ensure!(!query.is_empty() && query.len() <= 64 * 1024, "Invalid memory query");
                public::source_kind(p)?;
                let vector = match self.embedder.query(scope, query).and_then(|v| literal(&v)) {
                    Ok(vector) => vector,
                    Err(error) => return Ok(refusal(&error)),
                };
                self.within(scope, |cx| async {
                    let value = public::search_chunks(&cx, p, &vector).await?;
                    Ok((cx, value))
                })
            }
            "upsertChunks" => {
                let kind = public::source_kind(p)?.to_owned();
                let path = p["sourcePath"].as_str().ok_or_else(|| anyhow::anyhow!("Missing sourcePath"))?;
                let items = p["chunks"].as_array().ok_or_else(|| anyhow::anyhow!("Missing chunks"))?;
                ensure!(items.len() <= 500, "Too many chunks");
                let replace = p["replaceExisting"].as_bool().unwrap_or(true);
                let mut chunks = Vec::new();
                let mut model = (String::new(), String::new());
                for item in items {
                    let text = item["text"].as_str().unwrap_or("");
                    let (vector, m) = match embed_doc(text) {
                        Ok(done) => done,
                        Err(error) => return Ok(refusal(&error)),
                    };
                    model = m;
                    chunks.push(public::EmbeddedChunk {
                        line_start: item["lineStart"].as_i64().unwrap_or(0).clamp(0, i32::MAX as i64) as i32,
                        line_end: item["lineEnd"].as_i64().unwrap_or(0).clamp(0, i32::MAX as i64) as i32,
                        hash: item["contentHash"].as_str().map_or_else(|| public::sha256_hex(text), str::to_owned),
                        text: text.to_owned(),
                        vector,
                    });
                }
                self.within(scope, |cx| async {
                    public::write_chunks(&cx, &kind, path, replace, &chunks, &model).await?;
                    Ok((cx, json!({"written": chunks.len()})))
                })
            }
            "embedTurn" => {
                let thread = p["threadId"].as_str().ok_or_else(|| anyhow::anyhow!("Missing threadId"))?;
                let text = format!(
                    "User: {}\nAssistant: {}",
                    p["userText"].as_str().unwrap_or(""),
                    p["assistantText"].as_str().unwrap_or("")
                );
                let hash = public::sha256_hex(&text);
                let same = self.within(scope, |cx| async {
                    let found = public::file_hash(&cx, "chat", thread).await?;
                    Ok((cx, json!(found.as_deref() == Some(hash.as_str()))))
                })?;
                if same == json!(true) {
                    return Ok(json!({"skipped": true}));
                }
                let (vector, model) = match embed_doc(&text) {
                    Ok(done) => done,
                    Err(error) => return Ok(refusal(&error)),
                };
                let chunk = public::EmbeddedChunk {
                    line_start: 0,
                    line_end: 0,
                    hash: hash.clone(),
                    text,
                    vector,
                };
                self.within(scope, |cx| async {
                    public::write_chunks(&cx, "chat", thread, true, std::slice::from_ref(&chunk), &model).await?;
                    public::upsert_file_index(&cx, "chat", thread, &hash, 1, &model).await?;
                    Ok((cx, json!({"skipped": false})))
                })
            }
            "deleteChunksForSources" => self.within(scope, |cx| async {
                let value = public::delete_chunks(&cx, p).await?;
                Ok((cx, value))
            }),
            "listRecentChunks" => self.within(scope, |cx| async {
                let value = public::list_recent_chunks(&cx, p).await?;
                Ok((cx, value))
            }),
            _ => self.within(scope, |cx| async {
                let value = public::run(&cx, name, p).await?;
                Ok((cx, value))
            }),
        }
    }

    /// Embeds the fact's saved text and stores the vector. A failed embedding is reported as
    /// `indexed: false`; the fact stays saved either way.
    fn index(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let fact_id = request.parameters["factId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
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

impl MemoryPorts {
    /// Status, start, step, cancel and the retry of facts saved without a vector.
    fn reembed(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let action = if request.operation == "get" {
            "status"
        } else {
            request.parameters["action"].as_str().unwrap_or("")
        };
        let run = request.parameters["runId"].as_str().unwrap_or("").to_owned();
        let model = match action {
            "cancel" => None,
            _ => match self.embedder.model(scope) {
                Ok(model) => Some(model),
                Err(error) => return Ok(refusal(&error)),
            },
        };
        match (action, model) {
            ("status", Some(model)) => self.within(scope, |cx| async {
                let value = reembed::status(&cx, &model).await?;
                Ok((cx, value))
            }),
            ("start", Some(model)) => self.within(scope, |cx| async {
                let value = reembed::start(&cx, &model).await?;
                Ok((cx, value))
            }),
            ("cancel", _) => self.within(scope, |cx| async {
                let value = reembed::cancel(&cx).await?;
                Ok((cx, value))
            }),
            ("step", Some(_)) => self.reembed_step(scope, &run),
            ("retry-missing", Some(model)) => self.retry_missing(scope, &model),
            _ => anyhow::bail!("Unknown memory request"),
        }
    }

    /// Embeds one batch outside any transaction, stages it, and swaps everything in once no
    /// passage is left. Any failure ends the run and leaves the old vectors in place.
    fn reembed_step(&self, scope: &CallScope, run: &str) -> Result<Value> {
        ensure!(!run.is_empty() && run.len() <= 64, "Invalid run");
        let batch = self.within(scope, |cx| async {
            let Some(model) = reembed::running(&cx, run).await? else {
                return Ok((cx, json!({"status": "stopped"})));
            };
            let items = reembed::next_batch(&cx, run, &model.0).await?;
            let items: Vec<Value> = items
                .into_iter()
                .map(|i| json!({"kind": i.kind, "id": i.id, "hash": i.hash, "text": i.text}))
                .collect();
            Ok((cx, json!({"model": [model.0, model.1], "items": items})))
        })?;
        if batch["status"] == "stopped" {
            return Ok(batch);
        }
        let target = (
            batch["model"][0].as_str().unwrap_or("").to_owned(),
            batch["model"][1].as_str().unwrap_or("").to_owned(),
        );
        let mut staged = Vec::new();
        for item in batch["items"].as_array().into_iter().flatten() {
            // A service error returns, so the job retries and resumes from the staged rows.
            let (vector, made) = self.embedder.document(scope, item["text"].as_str().unwrap_or(""))?;
            // A changed model or an unusable vector can never succeed, so the run ends.
            match (made == target, literal(&vector)) {
                (true, Ok(vector)) => staged.push((item, vector)),
                _ => return self.fail_run(scope, run),
            }
        }
        self.within(scope, |cx| async {
            if !reembed::hold(&cx, run).await? {
                return Ok((cx, json!({"status": "stopped"})));
            }
            for (item, vector) in &staged {
                let pending = reembed::Pending {
                    kind: if item["kind"] == "chunk" { "chunk" } else { "document" },
                    id: item["id"].as_str().unwrap_or("").to_owned(),
                    hash: item["hash"].as_str().unwrap_or("").to_owned(),
                    text: String::new(),
                };
                reembed::stage(&cx, run, &pending, vector).await?;
            }
            let left = reembed::remaining(&cx, run, &target.0).await?;
            let mut status = "running";
            if left == 0 {
                reembed::swap(&cx, run, &target).await?;
                status = "done";
            }
            let (total, done) = reembed::progress(&cx, run).await?;
            Ok((cx, json!({"status": status, "total": total, "staged": done, "remaining": left})))
        })
    }

    fn fail_run(&self, scope: &CallScope, run: &str) -> Result<Value> {
        self.within(scope, |cx| async {
            if reembed::hold(&cx, run).await? {
                reembed::close(&cx, run, "failed").await?;
            }
            Ok((cx, json!({"status": "failed"})))
        })
    }

    /// Gives a small batch of facts that were saved without a vector another try.
    fn retry_missing(&self, scope: &CallScope, model: &(String, String)) -> Result<Value> {
        let waiting = self.within(scope, |cx| async {
            let rows = reembed::missing(&cx, reembed::BATCH).await?;
            Ok((cx, json!(rows)))
        })?;
        let (mut retried, mut failed) = (0u64, 0u64);
        for row in waiting.as_array().into_iter().flatten() {
            let (id, text) = (row[0].as_str().unwrap_or(""), row[1].as_str().unwrap_or(""));
            let stored = self.embedder.document(scope, text).and_then(|(vector, made)| {
                ensure!(&made == model, "The embedding model changed");
                literal(&vector).map(|v| (v, made))
            });
            let Ok((vector, made)) = stored else {
                failed += 1;
                continue;
            };
            let done = self.within(scope, |cx| async {
                let done = store::store_vector(&cx, id, text, &vector, &made).await?;
                Ok((cx, json!(done)))
            })?;
            if done == json!(true) {
                retried += 1;
            }
        }
        Ok(json!({"retried": retried, "failed": failed}))
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
        if port != "kv"
            || scope.module().id != crate::MODULE_ID
            || !request.resource.starts_with("memory.")
        {
            return self.next.invoke(scope, port, request);
        }
        authorize(scope.module(), port, request)?;
        match (request.operation.as_str(), request.resource.as_str()) {
            ("get", "memory.recall") => self.recall(scope, request),
            ("set", "memory.index") => self.index(scope, request),
            (_, "memory.recording") => self.recording(scope, request),
            (_, "memory.reembed") => self.reembed(scope, request),
            (_, "memory.public") => self.public(scope, request),
            (_, "memory.lifecycle" | "memory.target" | "memory.forget") => {
                self.within(scope, |cx| async {
                    let value = lifecycle::run(&cx, request).await?;
                    Ok((cx, value))
                })
            }
            (
                _,
                "memory.facts" | "memory.candidates" | "memory.candidate" | "memory.fact-patch"
                | "memory.entity-patch" | "memory.entity-delete" | "memory.subject",
            ) => self.within(scope, |cx| async {
                let value = dashboard::run(&cx, request).await?;
                Ok((cx, value))
            }),
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
