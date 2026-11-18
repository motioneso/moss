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

/// A stand-in embedder, so Memory can store a chunk without a real model. It can be made to fail.
#[derive(Default)]
pub struct Embedder(pub std::sync::atomic::AtomicBool);
struct Shared(Arc<Embedder>);
impl moss_memory_host::ports::Embedder for Shared {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(unit())
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        anyhow::ensure!(!self.0 .0.load(std::sync::atomic::Ordering::SeqCst), "embedder down");
        Ok((unit(), ("stand-in".into(), "1".into())))
    }
    fn model(&self, _: &CallScope) -> anyhow::Result<(String, String)> {
        Ok(("stand-in".into(), "1".into()))
    }
}
fn unit() -> Vec<f64> {
    (0..768).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}

pub struct Installed {
    pub app: Application,
    pub macs: Arc<Macs>,
    pub embedder: Arc<Embedder>,
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
    let embedder = Arc::new(Embedder::default());
    let (database, links, shared) = (f.db.clone(), macs.clone(), embedder.clone());
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
            let memory = moss_memory_host::ports::MemoryPorts::new(database.clone(), Arc::new(Shared(shared.clone())), next)?;
            Ok(Arc::new(moss_backtrack_host::BacktrackPorts::new(database, Arc::new(memory))?.with_links(links.clone()))
                as Arc<dyn moss_module_host::runtime::Ports>)
        },
    )
    .unwrap();
    let put = |bytes: &[u8], manifest: moss_module_host::manifest::Manifest, label: &str| {
        let (key, publisher, artifact) = super::registry::publish_as(reg.path(), bytes, manifest, label);
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().join(label)), &key, &publisher, &format!("{label}-test-registry"))
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    };
    // Backtrack requires Memory, which is installed as the real package.
    let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").expect("Run modules/backtrack/tools/check.sh")).unwrap();
    put(&moss_memory_host::package::pack(&root, &core).unwrap(), moss_memory_host::package::manifest().unwrap(), "memory");
    put(&moss_backtrack_host::package::pack(&root, &wasm).unwrap(), moss_backtrack_host::package::manifest().unwrap(), "backtrack");
    Installed { app, macs, embedder, _folders: (dir, reg) }
}
