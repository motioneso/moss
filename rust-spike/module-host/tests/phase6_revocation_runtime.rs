//! Real signed packages and Wasmtime entry points; no network is needed after refresh.
mod common;
#[path = "phase6_revocation_runtime/postgres.rs"]
mod postgres;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    archive::pack,
    frame::AssetPolicy,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::{Catalog, Revocation, RevocationLevel, Source},
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct SavedCatalog(Mutex<Vec<u8>>);
impl CatalogStore for SavedCatalog {
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
struct Fixture {
    data: tempfile::TempDir,
    registry: tempfile::TempDir,
    keys: common::Keys,
    saved: Arc<SavedCatalog>,
    a: AccessContext,
    b: AccessContext,
    digest: String,
}
impl Fixture {
    fn new() -> (Self, Installer) {
        let mut f = Self {
            data: tempfile::tempdir().unwrap(),
            registry: tempfile::tempdir().unwrap(),
            keys: common::Keys::new(),
            saved: Arc::new(SavedCatalog::default()),
            a: AccessContext::new(uuid::Uuid::new_v4(), "revocation-a"),
            b: AccessContext::new(uuid::Uuid::new_v4(), "revocation-b"),
            digest: String::new(),
        };
        f.keys.write(f.registry.path(), "1.0.0", 1, vec![]);
        let host = f.open();
        let catalog = f.refresh(&host);
        let mut manifest = common::manifest("1.0.0");
        manifest
            .screens
            .insert("/counter".into(), "ui/index.html".into());
        let mut files = common::files(&manifest);
        files.insert(
            "ui/index.html".into(),
            b"<!doctype html><title>Counter</title>".to_vec(),
        );
        let bytes = pack(&files).unwrap();
        f.digest = moss_module_host::trust::digest(&bytes);
        host.import_file(
            &f.a,
            &catalog,
            &bytes,
            &common::Keys::sign(&f.keys.publisher, f.digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
        (f, host)
    }
    fn open(&self) -> Installer {
        Installer::new(
            self.data.path(),
            self.saved.clone(),
            Arc::new(
                FileLifecycle::new(self.data.path(), [self.a.actor_user_id()].into()).unwrap(),
            ),
            Host::new(Limits::default()).unwrap(),
            Arc::new(LocalPorts::new(self.data.path()).unwrap()),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap()
    }
    fn refresh(&self, host: &Installer) -> Catalog {
        host.refresh(
            &self.a,
            Source::Folder(self.registry.path().into()),
            &common::Keys::public(&self.keys.root),
            &common::Keys::public(&self.keys.root),
            "sample-registry",
        )
        .unwrap()
    }
    fn assert_calls(&self, host: &Installer, blocked: bool) {
        for account in [&self.a, &self.b] {
            let call = host.call("sample.counter", account.clone(), "health", "{}");
            assert_eq!(
                call.is_err(),
                blocked,
                "guest entry for {}: {call:?}",
                account.request_id()
            );
            let frame = host.screen(account, "sample.counter", "/counter");
            assert_eq!(
                frame.is_err(),
                blocked,
                "frame entry must follow revocation"
            );
        }
        let asset = host.ui_asset(
            "sample.counter",
            &self.digest,
            "ui/index.html",
            &AssetPolicy::new("https://moss.example.test").unwrap(),
        );
        assert_eq!(
            asset.is_err(),
            blocked,
            "cached frame assets must follow revocation"
        );
    }
}

#[test]
fn cached_revocation_is_applied_before_offline_startup_serves_any_account() {
    let (f, host) = Fixture::new();
    f.assert_calls(&host, false);
    drop(host);
    // A cached accepted revocation is authoritative even without a legacy disabled projection.
    let mut saved = f.saved.load().unwrap();
    saved
        .registries
        .get_mut("sample-registry")
        .unwrap()
        .revocations
        .insert(
            f.digest.clone(),
            Revocation {
                target: f.digest.clone(),
                reason: "Unsafe package".into(),
                level: RevocationLevel::Block,
            },
        );
    let before = saved.revision;
    saved.revision += 1;
    f.saved.commit(before, &saved).unwrap();
    std::fs::remove_dir_all(f.registry.path()).unwrap();
    let host = f.open();
    f.assert_calls(&host, true);
}

#[test]
fn a_root_lift_preserves_manual_off_and_journals_only_policy_metadata() {
    let (f, host) = Fixture::new();
    let mut state = f.saved.load().unwrap();
    let revision = state.revision;
    state.installed.get_mut("sample.counter").unwrap().disabled =
        Some("Switched off by an administrator".into());
    state.revision += 1;
    f.saved.commit(revision, &state).unwrap();
    f.keys.write(
        f.registry.path(),
        "1.0.0",
        2,
        vec![Revocation {
            target: f.digest.clone(),
            reason: "Unsafe package".into(),
            level: RevocationLevel::Block,
        }],
    );
    f.refresh(&host);
    f.assert_calls(&host, true);
    let state = f.saved.load().unwrap();
    assert_eq!(
        state.installed["sample.counter"].disabled.as_deref(),
        Some("Switched off by an administrator")
    );
    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(
        json["installed"]["sample.counter"]["revocations"][0]["source"],
        "sample-registry"
    );
    assert_eq!(
        json["installed"]["sample.counter"]["revocations"][0]["reason"],
        "Unsafe package"
    );
    let identity = f.registry.path().join("registry.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&identity).unwrap()).unwrap();
    value["liftedRevocations"] = serde_json::json!([f.digest]);
    let bytes = serde_json::to_vec(&value).unwrap();
    std::fs::write(identity, &bytes).unwrap();
    std::fs::write(
        f.registry.path().join("registry.json.sig"),
        common::Keys::sign(&f.keys.root, &bytes),
    )
    .unwrap();
    f.refresh(&host);
    f.assert_calls(&host, true);
    let mut state = f.saved.load().unwrap();
    assert!(state.installed["sample.counter"].revocations.is_empty());
    assert_eq!(
        state.installed["sample.counter"].disabled.as_deref(),
        Some("Switched off by an administrator")
    );
    let revision = state.revision;
    state.installed.get_mut("sample.counter").unwrap().disabled = None;
    state.revision += 1;
    f.saved.commit(revision, &state).unwrap();
    f.assert_calls(&host, false);
    let json = serde_json::to_value(f.saved.load().unwrap()).unwrap();
    let activity = json["activity"]
        .as_array()
        .expect("durable activity journal");
    assert_eq!(
        activity.len(),
        2,
        "one block and one lift, without duplicate refresh entries"
    );
    assert_eq!(activity[0]["action"], "revoked");
    assert_eq!(activity[1]["action"], "lifted");
    for entry in activity {
        let fields = entry.as_object().unwrap();
        assert!(
            fields.keys().all(|key| [
                "at", "module", "digest", "source", "target", "reason", "level", "action"
            ]
            .contains(&key.as_str())),
            "activity must contain policy metadata only"
        );
    }
}
