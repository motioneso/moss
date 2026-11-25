//! Mutable signed registry and real DDL conflicts, controlled only by the test process.
use super::common;
use moss_module_host::{
    archive,
    registry::{Artifact, Index},
    trust,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

fn offer(
    keys: &common::Keys,
    folder: &Path,
    base: &Artifact,
    width: &str,
    kind: &str,
    version: &str,
) -> Artifact {
    let id = format!("install-{width}-{kind}");
    let name = format!("{} {}", width, kind);
    let mut manifest = common::manifest(version);
    manifest.id = id.clone();
    manifest.name = name.clone();
    manifest.publisher = "Moss".into();
    manifest.navigation = vec![json!({"id":id,"label":name,"path":format!("/{id}"),"icon":"leaf"})];
    let mut files = common::files(&manifest);
    if kind == "sql" {
        manifest.database.migrations = vec!["sql/001_entries.sql".into()];
        manifest.database.owned_tables = vec![format!("app.install__{width}__sql_entries")];
        files.insert("sql/001_entries.sql".into(),format!("CREATE TABLE app.install__{width}__sql_entries (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL);").into_bytes());
    }
    manifest
        .screens
        .insert(format!("/{id}"), "ui/main.html".into());
    files.insert(
        "ui/main.html".into(),
        format!("<!doctype html><html><h1>{name}</h1></html>").into_bytes(),
    );
    files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let bytes = archive::pack(&files).unwrap();
    let mut artifact = base.clone();
    artifact.id = id;
    artifact.version = version.parse().unwrap();
    artifact.digest = trust::digest(&bytes);
    artifact.size = bytes.len() as u64;
    artifact.signature = common::Keys::sign(&keys.publisher, artifact.digest.as_bytes());
    artifact.migrations = manifest.database.migrations.clone();
    artifact.presentation=Some(serde_json::from_value(json!({"name":name,"description":"Install screen fixture","publisher":"Moss","category":"Testing","screenshots":[]})).unwrap());
    fs::write(
        folder.join(format!("packages/{}.mosspkg", artifact.digest)),
        bytes,
    )
    .unwrap();
    artifact
}
fn sign(keys: &common::Keys, folder: &Path, index: &mut Index) {
    index.serial += 1;
    let bytes = serde_json::to_vec(index).unwrap();
    fs::write(folder.join("index.json"), &bytes).unwrap();
    fs::write(
        folder.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
}
pub fn serve(
    root: &Path,
    registry: &Path,
    keys: &common::Keys,
    hold: &Path,
    origin: &str,
    db: &tokio_postgres::Client,
    rt: &tokio::runtime::Runtime,
) {
    let mut index: Index =
        serde_json::from_slice(&fs::read(registry.join("index.json")).unwrap()).unwrap();
    let base = index.modules[0].clone();
    for width in ["desktop", "phone"] {
        for kind in ["success", "changed", "download", "sql"] {
            index
                .modules
                .push(offer(keys, registry, &base, width, kind, "1.0.0"));
        }
    }
    sign(keys, registry, &mut index);
    fs::create_dir_all(hold).unwrap();
    fs::write(
        hold.join("ready.json"),
        json!({"origin":origin,"instance":root,"registry":registry}).to_string(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1200);
    while !hold.join("release").exists() {
        assert!(
            Instant::now() < deadline,
            "install browser completion deadline"
        );
        let command = hold.join("command.json");
        if command.exists() {
            let value: Value = serde_json::from_slice(&fs::read(&command).unwrap()).unwrap();
            let width = value["width"].as_str().unwrap();
            assert!(["desktop", "phone"].contains(&width));
            match value["action"].as_str().unwrap() {
                "change" => {
                    index
                        .modules
                        .push(offer(keys, registry, &base, width, "changed", "1.1.0"));
                    sign(keys, registry, &mut index);
                }
                "sql-conflict" => {
                    rt.block_on(db.batch_execute(&format!(
                        "CREATE TABLE app.install__{width}__sql_entries (private_marker text)"
                    )))
                    .unwrap();
                }
                "sql-repair" => {
                    rt.block_on(
                        db.batch_execute(&format!("DROP TABLE app.install__{width}__sql_entries")),
                    )
                    .unwrap();
                }
                _ => panic!("unknown fixture command"),
            }
            fs::remove_file(command).unwrap();
            fs::write(hold.join("reply"), value["id"].to_string()).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
