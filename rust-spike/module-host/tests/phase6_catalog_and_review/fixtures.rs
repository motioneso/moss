use super::common;
use moss_module_host::{
    archive,
    manifest::Route,
    registry::{Artifact, Index},
    trust,
};
use std::{fs, path::Path};

/// A signed module whose real route returns its health response, independent of external services.
pub fn publish(keys: &common::Keys, folder: &Path, version: &str, serial: u64) -> Artifact {
    publish_update(keys, folder, version, serial, "plain")
}

pub fn publish_update(
    keys: &common::Keys,
    folder: &Path,
    version: &str,
    serial: u64,
    growth: &str,
) -> Artifact {
    let mut artifact = keys.write(folder, version, serial, vec![]);
    let mut manifest = common::manifest(version);
    if growth == "capability" {
        manifest.capabilities[0].resources.insert("extra".into());
    }
    if growth == "migration" {
        manifest.database.migrations.push("sql/001.sql".into());
        manifest
            .database
            .owned_tables
            .push("app.sample_counter_entries".into());
    }
    artifact.capabilities = manifest.capabilities.clone();
    artifact.migrations = manifest.database.migrations.clone();
    artifact.urgent = growth != "plain";
    manifest.routes.push(Route {
        method: "GET".into(),
        path: "/health".into(),
        sign_in: true,
    });
    let mut files = common::files(&manifest);
    let reply = r#"{"status":200,"body":{"live":true}}"#;
    let source = include_str!("../../sample/module.wat")
        .replace("(data (i32.const 128) \"healthy\")", &format!("(data (i32.const 256) \"{}\") (data (i32.const 128) \"healthy\")", reply.replace('"', "\\22")))
        .replace("local.get $payload local.get $length i32.const 32 call $kv", &format!("i32.const 32 i32.const 0 i32.store i32.const 36 i32.const 256 i32.store i32.const 40 i32.const {} i32.store", reply.len()));
    files.insert("code/module.wasm".into(), wat::parse_str(source).unwrap());
    if growth == "migration" {
        files.insert("sql/001.sql".into(), b"CREATE TABLE app.sample_counter_entries (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL);".to_vec());
    }
    if growth == "unhealthy" {
        files.insert(
            "code/module.wasm".into(),
            wat::parse_str(common::unhealthy_source()).unwrap(),
        );
    }
    let bytes = archive::pack(&files).unwrap();
    artifact.digest = trust::digest(&bytes);
    artifact.size = bytes.len() as u64;
    artifact.signature = common::Keys::sign(&keys.publisher, artifact.digest.as_bytes());
    fs::write(
        folder.join(format!("packages/{}.mosspkg", artifact.digest)),
        bytes,
    )
    .unwrap();
    let mut index: Index =
        serde_json::from_slice(&fs::read(folder.join("index.json")).unwrap()).unwrap();
    index.modules = vec![artifact.clone()];
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(folder.join("index.json"), &bytes).unwrap();
    fs::write(
        folder.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    artifact
}
