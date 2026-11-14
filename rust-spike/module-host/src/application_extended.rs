//! Explicit assembly opt-in for typed, per-invocation transactions and external host adapters.
use crate::{
    application::{Application, Configuration},
    context::ContextPorts,
    database::DatabasePorts,
    jobs::JobPorts,
    local::LocalPorts,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    runtime::{Host, Limits, Ports},
    services::ServicePorts,
    sql::LegacyInventory,
    store::Installer,
    transactional_database::TransactionalDatabasePorts,
};
use access_context::AccessContext;
use anyhow::Result;
use safety_core::db::Database;
use std::{path::Path, sync::Arc};
impl Application {
    pub fn open_extended(
        data: &Path,
        database: Database,
        admin: AccessContext,
        config: Configuration,
    ) -> Result<Self> {
        Self::open_extended_with(data, database, admin, config, Ok)
    }
    /// The adapter receives the existing services and must forward unknown calls and
    /// finish_call. The outer database wrapper finalizes it after DB commit, or with false
    /// after rollback/commit failure. This is a compensation seam, not distributed atomicity.
    pub fn open_extended_with<F>(
        data: &Path,
        database: Database,
        admin: AccessContext,
        config: Configuration,
        adapter: F,
    ) -> Result<Self>
    where
        F: FnOnce(Arc<dyn Ports>) -> Result<Arc<dyn Ports>>,
    {
        let local = Arc::new(LocalPorts::new(data)?);
        let sql = Arc::new(DatabasePorts::new(database.clone(), local)?);
        let jobs = Arc::new(JobPorts::new(config.producer, database.clone(), sql)?);
        let mut services = ServicePorts::new(data, config.cipher, config.intelligence, jobs)?;
        if let Some(dir) = config.browser_dir {
            services = services.with_browser(dir);
        }
        let services = Arc::new(services);
        let deferred = Arc::new(crate::after_commit_jobs::AfterCommitJobs::new(adapter(
            services.clone(),
        )?));
        let context = Arc::new(ContextPorts::new(deferred));
        let ports = Arc::new(TransactionalDatabasePorts::new(database.clone(), context)?);
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
            ports,
            config.version,
            LegacyInventory::default(),
        )?);
        services.bind(&installer);
        Ok(Self {
            installer,
            services,
        })
    }
    pub fn dispatch_extended(
        &self,
        access: AccessContext,
        method: &str,
        path: &str,
        body: &str,
    ) -> Result<String> {
        self.installer.dispatch_extended(access, method, path, body)
    }
    pub fn dispatch_extended_from(
        &self,
        access: AccessContext,
        method: &str,
        path: &str,
        body: &str,
        client: Option<std::net::IpAddr>,
    ) -> Result<String> {
        self.installer.dispatch_extended_from(access, method, path, body, client)
    }
}
