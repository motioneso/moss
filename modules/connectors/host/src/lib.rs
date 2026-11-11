//! Connectors host assembly. It answers the package's `connectors.*` resources with SQL
//! under the signed-in person's row-level security and seals account secrets. The package
//! never sees the person, a connection, SQL or key material.
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Ports, Request};
use portability::secrets::{resolve_keyring, JsonSecretCipher};
use safety_core::db::{DataContext, Database};
use serde_json::Value;
use std::sync::Arc;

pub mod package;
pub mod store;

pub const MODULE_ID: &str = "connectors";

pub struct ConnectorsPorts {
    database: Database,
    runtime: tokio::runtime::Runtime,
    next: Arc<dyn Ports>,
    cipher: JsonSecretCipher,
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
        })
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
                let result = store::run(&cx, &self.cipher, request).await?;
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
