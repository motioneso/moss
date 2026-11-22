//! The Connectors package installs from the registry format: a signed index
//! in a folder, the package fetched by its digest, and the manifest checked
//! against the index entry before anything is read.
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    registry::{Artifact, Catalog, Channel, Index, SeenRegistry, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::collections::BTreeMap;

fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_pkcs8(Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap().as_ref()).unwrap()
}
fn public(k: &Ed25519KeyPair) -> String {
    STANDARD.encode(k.public_key().as_ref())
}
fn sign(k: &Ed25519KeyPair, b: &[u8]) -> String {
    STANDARD.encode(k.sign(b).as_ref())
}

fn core() -> Vec<u8> {
    std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("Run modules/connectors/tools/check.sh")).unwrap()
}

#[test]
fn connectors_downloads_from_a_signed_folder_registry() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_connectors_host::package::pack(&root, &core()).unwrap();
    let manifest = moss_connectors_host::package::manifest().unwrap();
    // Ephemeral keys for this disposable registry only; no real credentials.
    let (root_key, index_key, publisher) = (key(), key(), key());
    let digest = trust::digest(&bytes);
    let artifact = Artifact {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        digest: digest.clone(),
        size: bytes.len() as u64,
        publisher_key: "connectors-test".into(),
        signature: sign(&publisher, digest.as_bytes()),
        requires_moss: manifest.requires_moss.clone(),
        abi: manifest.abi.clone(),
        capabilities: manifest.capabilities.clone(),
        migrations: manifest.database.migrations.clone(),
        requires: manifest.requires.clone(),
        changelog: "Work mail capture".into(),
        channel: Channel::Stable,
        urgent: false,
    };
    let identity = RegistryIdentity {
        id: "connectors-test-registry".into(),
        name: "Connectors test registry".into(),
        root_fingerprint: trust::digest(root_key.public_key().as_ref()),
        index_keys: BTreeMap::from([("online".into(), public(&index_key))]),
        publishers: BTreeMap::from([(
            "connectors-test".into(),
            Publisher { key: public(&publisher), prefix: String::new(), replaces: Default::default() },
        )]),
        lifted_revocations: Default::default(),
    };
    let listing = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: vec![artifact.clone()],
        revoked: vec![],
    };
    let folder = tempfile::tempdir().unwrap();
    for (name, data, signer) in [
        ("registry.json", serde_json::to_vec(&identity).unwrap(), &root_key),
        ("index.json", serde_json::to_vec(&listing).unwrap(), &index_key),
    ] {
        std::fs::write(folder.path().join(name), &data).unwrap();
        std::fs::write(folder.path().join(format!("{name}.sig")), sign(signer, &data)).unwrap();
    }
    std::fs::create_dir(folder.path().join("packages")).unwrap();
    std::fs::write(folder.path().join(format!("packages/{digest}.mosspkg")), &bytes).unwrap();

    let mut seen = SeenRegistry::default();
    let catalog = Catalog::fetch(
        Source::Folder(folder.path().into()),
        &public(&root_key),
        &public(&publisher),
        &mut seen,
    )
    .unwrap();
    let installed = BTreeMap::from([
        ("email".to_string(), "0.4.0".parse().unwrap()),
        ("calendar".to_string(), "0.30.0".parse().unwrap()),
    ]);
    let chosen = catalog.select("connectors", None, &"0.1.0".parse().unwrap(), &installed, &seen).unwrap();
    let package = catalog.download(chosen, &"0.1.0".parse().unwrap()).unwrap();
    assert_eq!(package.manifest.id, "connectors");
    assert_eq!(package.manifest.version, "0.7.2".parse().unwrap());
    assert!(package.files.contains_key("code/module.wasm"));
    moss_module_host::sql::check(&package, &Default::default()).unwrap();

    // A tampered package no longer matches its digest and is refused.
    let mut bad = bytes.clone();
    bad.push(0);
    assert!(catalog.read_download(chosen, &bad, &"0.1.0".parse().unwrap()).is_err());
}
