mod common;
use access_context::AccessContext;
use moss_module_host::{
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::Source,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Catalog(Mutex<State>);
impl CatalogStore for Catalog {
    fn load(&self) -> anyhow::Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> anyhow::Result<()> {
        let mut state = self.0.lock().unwrap();
        anyhow::ensure!(state.revision == expected, "stale revision");
        *state = next.clone();
        Ok(())
    }
}
#[test]
fn skipped_digest_waits_but_a_later_offer_is_eligible() {
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "update-policy");
    let state = Arc::new(Catalog::default());
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
    let refresh = || {
        installer
            .refresh(
                &access,
                Source::Folder(registry.path().into()),
                &common::Keys::public(&keys.root),
                &common::Keys::public(&keys.publisher),
                "sample-registry",
            )
            .unwrap()
    };
    let first = keys.write(registry.path(), "1.0.0", 1, vec![]);
    installer
        .install(&access, &refresh(), &first, true)
        .unwrap();
    let second = keys.write(registry.path(), "2.0.0", 2, vec![]);
    let catalog = refresh();
    installer
        .skip_update(&access, "sample.counter", &second.digest)
        .unwrap();
    let report = installer.update(&access, &catalog, true).unwrap();
    assert!(report.pending.is_empty() && report.failures.is_empty());
    assert_eq!(
        state.load().unwrap().installed["sample.counter"].digest,
        first.digest,
        "SKIP-DIGEST-MARKER"
    );
    let third = keys.write(registry.path(), "3.0.0", 3, vec![]);
    let report = installer.update(&access, &refresh(), true).unwrap();
    assert!(report.pending.is_empty() && report.failures.is_empty());
    assert_eq!(
        state.load().unwrap().installed["sample.counter"].digest,
        third.digest
    );
}
