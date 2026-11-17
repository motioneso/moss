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
        ("icons/finance.svg".into(), include_bytes!("../../icons/finance.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for path in &manifest.database.migrations {
        let bytes = if let Some(frozen) = moss_module_host::legacy::entry("finance", path) {
            let bytes = std::fs::read(root.join("external-modules/finance").join(path))?;
            anyhow::ensure!(
                frozen.raw == moss_module_host::trust::digest(&bytes),
                "Legacy Finance SQL changed"
            );
            bytes
        } else {
            let bytes = std::fs::read(root.join("modules/finance").join(path))?;
            let pinned = match path.as_str() {
                "sql/0043_finance_bank_links.sql" => {
                    "9daef3696e4bacc23c879ce4b7915753f306cc71c91163c28f380400bd866550"
                }
                _ => "",
            };
            anyhow::ensure!(
                moss_module_host::trust::digest(&bytes) == pinned,
                "Finance migration bytes changed: {path}"
            );
            bytes
        };
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
