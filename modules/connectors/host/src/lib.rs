//! Connectors host assembly. It answers the package's `connectors.*` resources with SQL
//! under the signed-in person's row-level security and seals account secrets. The package
//! never sees the person, a connection, SQL or key material.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use portability::secrets::{resolve_keyring, JsonSecretCipher};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

/// One refresh at a time per person. A caller that waited behind a refresh uses its result.
#[derive(Default)]
struct Flight {
    lock: tokio::sync::Mutex<()>,
    /// Counts refreshes that reached Google.
    finished: AtomicU64,
    /// The answer of the latest refresh that reached Google.
    last: Mutex<Option<std::result::Result<String, google::RefreshFailure>>>,
}

pub mod google;
pub mod google_parse;
pub mod google_sync;
pub mod imap;
pub mod imap_sync;
pub mod live;
pub mod mail_probe;
pub mod outlook_scan;
pub mod package;
pub mod refresh;
pub mod store;
pub mod write;

pub const MODULE_ID: &str = "connectors";

pub struct ConnectorsPorts {
    database: Database,
    /// Worker-role connection for the refresh steps that write progress counts.
    worker: Option<Database>,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    cipher: JsonSecretCipher,
    google: google::GoogleConfig,
    mail: imap::MailConfig,
    flights: Mutex<HashMap<uuid::Uuid, Arc<Flight>>>,
    runs: google_sync::SyncRuns,
    outlook: Option<outlook_scan::OutlookBinding>,
    outlook_runs: outlook_scan::OutlookRuns,
}

/// The cipher the old server used for connector secrets, from the same key setting.
pub fn connector_cipher(key: &str) -> Result<JsonSecretCipher> {
    let env = [("JARVIS_CONNECTOR_SECRET_KEY".to_string(), key.to_string())].into();
    let ring = resolve_keyring(
        "JARVIS_CONNECTOR_SECRET_KEY",
        "JARVIS_CONNECTOR_SECRET_KEY_ID",
        "JARVIS_CONNECTOR_SECRET_KEYS",
        "jarv1s-development-connector-secret",
        &env,
    )
    .map_err(|_| anyhow::anyhow!("Invalid connector key"))?;
    Ok(JsonSecretCipher::new(ring, "connector secret"))
}

impl ConnectorsPorts {
    pub fn new(database: Database, next: Arc<dyn Ports>, key: &str) -> Result<Self> {
        Ok(Self {
            database,
            worker: None,
            runtime: tokio::runtime::Runtime::new()?,
            next,
            cipher: connector_cipher(key)?,
            google: google::GoogleConfig::production(),
            mail: imap::MailConfig::production(),
            flights: Mutex::default(),
            runs: google_sync::SyncRuns::default(),
            outlook: None,
            outlook_runs: outlook_scan::OutlookRuns::default(),
        })
    }

    /// A token for the person's Google account, refreshed when close to expiry. Concurrent
    /// callers for one person share a single refresh. Syncing calls this. It never reaches the package.
    pub fn fresh_google_access_token(
        &self,
        access: &access_context::AccessContext,
        force: bool,
    ) -> Result<std::result::Result<String, google::RefreshFailure>> {
        let flight = Arc::clone(
            self.flights
                .lock()
                .expect("flights")
                .entry(access.actor_user_id())
                .or_default(),
        );
        self.runtime.block_on(async {
            let seen = flight.finished.load(Ordering::SeqCst);
            let _turn = flight.lock.lock().await;
            // A refresh reached Google while this caller waited, so its answer is current,
            // whether it gave a token or a failure.
            if flight.finished.load(Ordering::SeqCst) != seen {
                if let Some(shared) = flight.last.lock().expect("last").clone() {
                    return Ok(shared);
                }
            }
            let cx = DataContext::open(&self.database, access)
                .await
                .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
            let (outcome, refreshed) =
                google::fresh_access_token_traced(&cx, &self.cipher, &self.google, force).await?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
            if refreshed {
                *flight.last.lock().expect("last") = Some(outcome.clone());
                flight.finished.fetch_add(1, Ordering::SeqCst);
            }
            Ok(outcome)
        })
    }

