//! Host assembly for the authenticated server and worker. The server creates AccessContext
//! from its session before dispatch; request bodies never supply an actor or a connection.
use crate::{
    ai::Intelligence,
    database::DatabasePorts,
    jobs::JobPorts,
    local::LocalPorts,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    runtime::{Host, Limits},
    services::ServicePorts,
    sql::LegacyInventory,
    store::Installer,
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use safety_core::{
    db::Database,
    secret::{Secret, SecretCipher},
};
use std::{path::Path, sync::Arc};
pub struct Configuration {
    pub migrations: Secret,
    pub producer: Secret,
    pub cipher: Arc<SecretCipher>,
    pub intelligence: Arc<dyn Intelligence>,
    pub version: semver::Version,
    pub compiled_cache: Option<(std::path::PathBuf, Secret)>,
    /// Host-wide cap on manifest fuel requests. `None` keeps the default budget.
    pub fuel_ceiling: Option<u64>,
    /// Folder holding the pinned browser. `None` leaves the browser port off, so it answers
    /// `unsupported`.
    pub browser_dir: Option<std::path::PathBuf>,
}
pub struct Application {
    pub installer: Arc<Installer>,
    pub services: Arc<ServicePorts>,
}
impl Application {
    /// Database schema setup belongs to the host's migration bootstrap. Open performs crash
    /// recovery, applied-hash audits and snapshot expiry before returning a serving host.
    pub fn open(
        data: &Path,
        database: Database,
        admin: AccessContext,
        config: Configuration,
    ) -> Result<Self> {
        let local = Arc::new(LocalPorts::new(data)?);
        let sql = Arc::new(DatabasePorts::new(database.clone(), local)?);
        let jobs = Arc::new(JobPorts::new(config.producer, database.clone(), sql)?);
        let mut services = ServicePorts::new(data, config.cipher, config.intelligence, jobs)?;
        if let Some(dir) = config.browser_dir {
            services = services.with_browser(dir);
        }
        let services = Arc::new(services);
        let lifecycle = Arc::new(PostgresLifecycle::new(
            config.migrations,
            database.clone(),
            data,
        )?);
        let catalog = Arc::new(PostgresCatalog::new(database, admin)?);
        let limits = Limits {
            fuel_ceiling: config
                .fuel_ceiling
                .map_or(Limits::default().fuel, |c| c.max(Limits::default().fuel)),
            ..Limits::default()
        };
        let host = match config.compiled_cache {
            Some((path, key)) => Host::cached(limits, &path, key)?,
            None => Host::new(limits)?,
        };
        let installer = Arc::new(Installer::new(
            data,
            catalog,
            lifecycle,
            host,
            services.clone(),
            config.version,
            LegacyInventory::default(),
        )?);
        services.bind(&installer);
        Ok(Self {
            installer,
            services,
        })
    }
    pub fn dispatch(
        &self,
        access: AccessContext,
        method: &str,
        path: &str,
        body: &str,
    ) -> Result<String> {
        self.installer.dispatch(access, method, path, body)
    }
}
impl Installer {
    pub fn set_enabled(&self, access: &AccessContext, id: &str, enabled: bool) -> Result<()> {
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let state = self.catalog.load()?;
        let module = state.installed.get(id).context("Module is not installed")?;
        ensure!(
            module.manifest.accounts.supports_user_disable,
            "This module must stay enabled"
        );
        self.lifecycle.set_account_enabled(id, access, enabled)
    }
    /// Call only from a signed-in server route, with the host's authenticated AccessContext.
    pub fn dispatch(
        &self,
        access: AccessContext,
        method: &str,
        path: &str,
        body: &str,
    ) -> Result<String> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let (id, route) = path
            .strip_prefix("/api/m/")
            .and_then(|s| s.split_once('/'))
            .context("Unknown module route")?;
        let route = format!("/{route}");
        let state = self.catalog.load()?;
        let module = state.installed.get(id).context("Module is not installed")?;
        ensure!(
            module
                .manifest
                .routes
                .iter()
                .any(|r| r.sign_in && r.method == method && r.path == route),
            "Route is not declared"
        );
        let body: serde_json::Value = serde_json::from_str(body)?;
        self.call_unfenced(
            id,
            access,
            "route",
            &serde_json::json!({"method":method,"path":route,"body":body}).to_string(),
        )
    }
}
