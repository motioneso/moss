mod common;
use moss_module_host::{
    registry::{Catalog, ModuleList, Revocation, RevocationLevel, SeenRegistry, Source},
    trust::{self, TrustedRegistry},
};
use std::collections::BTreeMap;
#[test]
fn signed_registry_verifies_downloads_and_rejects_replay() {
    let dir = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(dir.path(), "1.0.0", 2, vec![]);
    let source = Source::Folder(dir.path().into());
    let mut seen = SeenRegistry::default();
    let root = common::Keys::public(&keys.root);
    let first = common::Keys::public(&keys.publisher);
    let catalog = Catalog::fetch(source.clone(), &root, &first, &mut seen).unwrap();
    catalog
        .select(
            "sample.counter",
            None,
            &"0.1.0".parse().unwrap(),
            &BTreeMap::new(),
            &seen,
        )
        .unwrap();
    assert_eq!(
        catalog
            .download(&artifact, &"0.1.0".parse().unwrap())
            .unwrap()
            .manifest
            .id,
        "sample.counter"
    );
    keys.write(dir.path(), "1.0.0", 1, vec![]);
    assert!(Catalog::fetch(source, &root, &first, &mut seen).is_err());
    assert_eq!(seen.serial, 2);
}
#[test]
fn a_registry_root_cannot_change_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(dir.path(), "1.0.0", 1, vec![]);
    let source = Source::Folder(dir.path().into());
    let first = common::Keys::public(&keys.publisher);
    let mut seen = SeenRegistry::default();
    Catalog::fetch(
        source.clone(),
        &common::Keys::public(&keys.root),
        &first,
        &mut seen,
    )
    .unwrap();
    let mut seen: SeenRegistry =
        serde_json::from_slice(&serde_json::to_vec(&seen).unwrap()).unwrap();
    let original_root = seen.root_fingerprint.clone();
    let replacement = common::Keys::new();
    replacement.write(dir.path(), "1.0.0", 2, vec![]);
    assert!(Catalog::fetch(
        source,
        &common::Keys::public(&replacement.root),
        &first,
        &mut seen
    )
    .is_err());
    assert_eq!(seen.root_fingerprint, original_root);
    assert_eq!(seen.serial, 1);
}
#[test]
fn revocation_survives_a_new_index_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let a = keys.write(dir.path(), "1.0.0", 1, vec![]);
    let source = Source::Folder(dir.path().into());
    let mut seen = SeenRegistry::default();
    let root = common::Keys::public(&keys.root);
    let first = common::Keys::public(&keys.publisher);
    keys.write(
        dir.path(),
        "1.0.0",
        2,
        vec![Revocation {
            target: a.digest.clone(),
            reason: "Unsafe package".into(),
            level: RevocationLevel::Block,
        }],
    );
    Catalog::fetch(source.clone(), &root, &first, &mut seen).unwrap();
    let mut seen: SeenRegistry =
        serde_json::from_slice(&serde_json::to_vec(&seen).unwrap()).unwrap();
    keys.write(dir.path(), "1.0.0", 3, vec![]);
    let catalog = Catalog::fetch(source, &root, &first, &mut seen).unwrap();
    assert!(seen.blocked(&a));
    assert!(catalog
        .select(
            "sample.counter",
            None,
            &"0.1.0".parse().unwrap(),
            &BTreeMap::new(),
            &seen
        )
        .is_err());
}
#[test]
fn expired_index_still_records_revocations_but_installs_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(dir.path(), "1.0.0", 1, vec![]);
    let mut index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("index.json")).unwrap()).unwrap();
    index["expires"] = serde_json::json!("2000-01-01T00:00:00Z");
    let bytes = serde_json::to_vec(&index).unwrap();
    std::fs::write(dir.path().join("index.json"), &bytes).unwrap();
    std::fs::write(
        dir.path().join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    let mut seen = SeenRegistry::default();
    let catalog = Catalog::fetch(
        Source::Folder(dir.path().into()),
        &common::Keys::public(&keys.root),
        &common::Keys::public(&keys.publisher),
        &mut seen,
    )
    .unwrap();
    assert!(catalog
        .select(
            "sample.counter",
            None,
            &"0.1.0".parse().unwrap(),
            &BTreeMap::new(),
            &seen
        )
        .is_err());
}
#[test]
fn publisher_cannot_escape_prefix_even_with_valid_signature() {
    let dir = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(dir.path(), "1.0.0", 1, vec![]);
    let bytes = std::fs::read(dir.path().join("registry.json")).unwrap();
    let sig = std::fs::read_to_string(dir.path().join("registry.json.sig")).unwrap();
    let trust = TrustedRegistry::open(
        &bytes,
        &sig,
        &common::Keys::public(&keys.root),
        &common::Keys::public(&keys.root),
    )
    .unwrap();
    let digest = trust::digest(b"example");
    let signature = common::Keys::sign(&keys.publisher, digest.as_bytes());
    assert!(trust
        .verify_package("sample", "other.counter", &digest, &signature)
        .is_err());
    assert!(trust
        .verify_package("sample", "tasks", &digest, &signature)
        .is_err());
    assert!(TrustedRegistry::open(
        &bytes,
        &sig,
        &common::Keys::public(&keys.index),
        &common::Keys::public(&keys.root)
    )
    .is_err());
}
#[test]
fn list_is_additive_data_with_exact_pins() {
    let list = ModuleList::parse(
        br#"{"modules":[{"id":"sample.counter","registry":"sample-registry","version":"1.0.0"}]}"#,
    )
    .unwrap();
    assert_eq!(list.modules.len(), 1);
    assert!(ModuleList::parse(br#"{"modules":[],"remove":["tasks"]}"#).is_err());
}
#[test]
fn private_addresses_are_not_public_destinations() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "2001:db8::1",
        "192.0.2.1",
    ] {
        assert!(
            !moss_module_host::registry::public_ip(ip.parse().unwrap()),
            "accepted {ip}"
        );
    }
    assert!(moss_module_host::registry::public_ip(
        "8.8.8.8".parse().unwrap()
    ));
}
#[test]
fn mirror_keeps_the_same_signed_bytes_and_works_offline() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(dir.path(), "1.0.0", 1, vec![]);
    let root = common::Keys::public(&keys.root);
    let first = common::Keys::public(&keys.root);
    let mut seen = SeenRegistry::default();
    let catalog =
        Catalog::fetch(Source::Folder(dir.path().into()), &root, &first, &mut seen).unwrap();
    catalog.mirror(mirror.path()).unwrap();
    drop(dir);
    let mirrored = Catalog::fetch(
        Source::Folder(mirror.path().into()),
        &root,
        &first,
        &mut seen,
    )
    .unwrap();
    assert_eq!(
        mirrored
            .download(&artifact, &"0.1.0".parse().unwrap())
            .unwrap()
            .digest,
        artifact.digest
    );
}
