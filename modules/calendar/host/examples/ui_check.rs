//! Disposable, synthetic-account Calendar frame check. Real signed package + database;
//! no application sign-in, production shell, provider or second-device acceptance claim.
#[path = "../tests/support/registry.rs"]
mod registry;
#[path = "../tests/support/mod.rs"]
mod support;
mod ui_http;
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
    ui_http::serve(&app, &f.access(f.a))
}