    /// Runs the refresh progress steps on a worker-role connection. Row-level security still
    /// limits every row to the signed-in person, and the app role may not write these columns.
    pub fn with_worker(mut self, worker: Database) -> Self {
        self.worker = Some(worker);
        self
    }

    /// Opens the worker-role connection from its URL. Safe to call from async code.
    pub fn with_worker_url(self, url: &str) -> Result<Self> {
        let worker = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    self.runtime
                        .block_on(Database::connect(url, 4, RuntimeRole::Worker))
                })
                .join()
                .map_err(|_| anyhow::anyhow!("Worker connection failed"))?
                .map_err(|_| anyhow::anyhow!("Connectors worker database unavailable"))
        })?;
        Ok(self.with_worker(worker))
    }

    /// Points the mail login test at stand-in servers. Only for tests and the test-only setting.
    pub fn with_mail(mut self, mail: imap::MailConfig) -> Self {
        self.mail = mail;
        self
    }

    /// Names the one person and Outlook account this machine's helper browser belongs to.
    pub fn with_outlook(mut self, binding: Option<outlook_scan::OutlookBinding>) -> Self {
        self.outlook = binding;
        self
    }

    /// Points Google token requests somewhere else. Only for tests and the test-only setting.
    pub fn with_google(mut self, google: google::GoogleConfig) -> Self {
        self.google = google;
        self
    }
}

impl Ports for ConnectorsPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv"
            || scope.module().id != MODULE_ID
            || !request.resource.starts_with("connectors.")
        {
            return self.next.invoke(scope, port, request);
        }
        moss_module_host::runtime::authorize(scope.module(), port, request)?;
        ensure!(
            !scope.remaining().is_zero(),
            "Connectors deadline expired"
        );
        let database = match (&self.worker, request.resource.as_str()) {
            (
                Some(worker),
                "connectors.refresh-account-start"
                | "connectors.refresh-account-finish"
                | "connectors.refresh-sweep",
            ) => worker,
            _ => &self.database,
        };
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
                let result = if request.resource == "connectors.outlook-binding" {
                    outlook_scan::binding(&self.outlook, scope.access().actor_user_id())
                } else if request.resource == "connectors.outlook-scan" {
                    let run = store::text(&request.parameters, "runId")?.parse()?;
                    outlook_scan::step(&self.outlook, &self.outlook_runs, scope.access().actor_user_id(), run).await?
                } else if request.resource.starts_with("connectors.sync-google-") {
                    google_sync::run(&cx, &self.cipher, &self.google, &self.runs, request).await?
                } else if request.resource.starts_with("connectors.live-")
                    || request.resource == "connectors.context-setup"
                {
                    live::run(&cx, &self.cipher, &self.google, request).await?
                } else if request.resource.starts_with("connectors.write-") {
                    write::run(&cx, &self.cipher, &self.google, &self.mail, request).await?
                } else if request.resource.starts_with("connectors.refresh-") {
                    refresh::run(&cx, request).await?
                } else if request.resource.starts_with("connectors.google-") {
                    google::run(&cx, &self.cipher, &self.google, request).await?
                } else if request.resource.starts_with("connectors.imap-sync-")
                    || request.resource == "connectors.imap-list"
                    || request.resource == "connectors.imap-fetch"
                {
                    imap_sync::run(&cx, &self.cipher, &self.mail, request).await?
                } else if request.resource.starts_with("connectors.imap-") {
                    imap::run(&cx, &self.cipher, &self.mail, request).await?
                } else {
                    store::run(&cx, &self.cipher, request).await?
                };
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
                Ok(result)
            })
            .await
            .map_err(|_| anyhow::anyhow!("Connectors deadline expired"))?
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
