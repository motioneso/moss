#![cfg(unix)]
mod common;
use access_context::AccessContext;
use moss_module_host::{archive, local_packages::LocalPackages};
use uuid::Uuid;

fn setup() -> (tempfile::TempDir, keystore::store::Paths) {
    let dir = tempfile::tempdir().unwrap();
    let paths = keystore::store::Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    keystore::store::set_up(
        &paths,
        &keystore::probe::Keychain::NotInstalled,
        &keystore::recovery::RecoveryKey::generate(),
        &keystore::store::CredentialKeys::generate(),
    )
    .unwrap();
    (dir, paths)
}
fn access() -> AccessContext {
    AccessContext::new(Uuid::new_v4(), "local-trust-test")
}
fn bytes(access: &AccessContext) -> Vec<u8> {
    let mut manifest = common::manifest("1.0.0");
    manifest.id = format!("local.{}.counter", access.actor_user_id());
    archive::pack(&common::files(&manifest)).unwrap()
}
#[test]
fn same_install_accepts_and_reopens_the_same_key() {
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let local = LocalPackages::new(paths);
    let signature = local.sign(&owner, &bytes).unwrap();
    let verified = local.verify(&owner, &bytes, &signature).unwrap();
    assert_eq!(
        verified.record().owner_account_id,
        owner.actor_user_id().to_string()
    );
    assert_eq!(verified.record().provenance, "local");
    assert!(!verified.record().registry_reviewed);
    assert_eq!(local.sign(&owner, &bytes).unwrap(), signature);
}
#[test]
fn other_install_is_refused() {
    let (_dir, paths) = setup();
    let (_other, other_paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let first = LocalPackages::new(paths);
    let other = LocalPackages::new(other_paths);
    let signature = first.sign(&owner, &bytes).unwrap();
    other.sign(&owner, &bytes).unwrap();
    assert!(other.verify(&owner, &bytes, &signature).is_err());
}
#[test]
fn renamed_owner_is_refused_even_for_the_same_install() {
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let local = LocalPackages::new(paths);
    let signature = local.sign(&owner, &bytes).unwrap();
    assert!(local.verify(&access(), &bytes, &signature).is_err());
}

fn unchecked_signature(
    paths: &keystore::store::Paths,
    bytes: &[u8],
) -> moss_module_host::local_packages::Signature {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let key = keystore::store::local_signing_key(paths, true).unwrap();
    let digest = moss_module_host::trust::digest(bytes);
    moss_module_host::local_packages::Signature {
        installation_id: key.installation_id().into(),
        key_fingerprint: moss_module_host::trust::digest(
            &STANDARD.decode(key.public_key()).unwrap(),
        ),
        signature: key.sign(digest.as_bytes()),
        digest,
    }
}
#[test]
fn wrong_key_is_refused_even_with_this_installs_labels() {
    let (_dir, paths) = setup();
    let (_other, other_paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let mut signature = unchecked_signature(&paths, &bytes);
    signature.signature = unchecked_signature(&other_paths, &bytes).signature;
    assert!(LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .is_err());
}
#[test]
fn renamed_prefix_is_refused_even_with_a_valid_local_signature() {
    let (_dir, paths) = setup();
    let owner = access();
    let mut manifest = common::manifest("1.0.0");
    // Use a conventional valid id to exercise the local prefix check itself.
    manifest.id = "renamed.counter".into();
    let bytes = archive::pack(&common::files(&manifest)).unwrap();
    let signature = unchecked_signature(&paths, &bytes);
    assert!(LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .is_err());
}
#[test]
fn changed_bytes_are_refused() {
    let (_dir, paths) = setup();
    let owner = access();
    let original = bytes(&owner);
    let signature = unchecked_signature(&paths, &original);
    let mut package = archive::Package::read_for_review(&original, &signature.digest).unwrap();
    package.files.insert("NOTICE".into(), b"changed".to_vec());
    let changed = archive::pack(&package.files).unwrap();
    assert!(LocalPackages::new(paths)
        .verify(&owner, &changed, &signature)
        .is_err());
}
#[test]
fn undeclared_import_is_refused_even_when_signed() {
    let (_dir, paths) = setup();
    let owner = access();
    let mut manifest = common::manifest("1.0.0");
    manifest.id = format!("local.{}.counter", owner.actor_user_id());
    manifest.capabilities.clear();
    let bytes = archive::pack(&common::files(&manifest)).unwrap();
    let signature = unchecked_signature(&paths, &bytes);
    assert!(LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .is_err());
}
#[test]
fn invalid_sql_is_refused_even_when_signed() {
    let (_dir, paths) = setup();
    let owner = access();
    let mut manifest = common::manifest("1.0.0");
    manifest.id = format!("local.{}.counter", owner.actor_user_id());
    manifest.database.migrations = vec!["sql/001_drop.sql".into()];
    let mut files = common::files(&manifest);
    files.insert("sql/001_drop.sql".into(), b"DROP TABLE app.users".to_vec());
    let bytes = archive::pack(&files).unwrap();
    let signature = unchecked_signature(&paths, &bytes);
    let error = LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .err()
        .expect("invalid SQL must be refused");
    assert!(
        error
            .to_string()
            .contains("SQL statement is not part of the module package subset"),
        "{error}"
    );
}
#[test]
fn install_label_cannot_be_renamed() {
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let mut signature = unchecked_signature(&paths, &bytes);
    signature.installation_id = Uuid::new_v4().to_string();
    assert!(LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .is_err());
}
#[test]
fn key_label_cannot_be_renamed() {
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let mut signature = unchecked_signature(&paths, &bytes);
    signature.key_fingerprint = "0".repeat(64);
    assert!(LocalPackages::new(paths)
        .verify(&owner, &bytes, &signature)
        .is_err());
}
#[test]
fn encrypted_key_is_retained_and_damage_does_not_rotate_it() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    unchecked_signature(&paths, &bytes);
    let key_path = paths.bundle.with_file_name("install-local-key.json");
    let encrypted = std::fs::read(&key_path).unwrap();
    let outer: serde_json::Value = serde_json::from_slice(&encrypted).unwrap();
    assert!(outer.get("pkcs8").is_none());
    assert!(!String::from_utf8(encrypted)
        .unwrap()
        .contains("moss-install-local-key-v1"));
    assert_eq!(
        std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::write(&key_path, b"damaged").unwrap();
    assert!(LocalPackages::new(paths).sign(&owner, &bytes).is_err());
    assert_eq!(std::fs::read(&key_path).unwrap(), b"damaged");
}
#[test]
fn local_namespace_cannot_claim_registry_review() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use moss_module_host::trust::{Publisher, RegistryIdentity, TrustedRegistry};
    use ring::signature::KeyPair;
    let keys = common::Keys::new();
    let identity = RegistryIdentity {
        id: "registry".into(),
        name: "Registry".into(),
        root_fingerprint: moss_module_host::trust::digest(keys.root.public_key().as_ref()),
        index_keys: Default::default(),
        lifted_revocations: Default::default(),
        publishers: std::collections::BTreeMap::from([(
            "local".into(),
            Publisher {
                key: STANDARD.encode(keys.publisher.public_key().as_ref()),
                prefix: "local".into(),
                replaces: Default::default(),
            },
        )]),
    };
    let bytes = serde_json::to_vec(&identity).unwrap();
    let trust = TrustedRegistry::open(
        &bytes,
        &common::Keys::sign(&keys.root, &bytes),
        &common::Keys::public(&keys.root),
        &common::Keys::public(&keys.publisher),
    )
    .unwrap();
    assert!(trust
        .publisher("local", &format!("local.{}.counter", Uuid::new_v4()))
        .is_err());
}
#[path = "phase6_local_trust/server.rs"]
mod server;
#[test]
fn concurrent_first_signing_retains_one_install_key() {
    let (_dir, paths) = setup();
    let owner = access();
    let bytes = bytes(&owner);
    let config = paths
        .key_folder
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let data = paths
        .bundle
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let signatures = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let paths = keystore::store::Paths::under(&config, &data);
                    LocalPackages::new(paths).sign(&owner, &bytes).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(signatures.iter().all(|s| s == &signatures[0]));
}
