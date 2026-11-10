//! Signed, registry-selected Tasks package with the real legacy migration lifecycle.
#![allow(dead_code)]
use crate::common::Keys;
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
    let tasks =
        std::fs::read(std::env::var("JS182_TASKS_PACKAGE").expect("Build JS182_TASKS_PACKAGE"))
            .unwrap();
    let artifacts: Vec<_> = [tasks]
        .into_iter()
        .map(|bytes| {
            let digest = trust::digest(&bytes);
            let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
            let manifest = &package.manifest;
            let artifact = Artifact {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: "tasks-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Tasks installed server fixture".into(),
                channel: Channel::Stable,
                urgent: false,
            };
            std::fs::write(registry.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
            artifact
        })
        .collect();
    let identity = RegistryIdentity {
        id: "tasks-test-registry".into(),
        name: "Tasks test registry".into(),
        root_fingerprint: trust::digest(&base64_public(&keys.root)),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "tasks-test".into(),
            Publisher {
                key: Keys::public(&keys.publisher),
                prefix: String::new(),
                replaces: BTreeSet::new(),
            },
        )]),
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
            "tasks-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer
            .install(admin, &source, artifact, true)
            .unwrap_or_else(|error| panic!("Installing {}: {error:#}", artifact.id));
    }
    installer
}
fn base64_public(key: &ring::signature::Ed25519KeyPair) -> Vec<u8> {
    use ring::signature::KeyPair;
    key.public_key().as_ref().to_vec()
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
        // The installed replay must meet the shipping invocation budget, including
        // the largest accepted manual refresh batch.
        Host::new(Limits::default()).unwrap(),
        ports,
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap()
}
