//! Installs the real Backtrack package into a throwaway module host for a test.
use super::Fixture;
use moss_backtrack_host::link::{Link, MacLinks};
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex}};
use uuid::Uuid;

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Backtrack has no AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Backtrack has no embeddings")
    }
}

/// A stand-in for the paired-Mac check. A person listed here has one linked Mac.
#[derive(Default)]
pub struct Macs(pub Mutex<HashMap<Uuid, Uuid>>);
impl MacLinks for Macs {
    fn resolve(&self, owner: Uuid, _: &str) -> anyhow::Result<Link> {
        Ok(self.0.lock().unwrap().get(&owner).map_or(Link::None, |d| Link::Device(*d)))
    }
}

pub struct Installed {
    pub app: Application,
    pub macs: Arc<Macs>,
    _folders: (tempfile::TempDir, tempfile::TempDir),
}

pub fn install(f: &Fixture) -> Installed {
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
    let wasm = std::fs::read(std::env::var("BACKTRACK_COMPONENT_WASM").expect("Run modules/backtrack/tools/check.sh")).unwrap();
    let macs = Arc::new(Macs::default());
    let (database, links) = (f.db.clone(), macs.clone());
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: Some(250_000_000),
        },
        move |next| {
            Ok(Arc::new(moss_backtrack_host::BacktrackPorts::new(database, next)?.with_links(links.clone()))
                as Arc<dyn moss_module_host::runtime::Ports>)
        },
    )
    .unwrap();
    let bytes = moss_backtrack_host::package::pack(&root, &wasm).unwrap();
    let (key, publisher, artifact) = super::registry::publish_as(reg.path(), &bytes, moss_backtrack_host::package::manifest().unwrap(), "backtrack");
    let source = app
        .installer
        .refresh(&f.access(f.a), Source::Folder(reg.path().join("backtrack")), &key, &publisher, "backtrack-test-registry")
        .unwrap();
    app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    Installed { app, macs, _folders: (dir, reg) }
}
