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

#[test]
fn restoring_a_snapshot_cannot_bypass_a_later_cached_revocation() {
    let (f, host) = Fixture::new();
    let update = f.keys.write(f.registry.path(), "2.0.0", 2, vec![]);
    let catalog = f.refresh(&host);
    host.install(&f.a, &catalog, &update, true).unwrap();
    let snapshot = host
        .snapshots(&f.a)
        .unwrap()
        .into_iter()
        .find(|s| s.previous.as_ref().is_some_and(|m| m.digest == f.digest))
        .unwrap();
    f.keys.write(
        f.registry.path(),
        "2.0.0",
        3,
        vec![Revocation {
            target: f.digest.clone(),
            reason: "Unsafe older package".into(),
            level: RevocationLevel::Block,
        }],
    );
    f.refresh(&host);
    host.restore_snapshot(&f.a, &snapshot, "Sample counter", true)
        .unwrap();
    f.assert_calls(&host, true);
}

#[test]
fn a_root_approved_replacement_key_can_serve_while_the_old_key_stays_blocked() {
    let (mut f, host) = Fixture::new();
    let old_key = common::Keys::public(&f.keys.publisher);
    f.keys.write(
        f.registry.path(),
        "1.0.0",
        2,
        vec![Revocation {
            target: "sample".into(),
            reason: "Compromised publisher".into(),
            level: RevocationLevel::Block,
        }],
    );
    f.refresh(&host);
    f.assert_calls(&host, true);
    f.keys.publisher = common::Keys::new().publisher;
    let replacement = f.keys.write(f.registry.path(), "2.0.0", 3, vec![]);
    let unapproved = f.refresh(&host);
    let error = host
        .install(&f.a, &unapproved, &replacement, true)
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Only the registry root may approve a publisher replacement"));

    let path = f.registry.path().join("registry.json");
    let mut identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    identity["publishers"]["sample"]["replaces"] = serde_json::json!([old_key]);
    let bytes = serde_json::to_vec(&identity).unwrap();
    std::fs::write(path, &bytes).unwrap();
    std::fs::write(
        f.registry.path().join("registry.json.sig"),
        common::Keys::sign(&f.keys.root, &bytes),
    )
    .unwrap();
    let catalog = f.refresh(&host);
    f.assert_calls(&host, true);
    host.install(&f.a, &catalog, &replacement, true).expect(
        "root-approved replacement must be installable without lifting the compromised key",
    );
    assert_eq!(
        host.call("sample.counter", f.a.clone(), "health", "{}")
            .unwrap(),
        "healthy"
    );
    drop(host);
    std::fs::remove_dir_all(f.registry.path()).unwrap();
    let host = f.open();
    assert_eq!(
        host.call("sample.counter", f.b.clone(), "health", "{}")
            .unwrap(),
        "healthy"
    );
}

#[test]
fn a_compromised_publisher_key_cannot_escape_through_another_alias() {
    let (f, host) = Fixture::new();
    f.keys.write(
        f.registry.path(),
        "1.0.0",
        2,
        vec![Revocation {
            target: "sample".into(),
            reason: "Compromised publisher".into(),
            level: RevocationLevel::Block,
        }],
    );
    f.refresh(&host);
    let mut artifact = f.keys.write(f.registry.path(), "2.0.0", 3, vec![]);
    artifact.publisher_key = "another-alias".into();
    let path = f.registry.path().join("registry.json");
    let mut identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    identity["publishers"]["another-alias"] = identity["publishers"]["sample"].clone();
    let bytes = serde_json::to_vec(&identity).unwrap();
    std::fs::write(path, &bytes).unwrap();
    std::fs::write(
        f.registry.path().join("registry.json.sig"),
        common::Keys::sign(&f.keys.root, &bytes),
    )
    .unwrap();
    let path = f.registry.path().join("index.json");
    let mut index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    index["modules"][0] = serde_json::to_value(&artifact).unwrap();
    let bytes = serde_json::to_vec(&index).unwrap();
    std::fs::write(path, &bytes).unwrap();
    std::fs::write(
        f.registry.path().join("index.json.sig"),
        common::Keys::sign(&f.keys.index, &bytes),
    )
    .unwrap();
    let catalog = f.refresh(&host);
    assert!(
        host.install(&f.a, &catalog, &artifact, true).is_err(),
        "a publisher alias must not hide a revoked signing key"
    );
    let bytes = common::bytes("2.0.0");
    assert!(
        host.import_file(
            &f.a,
            &catalog,
            &bytes,
            &common::Keys::sign(
                &f.keys.publisher,
                moss_module_host::trust::digest(&bytes).as_bytes()
            ),
            "another-alias",
            true
        )
        .is_err(),
        "file import must reject the same compromised key"
    );
}

