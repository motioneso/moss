use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    registry::{Artifact, Channel, Index},
    trust::{self, Publisher, RegistryIdentity},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{collections::BTreeMap, path::Path};

fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref(),
    )
    .unwrap()
}
fn public(k: &Ed25519KeyPair) -> String {
    STANDARD.encode(k.public_key().as_ref())
}
fn sign(k: &Ed25519KeyPair, b: &[u8]) -> String {
    STANDARD.encode(k.sign(b).as_ref())
}
pub fn publish(folder: &Path, bytes: &[u8]) -> (String, String, Artifact) {
    let (key, publisher, mut artifacts) = publish_packages(folder, &[(bytes, "calendar")]);
    (key, publisher, artifacts.pop().unwrap())
}

pub fn publish_with_tasks(folder: &Path, bytes: &[u8]) -> (String, String, Vec<Artifact>) {
    // Keep the dependency first so callers install it before Calendar.
    let tasks = std::fs::read(
        std::env::var("CALENDAR_TASKS_PACKAGE").expect("Run modules/calendar/tools/gate.sh"),
    )
    .unwrap();
    publish_packages(folder, &[(tasks.as_slice(), "tasks"), (bytes, "calendar")])
}

fn publish_packages(folder: &Path, packages: &[(&[u8], &str)]) -> (String, String, Vec<Artifact>) {
    std::fs::create_dir(folder.join("packages")).unwrap();
    // Ephemeral keys generated for this disposable registry; no production credentials.
    let root = key();
    let index = key();
    let publisher = key();
    let artifacts: Vec<Artifact> = packages
        .iter()
        .copied()
        .map(|(bytes, id)| {
            let digest = trust::digest(bytes);
            let package =
                moss_module_host::archive::Package::read(bytes, &digest, &"0.1.0".parse().unwrap())
                    .unwrap();
            let m = package.manifest;
            assert_eq!(m.id, id);
            std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
            Artifact {
                id: m.id,
                version: m.version,
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: "calendar-test".into(),
                signature: sign(&publisher, digest.as_bytes()),
                requires_moss: m.requires_moss,
                abi: m.abi,
                capabilities: m.capabilities,
                migrations: m.database.migrations,
                requires: m.requires,
                changelog: "Calendar test packages".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "calendar-test-registry".into(),
        name: "Calendar test registry".into(),
        root_fingerprint: trust::digest(root.public_key().as_ref()),
        index_keys: BTreeMap::from([("online".into(), public(&index))]),
        publishers: BTreeMap::from([(
            "calendar-test".into(),
            Publisher {
                key: public(&publisher),
                prefix: "".into(),
                replaces: Default::default(),
            },
        )]),
        lifted_revocations: Default::default(),
    };
    let listing = Index {
        publish_reviews: Default::default(),
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: vec![],
    };
    for (name, data, k) in [
        (
            "registry.json",
            serde_json::to_vec(&identity).unwrap(),
            &root,
        ),
        ("index.json", serde_json::to_vec(&listing).unwrap(), &index),
    ] {
        std::fs::write(folder.join(name), &data).unwrap();
        std::fs::write(folder.join(format!("{name}.sig")), sign(k, &data)).unwrap();
    }
    (public(&root), public(&publisher), artifacts)
}
