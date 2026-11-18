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
    // Ephemeral keys generated for this disposable registry; no production credentials.
    let root = key();
    let index = key();
    let publisher = key();
    let m = moss_goals_host::package::manifest().unwrap();
    let digest = trust::digest(bytes);
    let artifact = Artifact {
        id: m.id.clone(),
        version: m.version.clone(),
        digest: digest.clone(),
        size: bytes.len() as u64,
        publisher_key: "goals-test".into(),
        signature: sign(&publisher, digest.as_bytes()),
        requires_moss: m.requires_moss,
        abi: m.abi,
        capabilities: m.capabilities,
        migrations: m.database.migrations,
        requires: m.requires,
        changelog: "News package".into(),
        channel: Channel::Stable,
        urgent: false,
    };
    let identity = RegistryIdentity {
        id: "goals-test-registry".into(),
        name: "News test registry".into(),
        root_fingerprint: trust::digest(root.public_key().as_ref()),
        index_keys: BTreeMap::from([("online".into(), public(&index))]),
        publishers: BTreeMap::from([(
            "goals-test".into(),
            Publisher {
                key: public(&publisher),
                prefix: "".into(),
                replaces: Default::default(),
            },
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
    std::fs::create_dir(folder.join("packages")).unwrap();
    std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
    (public(&root), public(&publisher), artifact)
}