fn manual_off(f: &Fixture) {
    let mut state = f.saved.load().unwrap();
    let revision = state.revision;
    state.installed.get_mut("sample.counter").unwrap().disabled =
        Some("Switched off by an administrator".into());
    state.revision += 1;
    f.saved.commit(revision, &state).unwrap();
}

#[test]
fn updating_preserves_manual_off() {
    let (f, host) = Fixture::new();
    manual_off(&f);
    let update = f.keys.write(f.registry.path(), "2.0.0", 2, vec![]);
    let catalog = f.refresh(&host);
    host.install(&f.a, &catalog, &update, true).unwrap();
    f.assert_calls(&host, true);
    assert_eq!(
        f.saved.load().unwrap().installed["sample.counter"]
            .disabled
            .as_deref(),
        Some("Switched off by an administrator")
    );
}

#[test]
fn restoring_preserves_the_current_manual_off() {
    let (f, host) = Fixture::new();
    let update = f.keys.write(f.registry.path(), "2.0.0", 2, vec![]);
    let catalog = f.refresh(&host);
    host.install(&f.a, &catalog, &update, true).unwrap();
    let snapshot = host
        .snapshots(&f.a)
        .unwrap()
        .into_iter()
        .find(|s| s.previous.as_ref().is_some_and(|m| m.digest == f.digest))
        .unwrap();
    manual_off(&f);
    host.restore_snapshot(&f.a, &snapshot, "Sample counter", true)
        .unwrap();
    f.assert_calls(&host, true);
    assert_eq!(
        f.saved.load().unwrap().installed["sample.counter"]
            .disabled
            .as_deref(),
        Some("Switched off by an administrator")
    );
}

#[test]
fn root_rotation_applies_blocks_and_lifts_at_the_index_read() {
    use moss_module_host::registry_manager::{RegistryConfiguration, RootTransition};
    let (mut f, host) = Fixture::new();
    host.configure_registry(
        &f.a,
        &RegistryConfiguration {
            id: "sample-registry".into(),
            source: Source::Folder(f.registry.path().into()),
            root_key: common::Keys::public(&f.keys.root),
            first_party_key: common::Keys::public(&f.keys.root),
        },
    )
    .unwrap();
    for (serial, blocked) in [(2, true), (3, false)] {
        let next_root = common::Keys::new().root;
        let transition = RootTransition {
            registry: "sample-registry".into(),
            previous_fingerprint: f.saved.load().unwrap().registries["sample-registry"]
                .root_fingerprint
                .clone()
                .unwrap(),
            next_key: common::Keys::public(&next_root),
            serial,
        };
        let document = serde_json::to_vec(&transition).unwrap();
        let signature = common::Keys::sign(&f.keys.root, &document);
        f.keys.root = next_root;
        f.keys.write(
            f.registry.path(),
            "1.0.0",
            serial,
            if blocked {
                vec![Revocation {
                    target: f.digest.clone(),
                    reason: "Unsafe package".into(),
                    level: RevocationLevel::Block,
                }]
            } else {
                vec![]
            },
        );
        if !blocked {
            let path = f.registry.path().join("registry.json");
            let mut identity: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            identity["liftedRevocations"] = serde_json::json!([f.digest]);
            let bytes = serde_json::to_vec(&identity).unwrap();
            std::fs::write(path, &bytes).unwrap();
            std::fs::write(
                f.registry.path().join("registry.json.sig"),
                common::Keys::sign(&f.keys.root, &bytes),
            )
            .unwrap();
        }
        host.rotate_root(&f.a, &document, &signature).unwrap();
        f.assert_calls(&host, blocked);
    }
}
