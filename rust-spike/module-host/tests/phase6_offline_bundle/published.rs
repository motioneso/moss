use super::*;
use moss_module_host::{
    archive,
    manifest::Manifest,
    registry::{Artifact, Channel, Index},
};
use std::{collections::BTreeMap, path::Path};
pub fn publish(
    keys: &common::Keys,
    folder: &Path,
    version: &str,
    serial: u64,
    capability: bool,
    migration: bool,
    expired: bool,
) -> Artifact {
    let mut manifest: Manifest = common::manifest(version);
    manifest.id = "tasks".into();
    if capability {
        manifest.capabilities[0].operations.insert("delete".into());
    }
    if migration {
        manifest
            .database
            .migrations
            .push("sql/0001_marker.sql".into());
        manifest
            .database
            .owned_tables
            .push("app.tasks_marker".into());
    }
    let mut files = common::files(&manifest);
    if migration {
        files.insert(
            "sql/0001_marker.sql".into(),
            b"CREATE TABLE app.tasks_marker (id uuid PRIMARY KEY)".to_vec(),
        );
    }
    let bytes = archive::pack(&files).unwrap();
    let digest = trust::digest(&bytes);
    let artifact = Artifact {
        presentation: None,
        id: "tasks".into(),
        version: manifest.version.clone(),
        digest: digest.clone(),
        size: bytes.len() as u64,
        publisher_key: "first-party".into(),
        signature: common::Keys::sign(&keys.publisher, digest.as_bytes()),
        requires_moss: manifest.requires_moss.clone(),
        abi: manifest.abi.clone(),
        capabilities: manifest.capabilities.clone(),
        migrations: manifest.database.migrations.clone(),
        requires: BTreeMap::new(),
        changelog: "Fixture update".into(),
        channel: Channel::Stable,
        urgent: capability || migration,
    };
    let identity = serde_json::json!({"id":"moss","name":"Moss fixture","rootFingerprint":trust::digest(&base64::Engine::decode(&base64::engine::general_purpose::STANDARD,common::Keys::public(&keys.root)).unwrap()),"indexKeys":{"online":common::Keys::public(&keys.index)},"publishers":{"first-party":{"prefix":"","key":common::Keys::public(&keys.publisher)}}});
    let index = Index {
        publish_reviews: Default::default(),
        serial,
        expires: chrono::Utc::now() + chrono::Duration::days(if expired { -1 } else { 1 }),
        signing_key: "online".into(),
        modules: vec![artifact.clone()],
        revoked: vec![],
    };
    std::fs::create_dir_all(folder.join("packages")).unwrap();
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
        std::fs::write(folder.join(name), &bytes).unwrap();
        std::fs::write(
            folder.join(format!("{name}.sig")),
            common::Keys::sign(key, &bytes),
        )
        .unwrap();
    }
    std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes).unwrap();
    artifact
}
