//! Signed, registry-selected People package with the real legacy migration lifecycle.
//! The source provider is an explicit fixture; no upstream delivery is claimed.
#![allow(dead_code)]
use super::common::Keys;
use access_context::AccessContext;
use moss_module_host::{
    archive::Package,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::{Artifact, Channel, Index, Source},
    runtime::{Host, Limits, Ports},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
    trust::{self, Publisher, RegistryIdentity},
};
use safety_core::{db::Database, secret::Secret};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
};

pub fn install(
    data: &Path,
    registry: &Path,
    database: Database,
    admin: &AccessContext,
    ports: Arc<dyn Ports>,
) -> Installer {
    let keys = Keys::new();
    std::fs::create_dir_all(registry.join("packages")).unwrap();
    let people =
        std::fs::read(std::env::var("JS73_PEOPLE_PACKAGE").expect("Build JS73_PEOPLE_PACKAGE"))
            .unwrap();
    let mut provider = common_provider();
    provider
        .provides
        .insert("person-providers".into(), "1.0.0".parse().unwrap());
    let provider = moss_module_host::archive::pack(&super::common::files(&provider)).unwrap();
    let mut consumer = super::common::manifest("1.0.0");
    consumer.id = "people.consumer".into();
    consumer.capabilities = serde_json::from_value(
        serde_json::json!([{"port":"api","operations":["call"],"resources":["people"]}]),
    )
    .unwrap();
    consumer
        .requires
        .insert("people".into(), ">=0.1.0, <1.0.0".parse().unwrap());
    let mut consumer_files = super::common::files(&consumer);
    consumer_files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../../sample/module.wat").replace("moss:module/kv@", "moss:module/api@"),
        )
        .unwrap(),
    );
    let consumer = moss_module_host::archive::pack(&consumer_files).unwrap();
    let artifacts: Vec<_> = [provider, people, consumer]
        .into_iter()
        .map(|bytes| {
            let digest = trust::digest(&bytes);
            let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
            let manifest = &package.manifest;
            if manifest.id == "people" {
                assert_eq!(
                    package.files["code/module.wasm"],
                    std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap(),
                    "Package must contain the tested component"
                );
            }
            let artifact = Artifact {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: if manifest.id.contains('.') {
                    "people-test"
                } else {
                    "core-test"
                }
                .into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "People installed parity fixture".into(),
                channel: Channel::Stable,
                urgent: false,
            };
            std::fs::write(registry.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
            artifact
        })
        .collect();
    let identity = RegistryIdentity {
        id: "people-test-registry".into(),
        name: "People test registry".into(),
        root_fingerprint: trust::digest(&base64_public(&keys.root)),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([
            (
                "people-test".into(),
                Publisher {
                    key: Keys::public(&keys.publisher),
                    prefix: "people".into(),
                    replaces: BTreeSet::new(),
                },
            ),
            (
                "core-test".into(),
                Publisher {
                    key: Keys::public(&keys.publisher),
                    prefix: String::new(),
                    replaces: BTreeSet::new(),
                },
            ),
        ]),
        lifted_revocations: BTreeSet::new(),
    };
    let index = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: vec![],
    };
    for (name, bytes, key) in [
        (
            "registry.json",
            serde_json::to_vec(&identity).unwrap(),
            &keys.root,
        ),
        (
            "index.json",
            serde_json::to_vec(&index).unwrap(),
            &keys.index,
        ),
    ] {
        std::fs::write(registry.join(name), &bytes).unwrap();
        std::fs::write(
            registry.join(format!("{name}.sig")),
            Keys::sign(key, &bytes),
        )
        .unwrap();
    }
    let installer = reopen(data, database, admin, ports);
    let source = installer
        .refresh(
            admin,
            Source::Folder(registry.into()),
            &Keys::public(&keys.root),
            &Keys::public(&keys.publisher),
            "people-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(admin, &source, artifact, true).unwrap();
    }
    installer
}
fn base64_public(key: &ring::signature::Ed25519KeyPair) -> Vec<u8> {
    use ring::signature::KeyPair;
    key.public_key().as_ref().to_vec()
}
fn common_provider() -> moss_module_host::manifest::Manifest {
    let mut manifest = super::common::manifest("1.0.0");
    manifest.id = "person-providers".into();
    manifest
}
pub fn reopen(
    data: &Path,
    database: Database,
    admin: &AccessContext,
    ports: Arc<dyn Ports>,
) -> Installer {
    Installer::new(
        data,
        Arc::new(PostgresCatalog::new(database.clone(), admin.clone()).unwrap()),
        Arc::new(
            PostgresLifecycle::new(
                Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
                database,
                data,
            )
            .unwrap(),
        ),
        Host::new(Limits::default()).unwrap(),
        ports,
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap()
}
pub fn clear_catalog(database: Database, admin: AccessContext) {
    let catalog = PostgresCatalog::new(database, admin).unwrap();
    let old = catalog.load().unwrap();
    catalog
        .commit(
            old.revision,
            &State {
                revision: old.revision + 1,
                ..State::default()
            },
        )
        .unwrap();
}

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("No AI in installed route fixture")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("No embeddings in installed route fixture")
    }
}
pub fn services(data: &Path) -> Arc<moss_module_host::services::ServicePorts> {
    Arc::new(
        moss_module_host::services::ServicePorts::new(
            data,
            Arc::new(safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(moss_module_host::runtime::DenyPorts),
        )
        .unwrap(),
    )
}
