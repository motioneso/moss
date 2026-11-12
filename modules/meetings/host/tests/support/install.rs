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

/// A package that does nothing, so a module that requires `id` can be installed.
pub fn stand_in(id: &str, wasm: &[u8]) -> (Vec<u8>, moss_module_host::manifest::Manifest) {
    let manifest: moss_module_host::manifest::Manifest = serde_json::from_value(serde_json::json!({
        "schemaVersion": 2, "id": id, "name": id, "description": "A stand-in for a test", "publisher": "Moss",
        "version": "0.1.0", "requiresMoss": ">=0.1.0, <1.0.0", "abi": "moss:module@1", "capabilities": [],
        "icons": [], "accounts": {"supportsUserDisable": false, "defaultEnabled": true}
    }))
    .unwrap();
    let files = std::collections::BTreeMap::from([
        ("moss.module.json".to_owned(), serde_json::to_vec(&manifest).unwrap()),
        ("code/module.wasm".to_owned(), wasm.to_vec()),
        ("LICENSE".to_owned(), b"test".to_vec()),
        ("NOTICE".to_owned(), b"test".to_vec()),
        ("CHANGELOG.md".to_owned(), b"test".to_vec()),
    ]);
    (moss_module_host::archive::pack(&files).unwrap(), manifest)
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
    install_full(f, intelligence, None)
}

/// A stand-in embedder, so Memory can store a fact without a real model.
struct Same;
impl moss_memory_host::ports::Embedder for Same {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(unit())
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        Ok((unit(), ("stand-in".into(), "1".into())))
    }
}
fn unit() -> Vec<f64> {
    (0..768).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}

/// With a chat given, the real Memory package is installed next to Meetings and wired to
/// Meetings' authority, and low-confidence notices go to that chat.
pub fn install_full(
    f: &Fixture,
    intelligence: Arc<dyn moss_module_host::ai::Intelligence>,
    chat: Option<Arc<dyn moss_meetings_host::chat::MainChat>>,
) -> Installed {
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
    let database = f.db.clone();
    let chat_given = chat.is_some();
    let url = || Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap());
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: url(),
            producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence,
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: Some(250_000_000),
        },
        move |next| {
            let Some(chat) = chat.clone() else {
                return Ok(Arc::new(moss_meetings_host::MeetingsPorts::new(database, next)?)
                    as Arc<dyn moss_module_host::runtime::Ports>);
            };
            let authority = Arc::new(moss_meetings_host::authority::MeetingsAuthority::new(database.clone()));
            let memory = moss_memory_host::ports::MemoryPorts::new(database.clone(), Arc::new(Same), next)?
                .with_authority(authority);
            Ok(Arc::new(moss_meetings_host::MeetingsPorts::new(database, Arc::new(memory))?.with_chat(chat))
                as Arc<dyn moss_module_host::runtime::Ports>)
        },
    )
    .unwrap();
    let put = |bytes: &[u8], manifest: moss_module_host::manifest::Manifest, label: &str| {
        let (key, publisher, artifact) = crate::registry::publish_as(reg.path(), bytes, manifest, label);
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, &format!("{label}-test-registry"))
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    };
    // Meetings requires Calendar, People, Tasks and Memory. Calendar, People and Tasks are empty stand-ins
    // because the tests never reach them; Memory is the real package when a chat is given.
    let stand_ins: &[&str] = if chat_given { &["calendar", "people", "tasks"] } else { &["calendar", "people", "tasks", "memory"] };
    for id in stand_ins {
        let (bytes, manifest) = stand_in(id, &wasm);
        put(&bytes, manifest, id);
    }
    if chat_given {
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").expect("Run modules/meetings/tools/check.sh")).unwrap();
        put(&moss_memory_host::package::pack(&root, &core).unwrap(), moss_memory_host::package::manifest().unwrap(), "memory");
    }
    put(&moss_meetings_host::package::pack(&root, &wasm).unwrap(), moss_meetings_host::package::manifest().unwrap(), "meetings");
    Installed { app, _folders: (dir, reg) }
}
