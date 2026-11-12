//! Package construction from the built component and the immutable legacy SQL.
//! The two history backfills run from the host's compiled copies, keyed by the SQL marker,
//! so the `.backfill.mjs` files are not packaged.
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
        ("icons/meetings.svg".into(), include_bytes!("../../icons/meetings.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("meetings", path)
            .ok_or_else(|| anyhow::anyhow!("Meetings SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("packages/meetings").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Meetings SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
