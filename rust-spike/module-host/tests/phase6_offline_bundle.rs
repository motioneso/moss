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

#[test]
fn bundled_bytes_need_the_compiled_digest_and_signature() {
    let data = tempfile::tempdir().unwrap();
    let actor = uuid::Uuid::new_v4();
    let installer = Installer::new(
        data.path(),
        Arc::new(Memory::default()),
        Arc::new(FileLifecycle::new(data.path(), BTreeSet::from([actor])).unwrap()),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(data.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let keys = common::Keys::new();
    let mut manifest = common::manifest("1.0.0");
    manifest.id = "tasks".into();
    let files = common::files(&manifest);
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    let digest = trust::digest(&bytes);
    let signature = common::Keys::sign(&keys.publisher, digest.as_bytes());
    let entry = BundledPackage {
        id: "tasks",
        digest: &digest,
        signature: &signature,
    };
    let access = AccessContext::new(actor, "bundle");
    let wrong_key = common::Keys::public(&keys.root);
    assert!(
        installer
            .install_bundled(&access, "moss", &wrong_key, &entry, &bytes)
            .is_err(),
        "Expected refusal: wrong publisher signature"
    );
    let mut changed = files;
    changed.insert(
        "NOTICE".into(),
        b"Changed without release approval".to_vec(),
    );
    let changed = moss_module_host::archive::pack(&changed).unwrap();
    assert!(
        installer
            .install_bundled(
                &access,
                "moss",
                &common::Keys::public(&keys.publisher),
                &entry,
                &changed
            )
            .is_err(),
        "Expected refusal: compiled digest"
    );
}

#[test]
fn bootstrap_cannot_replace_an_install_or_bypass_an_observed_registry() {
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "bundle");
    let installer = Installer::new(
        data.path(),
        Arc::new(Memory::default()),
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
    assert!(
        installer
            .install_bundled(
                &access,
                "moss",
                &common::Keys::public(&keys.publisher),
                &entry,
                &bytes
            )
            .is_err(),
        "Expected refusal: existing install"
    );
    installer
        .refresh(
            &access,
            moss_module_host::registry::Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    manifest.id = "finance".into();
    let bytes = moss_module_host::archive::pack(&common::files(&manifest)).unwrap();
    let digest = trust::digest(&bytes);
    let signature = common::Keys::sign(&keys.publisher, digest.as_bytes());
    let entry = BundledPackage {
        id: "finance",
        digest: &digest,
        signature: &signature,
    };
    assert!(
        installer
            .install_bundled(
                &access,
                "moss",
                &common::Keys::public(&keys.publisher),
                &entry,
                &bytes
            )
            .is_err(),
        "Expected refusal: observed registry"
    );
}

#[test]
fn optional_finance_and_meals_are_cached_without_activation() {
    use moss_module_host::bundle::{Bundle, BundleItem};
    let data = tempfile::tempdir().unwrap();
    let actor = uuid::Uuid::new_v4();
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
    let keys = common::Keys::new();
    let bytes: Vec<_> = ["tasks", "finance", "meals"]
        .iter()
        .map(|id| {
            let mut m = common::manifest("1.0.0");
            m.id = (*id).into();
            moss_module_host::archive::pack(&common::files(&m)).unwrap()
        })
        .collect();
    let digests: Vec<_> = bytes.iter().map(|b| trust::digest(b)).collect();
    let signatures: Vec<_> = digests
        .iter()
        .map(|d| common::Keys::sign(&keys.publisher, d.as_bytes()))
        .collect();
    let items: Vec<_> = ["tasks", "finance", "meals"]
        .iter()
        .enumerate()
        .map(|(i, id)| BundleItem {
            package: BundledPackage {
                id,
                digest: &digests[i],
                signature: &signatures[i],
            },
            bytes: &bytes[i],
            default: i == 0,
        })
        .collect();
    let public = common::Keys::public(&keys.publisher);
    Bundle {
        registry: "moss",
        first_party_key: &public,
        packages: &items,
    }
    .bootstrap(&installer, &AccessContext::new(actor, "bundle"))
    .unwrap();
    let installed = state.load().unwrap().installed;
    assert_eq!(installed.keys().collect::<Vec<_>>(), vec!["tasks"]);
    for digest in digests {
        assert!(installer.read_package(&digest).is_ok());
    }
}

#[path = "phase6_offline_bundle/published.rs"]
mod published;
#[test]
fn expired_bundle_then_online_updates_obey_quiet_time_pin_and_added_access_rules() {
    use moss_module_host::registry::{Catalog, SeenRegistry, Source};
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let old = published::publish(&keys, registry.path(), "1.0.0", 1, false, false, true);
    let bytes = std::fs::read(
        registry
            .path()
            .join(format!("packages/{}.mosspkg", old.digest)),
    )
    .unwrap();
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
    let entry = BundledPackage {
        id: "tasks",
        digest: &old.digest,
        signature: &old.signature,
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
    installer
        .call(
            "tasks",
            access.clone(),
            "route",
            r#"{"operation":"set","resource":"counter","parameters":{"count":7}}"#,
        )
        .unwrap();
    let source = Source::Folder(registry.path().into());
    let root = common::Keys::public(&keys.root);
    let first = common::Keys::public(&keys.publisher);
    let mut seen = SeenRegistry::default();
    let expired = Catalog::fetch(source.clone(), &root, &first, &mut seen).unwrap();
    assert!(
        expired
            .select(
                "tasks",
                None,
                &"0.1.0".parse().unwrap(),
                &Default::default(),
                &seen
            )
            .is_err(),
        "Expected refusal: expired online index"
    );
    let version = || {
        state.load().unwrap().installed["tasks"]
            .manifest
            .version
            .to_string()
    };
    published::publish(&keys, registry.path(), "1.1.0", 2, false, false, false);
    let catalog = installer
        .refresh(&access, source.clone(), &root, &first, "moss")
        .unwrap();
    assert!(installer
        .update(&access, &catalog, false)
        .unwrap()
        .failures
        .is_empty());
    assert_eq!(version(), "1.0.0", "Ordinary updates wait for quiet time");
    assert!(installer
        .update(&access, &catalog, true)
        .unwrap()
        .failures
        .is_empty());
    assert_eq!(version(), "1.1.0");
    installer
        .pin(&access, "tasks", Some("1.1.0".parse().unwrap()))
        .unwrap();
    published::publish(&keys, registry.path(), "1.2.0", 3, false, false, false);
    let catalog = installer
        .refresh(&access, source.clone(), &root, &first, "moss")
        .unwrap();
    installer.update(&access, &catalog, true).unwrap();
    assert_eq!(version(), "1.1.0", "Pinned packages stay put");
    installer.pin(&access, "tasks", None).unwrap();
    installer.update(&access, &catalog, true).unwrap();
    assert_eq!(version(), "1.2.0");
    for (version_number, serial, capability, migration) in
        [("1.3.0", 4, true, false), ("1.4.0", 5, false, true)]
    {
        published::publish(
            &keys,
            registry.path(),
            version_number,
            serial,
            capability,
            migration,
            false,
        );
        let catalog = installer
            .refresh(&access, source.clone(), &root, &first, "moss")
            .unwrap();
        let report = installer.update(&access, &catalog, true).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(
            report.pending.len(),
            1,
            "Added access and migrations need review, even when urgent"
        );
        assert_eq!(version(), "1.2.0");
    }
    let value = installer
        .call(
            "tasks",
            access,
            "route",
            r#"{"operation":"get","resource":"counter","parameters":{}}"#,
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&value).unwrap(),
        serde_json::json!({"count":7})
    );
}

#[test]
fn bootstrap_requires_an_admin_the_named_module_and_its_dependencies() {
    let data = tempfile::tempdir().unwrap();
    let actor = uuid::Uuid::new_v4();
    let keys = common::Keys::new();
    let installer = Installer::new(
        data.path(),
        Arc::new(Memory::default()),
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
    let public = common::Keys::public(&keys.publisher);
    assert!(
        installer
            .install_bundled(
                &AccessContext::new(uuid::Uuid::new_v4(), "member"),
                "moss",
                &public,
                &entry,
                &bytes
            )
            .is_err(),
        "Expected refusal: administrator required"
    );
    let wrong = BundledPackage {
        id: "finance",
        digest: &digest,
        signature: &signature,
    };
    let access = AccessContext::new(actor, "bundle");
    assert!(
        installer
            .install_bundled(&access, "moss", &public, &wrong, &bytes)
            .is_err(),
        "Expected refusal: wrong bundled module"
    );
    manifest
        .requires
        .insert("memory".into(), ">=1.0.0".parse().unwrap());
    let bytes = moss_module_host::archive::pack(&common::files(&manifest)).unwrap();
    let digest = trust::digest(&bytes);
    let signature = common::Keys::sign(&keys.publisher, digest.as_bytes());
    let entry = BundledPackage {
        id: "tasks",
        digest: &digest,
        signature: &signature,
    };
    assert!(
        installer
            .install_bundled(&access, "moss", &public, &entry, &bytes)
            .is_err(),
        "Expected refusal: missing dependency"
    );
}

#[path = "phase6_offline_bundle/optional.rs"]
mod optional;
