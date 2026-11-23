use super::common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    archive,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    local_packages::LocalPackages,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Saved(pub Mutex<Vec<u8>>);
impl CatalogStore for Saved {
    fn load(&self) -> Result<State> {
        let bytes = self.0.lock().unwrap();
        Ok(if bytes.is_empty() {
            State::default()
        } else {
            serde_json::from_slice(&bytes)?
        })
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        ensure!(self.load()?.revision == expected, "stale catalog");
        *self.0.lock().unwrap() = serde_json::to_vec(next)?;
        Ok(())
    }
}
pub struct Fixture {
    pub data: tempfile::TempDir,
    pub saved: Arc<Saved>,
    pub owner: AccessContext,
    pub other: AccessContext,
    pub admin: AccessContext,
    pub signer: LocalPackages,
    pub id: String,
    pub cipher: Arc<safety_core::secret::SecretCipher>,
}
impl Fixture {
    pub fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let paths =
            keystore::store::Paths::under(&data.path().join("config"), &data.path().join("data"));
        keystore::store::set_up(
            &paths,
            &keystore::probe::Keychain::NotInstalled,
            &keystore::recovery::RecoveryKey::generate(),
            &keystore::store::CredentialKeys::generate(),
        )
        .unwrap();
        let owner = AccessContext::new(uuid::Uuid::new_v4(), "builder");
        Self {
            id: format!("local.{}.counter", owner.actor_user_id()),
            cipher: Arc::new(
                safety_core::secret::SecretCipher::connectors(
                    &[(
                        "JARVIS_CONNECTOR_SECRET_KEY".into(),
                        format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
                    )]
                    .into(),
                )
                .unwrap(),
            ),
            data,
            saved: Arc::default(),
            owner,
            other: AccessContext::new(uuid::Uuid::new_v4(), "second-account"),
            admin: AccessContext::new(uuid::Uuid::new_v4(), "instance-admin"),
            signer: LocalPackages::new(paths),
        }
    }
    pub fn open(&self) -> Arc<Installer> {
        let services = Arc::new(
            moss_module_host::services::ServicePorts::new(
                self.data.path(),
                self.cipher.clone(),
                Arc::new(NoAi),
                Arc::new(LocalPorts::new(self.data.path()).unwrap()),
            )
            .unwrap(),
        );
        let host = Arc::new(
            Installer::new(
                self.data.path(),
                self.saved.clone(),
                Arc::new(
                    FileLifecycle::new(self.data.path(), [self.admin.actor_user_id()].into())
                        .unwrap(),
                ),
                Host::new(Limits::default()).unwrap(),
                services.clone(),
                "0.1.0".parse().unwrap(),
                LegacyInventory::default(),
            )
            .unwrap(),
        );
        services.bind(&host);
        host
    }
    pub fn bytes(&self, version: &str) -> Vec<u8> {
        let mut manifest = common::manifest(version);
        manifest.id = self.id.clone();
        manifest
            .provides
            .insert("private.read".into(), "1.0.0".parse().unwrap());
        manifest
            .screens
            .insert("/counter".into(), "ui/index.html".into());
        manifest.navigation.push(serde_json::json!({"id":"counter","label":"PRIVATE-NAV-MARKER","path":"/counter","icon":"package"}));
        manifest.routes.push(
            serde_json::from_value(
                serde_json::json!({"method":"GET","path":"/read","signIn":true}),
            )
            .unwrap(),
        );
        manifest.tools.insert("local.read".into(), serde_json::from_value(serde_json::json!({"description":"PRIVATE-TOOL-MARKER","risk":"read","inputSchema":{"type":"object","properties":{},"required":[]}})).unwrap());
        let mut files = common::files(&manifest);
        let marker = r#"{"status":200,"body":{"marker":"PRIVATE-CODE-MARKER"}}"#;
        let encoded = marker
            .bytes()
            .map(|b| format!("\\{b:02x}"))
            .collect::<String>();
        let source = include_str!("../../sample/module.wat")
            .replace("healthy", &encoded)
            .replace("i32.const 40 i32.const 7", &format!("i32.const 40 i32.const {}", marker.len()))
            .replace("local.get $kind i32.load8_u i32.const 114 i32.eq", "local.get $kind i32.load8_u i32.const 114 i32.eq local.get $payload i32.const 2 i32.add i32.load8_u i32.const 111 i32.eq i32.and");
        files.insert("code/module.wasm".into(), wat::parse_str(source).unwrap());
        files.insert(
            "ui/index.html".into(),
            b"<!doctype html><title>PRIVATE-ASSET-MARKER</title>".to_vec(),
        );
        archive::pack(&files).unwrap()
    }
    pub fn install(&self, host: &Installer, version: &str) {
        let bytes = self.bytes(version);
        let sig = self.signer.sign(&self.owner, &bytes).unwrap();
        host.install_local(&self.owner, &self.signer, &bytes, &sig, true)
            .unwrap();
    }
}

pub struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("No AI")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("No AI")
    }
}
