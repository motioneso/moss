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
    collections::{BTreeMap, BTreeSet},
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
    // Another trusted registry cannot grant itself replacement authority over A's key.
    let hostile = tempfile::tempdir().unwrap();
    let hostile_keys = common::Keys::new();
    let hostile_artifact = hostile_keys.write(hostile.path(), "2.0.0", 1, vec![]);
    let mut identity: moss_module_host::trust::RegistryIdentity =
        serde_json::from_slice(&std::fs::read(hostile.path().join("registry.json")).unwrap())
            .unwrap();
    identity.id = "other-registry".into();
    identity
        .publishers
        .get_mut("sample")
        .unwrap()
        .replaces
        .insert(common::Keys::public(&keys.publisher));
    let identity = serde_json::to_vec(&identity).unwrap();
    std::fs::write(hostile.path().join("registry.json"), &identity).unwrap();
    std::fs::write(
        hostile.path().join("registry.json.sig"),
        common::Keys::sign(&hostile_keys.root, &identity),
    )
    .unwrap();
    let hostile_catalog = installer
        .refresh(
            &access,
            Source::Folder(hostile.path().into()),
            &common::Keys::public(&hostile_keys.root),
            &first,
            "other-registry",
        )
        .unwrap();
    assert!(installer
        .install(&access, &hostile_catalog, &hostile_artifact, true)
        .is_err());
    assert_eq!(
        state.load().unwrap().installed["sample.counter"].publisher_public_key,
        common::Keys::public(&keys.publisher)
    );

    // Install a genuine second package which the next index no longer lists.
    let mut absent = common::manifest("1.0.0");
    absent.id = "sample.absent".into();
    let absent_bytes = moss_module_host::archive::pack(&common::files(&absent)).unwrap();
    let absent_digest = moss_module_host::trust::digest(&absent_bytes);
    installer
        .import_file(
            &access,
            &catalog,
            &absent_bytes,
            &common::Keys::sign(&keys.publisher, absent_digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    installer
        .pin(&access, "sample.counter", Some("1.0.0".parse().unwrap()))
        .unwrap();
    let stale_catalog = catalog;
    let b = keys.write(registry.path(), "1.1.0", 2, vec![]);
    let catalog = installer
        .refresh(&access, source, &root, &first, "sample-registry")
        .unwrap();
    assert!(installer
        .install(&access, &stale_catalog, &a, true)
        .is_err());
    let mut catalogs = BTreeMap::from([("sample-registry".into(), catalog)]);
    let unpinned_list =
        ModuleList::parse(br#"{"modules":[{"id":"sample.counter","registry":"sample-registry"}]}"#)
            .unwrap();
    installer
        .apply_list(&access, &unpinned_list, &catalogs, false)
        .unwrap();
    assert_eq!(
        state.load().unwrap().installed["sample.counter"]
            .pin
            .as_ref(),
        Some(&"1.0.0".parse().unwrap())
    );
    assert_eq!(
        state.load().unwrap().installed["sample.counter"].digest,
        a.digest
    );
    let catalog = catalogs.remove("sample-registry").unwrap();
    assert!(installer.install(&access, &catalog, &b, false).is_err());
    installer.pin(&access, "sample.counter", None).unwrap();
    let updates = installer.update(&access, &catalog, true).unwrap();
    assert_eq!(updates.failures.len(), 1);
    assert_eq!(updates.failures[0].0, "sample.absent");
    assert_eq!(
        state.load().unwrap().installed["sample.counter"]
            .manifest
            .version,
        b.version
    );
    installer.remove(&access, "sample.absent", None).unwrap();
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
        .install(&access, &hostile_catalog, &hostile_artifact, true)
        .is_err());
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
