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
            data,
            saved: Arc::default(),
            owner,
            other: AccessContext::new(uuid::Uuid::new_v4(), "second-account"),
            admin: AccessContext::new(uuid::Uuid::new_v4(), "instance-admin"),
            signer: LocalPackages::new(paths),
        }
    }
    pub fn open(&self) -> Installer {
        Installer::new(
            self.data.path(),
            self.saved.clone(),
            Arc::new(
                FileLifecycle::new(self.data.path(), [self.admin.actor_user_id()].into()).unwrap(),
            ),
            Host::new(Limits::default()).unwrap(),
            Arc::new(LocalPorts::new(self.data.path()).unwrap()),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap()
    }
    pub fn bytes(&self, version: &str) -> Vec<u8> {
        let mut manifest = common::manifest(version);
        manifest.id = self.id.clone();
        manifest
            .screens
            .insert("/counter".into(), "ui/index.html".into());
        manifest.navigation.push(serde_json::json!({"id":"counter","label":"PRIVATE-NAV-MARKER","path":"/counter","icon":"package"}));
        let mut files = common::files(&manifest);
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
