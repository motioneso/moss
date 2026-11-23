mod common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    bundle::BundledPackage,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
    trust,
};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Memory(Mutex<State>);
impl CatalogStore for Memory {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        ensure!(state.revision == expected, "Stale catalog");
        *state = next.clone();
        Ok(())
    }
}
#[test]
fn phase6_offline_bundle_installs_without_an_index_or_network() {
    let data = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "bundle");
    let state = Arc::new(Memory::default());
    let installer = Installer::new(
        data.path(),
        state.clone(),
        Arc::new(FileLifecycle::new(data.path(), BTreeSet::from([actor])).unwrap()),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(data.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let mut manifest = common::manifest("1.0.0");
    manifest.id = "tasks".into();
    let bytes = moss_module_host::archive::pack(&common::files(&manifest)).unwrap();
    let digest = trust::digest(&bytes);
    let signature = common::Keys::sign(&keys.publisher, digest.as_bytes());
    let entry = BundledPackage {
        id: "tasks",
        digest: &digest,
        signature: &signature,
    };
    installer
        .install_bundled(
            &access,
            "moss",
            &common::Keys::public(&keys.publisher),
            &entry,
            &bytes,
        )
        .unwrap();
    assert_eq!(
        installer
            .call(
                "tasks",
                access,
                "route",
                r#"{"operation":"get","resource":"counter","parameters":{}}"#
            )
            .unwrap(),
        "null"
    );
    assert!(
        state.load().unwrap().registries.is_empty(),
        "Bootstrap must not manufacture an observed index"
    );
}
