//! Meetings-only host assembly. The generic module host stays unaware of Meetings preferences.
//! Capture preferences live in the account's shared preference rows under six fixed keys.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use moss_module_host::transactional_database::join_call_session;
use safety_core::db::{DataContext, Database};
use serde_json::{Map, Value};
use std::sync::Arc;

pub mod authority;
pub mod chat;
pub mod exports;
pub mod files;
pub mod outputs;
pub mod package;
pub mod recordings;
pub mod section;
pub mod store;

type Work<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + 'a>>;

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
    recordings: Option<Arc<recordings::Recordings>>,
    chat: Arc<dyn chat::MainChat>,
    voice: Arc<dyn chat::VoiceChat>,
}
impl MeetingsPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            recordings: None,
            chat: Arc::new(chat::NoMainChat),
            voice: Arc::new(chat::NoVoiceChat),
        })
    }

    /// Sets where stored recording audio lives, so the account export can include it.
    pub fn with_recordings(mut self, files: &std::path::Path) -> Result<Self> {
        self.recordings = Some(Arc::new(recordings::Recordings::new(&vault::Root::create(files)?)?));
        Ok(self)
    }

    /// Connects the Chat that finished voice recordings are handed to.
    pub fn with_voice_chat(mut self, voice: Arc<dyn chat::VoiceChat>) -> Self {
        self.voice = voice;
        self
    }

    /// Connects the chat that low-confidence side notices are posted to.
    pub fn with_chat(mut self, chat: Arc<dyn chat::MainChat>) -> Self {
        self.chat = chat;
        self
    }

    /// Runs one store operation in the call's shared transaction, so it sees the
    /// module's own typed-query writes from the same call.
    fn run(&self, scope: &CallScope, work: impl for<'a> FnOnce(&'a DataContext) -> Work<'a>) -> Result<Value> {
        let session = join_call_session(&self.database, &self.runtime, scope)?;
        let session = session
            .lock()
            .map_err(|_| anyhow::anyhow!("Meetings store busy"))?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = session.context();
                // A typed query earlier in this call may have selected the module role.
                cx.db().batch_execute("RESET ROLE").await?;
                let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
                cx.db()
                    .query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout])
                    .await?;
                work(cx).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("Meetings store deadline expired"))?
        })
    }

    /// Ring upload files and the per-recording lock that keeps two uploads of one recording apart.
    fn files(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let p: files::Params = serde_json::from_value(request.parameters.clone())?;
        if request.operation == "lock" {
            let key = p.key.ok_or_else(|| anyhow::anyhow!("Lock key required"))?;
            ensure!(key.len() <= 200, "Lock key too long");
            return self.run(scope, move |cx| {
                Box::pin(async move {
                    cx.db()
                        .execute(
                            "SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':meetings.recording-files:' || $1,0))",
                            &[&key],
                        )
                        .await?;
                    Ok(serde_json::json!({"locked": true}))
                })
            });
        }
        let recordings = self.recordings.as_deref().ok_or_else(|| anyhow::anyhow!("Recording storage is not set up"))?;
        files::run(recordings, scope, &request.operation, &p)
    }

    fn store(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let parameters = request.parameters.clone();
        match (request.resource.as_str(), request.operation.as_str()) {
            (store::TRANSCRIPTS, "get") => self.run(scope, move |cx| Box::pin(async move { store::read(cx, &parameters, false).await })),
            (store::TRANSCRIPTS, "lock") => self.run(scope, move |cx| Box::pin(async move { store::read(cx, &parameters, true).await })),
            (store::TRANSCRIPTS, "set") => self.run(scope, move |cx| Box::pin(async move { store::write(cx, &parameters).await })),
            (store::RECORDING_TYPES, "get") => self.run(scope, move |cx| Box::pin(async move { store::recording_types_lock(cx, &parameters, false).await })),
            (store::RECORDING_TYPES, "lock") => self.run(scope, move |cx| Box::pin(async move { store::recording_types_lock(cx, &parameters, true).await })),
            (outputs::OUTPUTS, operation) => {
                let operation = operation.to_owned();
                self.run(scope, move |cx| Box::pin(async move { outputs::run(cx, &operation, &parameters).await }))
            }
            (exports::EXPORTS, "section") => {
                let recordings = self.recordings.clone();
                let access = scope.access().clone();
                self.run(scope, move |cx| {
                    Box::pin(async move { section::collect(cx, recordings.as_deref(), &access).await })
                })
            }
            (exports::EXPORTS, operation) => {
                let operation = operation.to_owned();
                self.run(scope, move |cx| Box::pin(async move { exports::run(cx, &operation, &parameters).await }))
            }
            (store::HISTORY, "get") => self.run(scope, move |cx| Box::pin(async move { store::history(cx, &parameters).await })),
            _ => anyhow::bail!("Unsupported Meetings store operation"),
        }
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
        let session = join_call_session(&self.database, &self.runtime, scope)?;
        let session = session
            .lock()
            .map_err(|_| anyhow::anyhow!("Meetings preferences busy"))?;
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = session.context();
                cx.db().batch_execute("RESET ROLE").await?;
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
                Ok::<_, anyhow::Error>(Value::Object(values))
            })
            .await
            .map_err(|_| anyhow::anyhow!("Meetings preferences deadline expired"))?
        })
    }
}
impl Ports for MeetingsPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        self.invoke_inner(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

impl MeetingsPorts {
    fn invoke_inner(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let ours = [RESOURCE, store::TRANSCRIPTS, store::HISTORY, store::RECORDING_TYPES, outputs::OUTPUTS, exports::EXPORTS, chat::NOTICE, chat::VOICE, files::FILES];
        if port != "kv" || !ours.contains(&request.resource.as_str()) || scope.module().id != "meetings" {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        if request.resource == chat::NOTICE {
            ensure!(request.operation == "post", "Unsupported Meetings chat operation");
            let (text, key) = chat::notice(&request.parameters)?;
            self.chat.post(scope.access().actor_user_id(), text, key)?;
            return Ok(serde_json::json!({"posted": true}));
        }
        if request.resource == chat::VOICE {
            ensure!(request.operation == "hand-off", "Unsupported Meetings voice operation");
            let voice = chat::voice(&request.parameters)?;
            let id = self.voice.hand_off(scope.access().actor_user_id(), &voice)?;
            return Ok(serde_json::json!({"requestId": id}));
        }
        if request.resource == files::FILES {
            return self.files(scope, request);
        }
        if request.resource == RESOURCE {
            self.preferences(scope, request)
        } else {
            self.store(scope, request)
        }
    }
}
