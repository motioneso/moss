use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive::pack,
    registry::{Artifact, Channel, Index},
    trust::{self, Publisher, RegistryIdentity},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub struct Registry {
    pub public: String,
    pub artifact: Artifact,
}
impl Registry {
    pub fn create(folder: &Path, files: &BTreeMap<String, Vec<u8>>) -> Self {
        let key = Ed25519KeyPair::from_pkcs8(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let public = STANDARD.encode(key.public_key().as_ref());
        let manifest = moss_notes_checks::manifest().unwrap();
        let bytes = pack(files).unwrap();
        let digest = trust::digest(&bytes);
        let artifact = Artifact {
            id: manifest.id,
            version: manifest.version,
            digest: digest.clone(),
            size: bytes.len() as u64,
            publisher_key: "notes-test".into(),
            signature: STANDARD.encode(key.sign(digest.as_bytes()).as_ref()),
            requires_moss: manifest.requires_moss,
            abi: manifest.abi,
            capabilities: manifest.capabilities,
            migrations: manifest.database.migrations,
            requires: manifest.requires,
            changelog: "Notes guest export checkpoint".into(),
            channel: Channel::Stable,
            urgent: false,
        };
        let identity = RegistryIdentity {
            id: "notes-test-registry".into(),
            name: "Synthetic Notes registry".into(),
            root_fingerprint: trust::digest(key.public_key().as_ref()),
            index_keys: BTreeMap::from([("notes-test".into(), public.clone())]),
            publishers: BTreeMap::from([(
                "notes-test".into(),
                Publisher {
                    key: public.clone(),
                    prefix: String::new(),
                    replaces: BTreeSet::new(),
                },
            )]),
            lifted_revocations: BTreeSet::new(),
        };
        let index = Index {
            serial: 1,
            expires: std::time::SystemTime::now()
                .checked_add(std::time::Duration::from_secs(3600))
                .unwrap()
                .into(),
            signing_key: "notes-test".into(),
            modules: vec![artifact.clone()],
            revoked: vec![],
        };
        std::fs::create_dir_all(folder.join("packages")).unwrap();
        for (name, data) in [
            ("registry.json", serde_json::to_vec(&identity).unwrap()),
            ("index.json", serde_json::to_vec(&index).unwrap()),
        ] {
            std::fs::write(folder.join(name), &data).unwrap();
            std::fs::write(
                folder.join(format!("{name}.sig")),
                STANDARD.encode(key.sign(&data).as_ref()),
            )
            .unwrap();
        }
        std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
        Self { public, artifact }
    }
}
