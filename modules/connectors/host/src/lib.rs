//! Connectors host assembly. It answers the package's `connectors.*` resources with SQL
//! under the signed-in person's row-level security and seals account secrets. The package
//! never sees the person, a connection, SQL or key material.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use portability::secrets::{resolve_keyring, JsonSecretCipher};
use safety_core::db::{DataContext, Database};
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
    finished: AtomicU64,
}

pub mod google;
pub mod package;
pub mod store;

pub const MODULE_ID: &str = "connectors";

pub struct ConnectorsPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    cipher: JsonSecretCipher,
    google: google::GoogleConfig,
    flights: Mutex<HashMap<uuid::Uuid, Arc<Flight>>>,
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
            runtime: tokio::runtime::Runtime::new()?,
            next,
            cipher: connector_cipher(key)?,
            google: google::GoogleConfig::production(),
            flights: Mutex::default(),
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
            // Someone refreshed while this caller waited, so their token is current.
            let force = force && flight.finished.load(Ordering::SeqCst) == seen;
            let cx = DataContext::open(&self.database, access)
                .await
                .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
            let outcome = google::fresh_access_token(&cx, &self.cipher, &self.google, force).await?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
            flight.finished.fetch_add(1, Ordering::SeqCst);
            Ok(outcome)
        })
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
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Connectors data unavailable"))?;
                let result = if request.resource.starts_with("connectors.google-") {
                    google::run(&cx, &self.cipher, &self.google, request).await?
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
