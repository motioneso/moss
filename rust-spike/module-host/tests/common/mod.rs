#![allow(dead_code)]
pub mod fake_embedding_model;
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive::{pack, Package},
    manifest::Manifest,
    registry::{Artifact, Channel, Index, Revocation},
    trust::{self, Publisher, RegistryIdentity},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
pub fn manifest(version: &str) -> Manifest {
    serde_json::from_value(json!({
        "schemaVersion":2,"id":"sample.counter","name":"Sample counter","description":"Exercises the real module host","publisher":"Sample publisher","version":version,"requiresMoss":">=0.1.0, <1.0.0","abi":"moss:module@1",
        "capabilities":[{"port":"kv","operations":["get","set"],"resources":["counter"]}],
        "icons":["icons/counter.svg"],"accounts":{"supportsUserDisable":true,"defaultEnabled":true},
        "features":[{"remediations":[{"id":"check-permissions","description":"Check the module permissions and registry trust","path":"/settings/modules"}],"id":"sample.counter","description":"Saves a value for the signed-in account through the host's key-value port","errors":[{"code":"module-refused","class":"permission","description":"The host refused this module request","remediationRef":"check-permissions"}]}]
    })).unwrap()
}
pub fn wasm() -> Vec<u8> {
    wat::parse_str(include_str!("../../sample/module.wat")).unwrap()
}
/// Read-only People fixtures declare the component's additional imports without
/// granting resources or connecting services they do not exercise.
pub fn people_job_imports(manifest: &mut Manifest) {
    for (port, operation) in [
        ("kv", "records.get"),
        ("jobs", "enqueue-options"),
        ("api", "call"),
    ] {
        manifest
            .capabilities
            .push(crate_capability(port, operation));
    }
}
fn crate_capability(port: &str, operation: &str) -> moss_module_host::manifest::Capability {
    moss_module_host::manifest::Capability {
        port: port.into(),
        operations: [operation.into()].into(),
        resources: Default::default(),
        allow_private: false,
    }
}
pub fn files(manifest: &Manifest) -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        ("moss.module.json".into(),serde_json::to_vec(manifest).unwrap()),
        ("code/module.wasm".into(),wasm()),
        ("icons/counter.svg".into(),b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M4 12h16\"/></svg>".to_vec()),
        ("LICENSE".into(),b"MIT".to_vec()),("NOTICE".into(),b"Moss sample module".to_vec()),
        ("CHANGELOG.md".into(),b"A counter through the host port.".to_vec()),
    ])
}
pub fn bytes(version: &str) -> Vec<u8> {
    pack(&files(&manifest(version))).unwrap()
}
pub fn package(version: &str) -> Package {
    let bytes = bytes(version);
    Package::read(&bytes, &trust::digest(&bytes), &"0.1.0".parse().unwrap()).unwrap()
}
pub struct Keys {
    pub root: Ed25519KeyPair,
    pub index: Ed25519KeyPair,
    pub publisher: Ed25519KeyPair,
}
impl Keys {
    pub fn new() -> Self {
        fn key() -> Ed25519KeyPair {
            Ed25519KeyPair::from_pkcs8(
                Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .unwrap()
                    .as_ref(),
            )
            .unwrap()
        }
        Self {
            root: key(),
            index: key(),
            publisher: key(),
        }
    }
    pub fn public(key: &Ed25519KeyPair) -> String {
        STANDARD.encode(key.public_key().as_ref())
    }
    pub fn sign(key: &Ed25519KeyPair, bytes: &[u8]) -> String {
        STANDARD.encode(key.sign(bytes).as_ref())
    }
    pub fn write(
        &self,
        folder: &Path,
        version: &str,
        serial: u64,
        revoked: Vec<Revocation>,
    ) -> Artifact {
        std::fs::create_dir_all(folder.join("packages")).unwrap();
        let manifest = manifest(version);
        let bytes = bytes(version);
        let digest = trust::digest(&bytes);
        let artifact = Artifact {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            digest: digest.clone(),
            size: bytes.len() as u64,
            publisher_key: "sample".into(),
            signature: Self::sign(&self.publisher, digest.as_bytes()),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: vec![],
            requires: BTreeMap::new(),
            changelog: "A real host sample".into(),
            channel: Channel::Stable,
            urgent: false,
        };
        let identity = RegistryIdentity {
            id: "sample-registry".into(),
            name: "Sample registry".into(),
            root_fingerprint: trust::digest(self.root.public_key().as_ref()),
            index_keys: BTreeMap::from([("online".into(), Self::public(&self.index))]),
            publishers: BTreeMap::from([(
                "sample".into(),
                Publisher {
                    key: Self::public(&self.publisher),
                    prefix: "sample".into(),
                    replaces: BTreeSet::new(),
                },
            )]),
            lifted_revocations: BTreeSet::new(),
        };
        let index = Index {
            serial,
            expires: chrono::Utc::now() + chrono::Duration::days(1),
            signing_key: "online".into(),
            modules: vec![artifact.clone()],
            revoked,
        };
        for (name, data, key) in [
            (
                "registry.json",
                serde_json::to_vec(&identity).unwrap(),
                &self.root,
            ),
            (
                "index.json",
                serde_json::to_vec(&index).unwrap(),
                &self.index,
            ),
        ] {
            std::fs::write(folder.join(name), &data).unwrap();
            std::fs::write(folder.join(format!("{name}.sig")), Self::sign(key, &data)).unwrap();
        }
        std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
        artifact
    }
}

pub fn unhealthy_source() -> String {
    include_str!("../../sample/module.wat").replace(
        "i32.const 32 i32.const 0 i32.store",
        "i32.const 32 local.get $kind i32.load8_u i32.const 104 i32.eq i32.store",
    )
}
