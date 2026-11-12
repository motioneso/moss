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

/// A package that does nothing, so a module that requires `id` can be installed. It reuses
/// Meetings' component and declares no tables, routes, jobs or required modules. Test setups only.
pub fn stand_in(id: &str, wasm: &[u8]) -> Result<(Vec<u8>, Manifest)> {
    let mut value = serde_json::to_value(manifest()?)?;
    let fields = value.as_object_mut().ok_or_else(|| anyhow::anyhow!("Manifest is not an object"))?;
    for key in ["requires", "provides", "jobs", "screens", "database"] {
        fields.insert(key.into(), serde_json::json!({}));
    }
    for key in ["routes", "navigation", "settings", "features"] {
        fields.insert(key.into(), serde_json::json!([]));
    }
    fields.insert("id".into(), id.into());
    fields.insert("name".into(), id.into());
    fields.insert("icons".into(), serde_json::json!([format!("icons/{id}.svg")]));
    let manifest: Manifest = serde_json::from_value(value)?;
    let files = BTreeMap::from([
        ("moss.module.json".to_owned(), serde_json::to_vec(&manifest)?),
        ("code/module.wasm".to_owned(), wasm.to_vec()),
        (format!("icons/{id}.svg"), b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>".to_vec()),
        ("LICENSE".to_owned(), b"test".to_vec()),
        ("NOTICE".to_owned(), b"test".to_vec()),
        ("CHANGELOG.md".to_owned(), b"test".to_vec()),
    ]);
    Ok((archive::pack(&files)?, manifest))
}
