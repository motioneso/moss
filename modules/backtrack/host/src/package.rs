//! Package construction from the built component and the immutable legacy SQL.
use anyhow::Result;
use moss_module_host::{archive, manifest::Manifest};
use std::{collections::BTreeMap, path::Path};

pub fn manifest() -> Result<Manifest> {
    Ok(serde_json::from_str(include_str!("../../moss.module.json"))?)
}
pub fn files(root: &Path, component: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut files = BTreeMap::from([
        ("moss.module.json".into(), serde_json::to_vec(&manifest)?),
        ("code/module.wasm".into(), component.to_vec()),
        ("icons/backtrack.svg".into(), include_bytes!("../../icons/backtrack.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for path in &manifest.database.migrations {
        let bytes = if let Some(frozen) = moss_module_host::legacy::entry("backtrack", path) {
            let bytes = std::fs::read(root.join("packages/backtrack").join(path))?;
            anyhow::ensure!(frozen.raw == moss_module_host::trust::digest(&bytes), "Legacy Backtrack SQL changed");
            bytes
        } else {
            let bytes = std::fs::read(root.join("modules/backtrack").join(path))?;
            let pinned = match path.as_str() {
                "sql/0367_backtrack_index_stamp.sql" => "34fa39f2023e9ac7040924a587b78cc156a3beb899cf70bb44290e8c1fe497e7",
                _ => "",
            };
            anyhow::ensure!(moss_module_host::trust::digest(&bytes) == pinned, "Backtrack migration bytes changed: {path}");
            bytes
        };
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
