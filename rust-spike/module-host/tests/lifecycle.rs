mod common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::{ModuleList, Source},
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct MemoryCatalog(Mutex<State>);
impl CatalogStore for MemoryCatalog {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        let mut old = self.0.lock().unwrap();
        ensure!(old.revision == expected, "Stale catalog");
        *old = next.clone();
        Ok(())
    }
}
#[test]
fn sample_install_pin_upgrade_remove_and_reinstall_preserves_account_data() {
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let a = keys.write(registry.path(), "1.0.0", 1, vec![]);
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "sample");
    let state = Arc::new(MemoryCatalog::default());
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
    let source = Source::Folder(registry.path().into());
    let root = common::Keys::public(&keys.root);
    let first = common::Keys::public(&keys.root);
    let catalog = installer
        .refresh(&access, source.clone(), &root, &first, "sample-registry")
        .unwrap();
    installer.install(&access, &catalog, &a, true).unwrap();
    let set = r#"{"operation":"set","resource":"counter","parameters":{"count":7}}"#;
    let get = r#"{"operation":"get","resource":"counter","parameters":{}}"#;
    installer
        .call("sample.counter", access.clone(), "route", set)
        .unwrap();
    let other = AccessContext::new(uuid::Uuid::new_v4(), "other-account");
    assert_eq!(
        installer
            .call("sample.counter", other, "route", get)
            .unwrap(),
        "null"
    );
    installer
        .pin(&access, "sample.counter", Some("1.0.0".parse().unwrap()))
        .unwrap();
    let b = keys.write(registry.path(), "1.1.0", 2, vec![]);
    let catalog = installer
        .refresh(&access, source, &root, &first, "sample-registry")
        .unwrap();
    assert!(installer.install(&access, &catalog, &b, false).is_err());
    installer.pin(&access, "sample.counter", None).unwrap();
    installer.install(&access, &catalog, &b, false).unwrap();
    assert_eq!(
        installer
            .call("sample.counter", access.clone(), "route", get)
            .unwrap(),
        r#"{"count":7}"#
    );
    let list = installer.export_list().unwrap();
    assert_eq!(
        ModuleList::parse(&serde_json::to_vec(&list).unwrap())
            .unwrap()
            .modules
            .len(),
        1
    );
    installer.remove(&access, "sample.counter", None).unwrap();
    assert!(installer
        .call("sample.counter", access.clone(), "route", get)
        .is_err());
    installer.install(&access, &catalog, &b, true).unwrap();
    assert_eq!(
        installer
            .call("sample.counter", access.clone(), "route", get)
            .unwrap(),
        r#"{"count":7}"#
    );
    assert!(installer
        .remove(&access, "sample.counter", Some("wrong name"))
        .is_err());
    installer
        .remove(&access, "sample.counter", Some("Sample counter"))
        .unwrap();
    installer.install(&access, &catalog, &b, true).unwrap();
    assert_eq!(
        installer
            .call("sample.counter", access, "route", get)
            .unwrap(),
        "null"
    );
    println!("PASS real signed package → disk install → Wasmtime → account-scoped kv → pin → upgrade → keep-data removal → reinstall → confirmed purge");
}
