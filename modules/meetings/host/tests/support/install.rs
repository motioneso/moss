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
    moss_meetings_host::package::stand_in(id, wasm).unwrap()
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
    fn model(&self, _: &CallScope) -> anyhow::Result<(String, String)> {
        Ok(("stand-in".into(), "1".into()))
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
    install_ring(f, intelligence, chat, None)
}

/// Where stored recording files live and the Chat that finished voice recordings go to.
pub type Ring = (std::path::PathBuf, Arc<dyn moss_meetings_host::chat::VoiceChat>);

pub fn install_ring(
    f: &Fixture,
    intelligence: Arc<dyn moss_module_host::ai::Intelligence>,
    chat: Option<Arc<dyn moss_meetings_host::chat::MainChat>>,
    ring: Option<Ring>,
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
            let authority = Arc::new(moss_meetings_host::authority::MeetingsAuthority::new(database.clone()));
            let memory = moss_memory_host::ports::MemoryPorts::new(database.clone(), Arc::new(Same), next)?
                .with_authority(authority);
            let mut ports = moss_meetings_host::MeetingsPorts::new(database, Arc::new(memory))?;
            if let Some((files, voice)) = ring.clone() {
                ports = ports.with_recordings(&files)?.with_voice_chat(voice);
            }
            Ok(match chat.clone() {
                Some(chat) => Arc::new(ports.with_chat(chat)) as Arc<dyn moss_module_host::runtime::Ports>,
                None => Arc::new(ports),
            })
        },
    )
    .unwrap();
    let put = |bytes: &[u8], manifest: moss_module_host::manifest::Manifest, label: &str| {
        let (key, publisher, artifact) = crate::registry::publish_as(reg.path(), bytes, manifest, label);
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().join(label)), &key, &publisher, &format!("{label}-test-registry"))
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
    };
    // Meetings requires Calendar, People, Tasks, Notes and Memory. Calendar, People, Tasks and Notes are empty stand-ins
    // because the tests never reach them; Memory is the real package.
    for id in ["calendar", "people", "tasks", "notes"] {
        let (bytes, manifest) = stand_in(id, &wasm);
        put(&bytes, manifest, id);
    }
    {
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").expect("Run modules/meetings/tools/check.sh")).unwrap();
        put(&moss_memory_host::package::pack(&root, &core).unwrap(), moss_memory_host::package::manifest().unwrap(), "memory");
    }
    put(&moss_meetings_host::package::pack(&root, &wasm).unwrap(), moss_meetings_host::package::manifest().unwrap(), "meetings");
    Installed { app, _folders: (dir, reg) }
}
