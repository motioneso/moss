//! Disposable signed-in HTTPS Calendar check. Real authentication, package and database;
//! not the full shell, provider execution or a physical second-device acceptance claim.
#[path = "../tests/support/registry.rs"]
mod registry;
#[path = "../tests/support/mod.rs"]
mod support;

use anyhow::Result;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::Value;
use std::sync::Arc;
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No AI in Calendar frame check")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No AI in Calendar frame check")
    }
}
fn main() -> Result<()> {
    let f = support::Fixture::new();
    f.rt.block_on(async{
        f.root.batch_execute(moss_platform_jobs::MIGRATION).await?;
        f.root.batch_execute(moss_module_host::jobs::MIGRATION).await?;
        f.root.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale','{\"timezone\":\"UTC\",\"dateFormat\":\"24\"}')",&[&f.a]).await?;
        f.root.execute("UPDATE app.calendar_events SET title='Calendar package check', starts_at=now() - interval '30 minutes',ends_at=now() + interval '30 minutes' WHERE id=$1",&[&f.event]).await?;
        Ok::<_,anyhow::Error>(())
    })?;
    let data = tempfile::tempdir()?;
    let registry = tempfile::tempdir()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_calendar_host::package::pack(&root, &f.core())?;
    let (key, publisher, artifact) = registry::publish(registry.path(), &bytes);
    let db = f.db.clone();
    let app = Application::open_extended_with(
        data.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL")?),
            producer: Secret::new(std::env::var("JS48_BOOTSTRAP_URL")?),
            cipher: Arc::new(
                SecretCipher::connectors(&Default::default())
                    .map_err(|_| anyhow::anyhow!("Fixture cipher unavailable"))?,
            ),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse()?,
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        move |next| Ok(Arc::new(moss_calendar_host::CalendarPorts::new(db, next)?)),
    )?;
    let source = app.installer.refresh(
        &f.access(f.a),
        Source::Folder(registry.path().into()),
        &key,
        &publisher,
        "calendar-test-registry",
    )?;
    app.installer
        .install(&f.access(f.a), &source, &artifact, true)?;
    let config_path = std::path::PathBuf::from(std::env::var("CALENDAR_NETWORK_CONFIG")?);
    let config = moss_network::config::Config::read(&config_path).map_err(anyhow::Error::msg)?;
    let shared = std::path::PathBuf::from(std::env::var("CALENDAR_SHARED_DIR")?);
    let info = std::env::var("CALENDAR_FIXTURE_INFO")?;
    std::fs::write(
        info,
        serde_json::to_vec(
            &serde_json::json!({"actor":f.a,"other":f.b,"admin":f.admin,"event":f.event,"email":format!("{}@example.test", f.a),"otherEmail":format!("{}@example.test", f.b)}),
        )?,
    )?;
    let acceptor = moss_network::tls::acceptor(&config.certificate, &config.private_key)
        .map_err(anyhow::Error::msg)?;
    let listen = config.listen;
    let origins = config.origins.clone();
    let platform =
        f.rt.block_on(config.platform())
            .map_err(anyhow::Error::msg)?;
    let network = moss_network::web::Network::new(platform, config, config_path)
        .map_err(anyhow::Error::msg)?;
    let app = Arc::new(app);
    let routes = moss_calendar_host::web::router(app.clone(), network, origins, shared)?;
    let result = f.rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(listen).await?;
        println!("PASS signed Calendar HTTPS listener ready");
        moss_network::tls::serve(listener, acceptor, routes)
            .await
            .map_err(anyhow::Error::msg)
    });
    // Keep the synchronous host alive until aborted connection tasks have dropped their
    // route clones. Its nested runtimes must be dropped outside an async worker.
    f.rt.shutdown_timeout(std::time::Duration::from_secs(5));
    drop(app);
    result
}
