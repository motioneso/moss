//! Installs the real Meetings package into a throwaway module host for a test.
use super::Fixture;
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
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Meetings has no AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Meetings has no embeddings")
    }
}

/// The installed application plus the folders that must outlive it.
pub struct Installed {
    pub app: Application,
    _folders: (tempfile::TempDir, tempfile::TempDir),
}

pub fn install(f: &Fixture) -> Installed {
    install_with(f, Arc::new(NoAi))
}

pub fn install_with(f: &Fixture, intelligence: Arc<dyn moss_module_host::ai::Intelligence>) -> Installed {
    f.rt.block_on(async {
        let ready: bool = f.root.query_one("SELECT to_regnamespace('moss_queue') IS NOT NULL", &[]).await.unwrap().get(0);
        if !ready {
            f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
            f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        }
    });
    // An earlier test in this database may have installed the package into a folder that is gone.
    f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[])).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let reg = tempfile::tempdir().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let wasm = std::fs::read(std::env::var("MEETINGS_COMPONENT_WASM").expect("Run modules/meetings/tools/check.sh")).unwrap();
    let bytes = moss_meetings_host::package::pack(&root, &wasm).unwrap();
    let (key, publisher, artifact) = crate::registry::publish(reg.path(), &bytes);
    let database = f.db.clone();
    let url = || Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap());
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: url(),
            producer: url(),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence,
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: Some(250_000_000),
        },
        move |next| {
            Ok(Arc::new(moss_meetings_host::MeetingsPorts::new(database, next)?)
                as Arc<dyn moss_module_host::runtime::Ports>)
        },
    )
    .unwrap();
    let source = app
        .installer
        .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "meetings-test-registry")
        .unwrap();
    app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    Installed { app, _folders: (dir, reg) }
}
