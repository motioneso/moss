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
        ("icons/commitments.svg".into(), include_bytes!("../../icons/commitments.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for (name, bytes) in [
        (
            "index.html",
            include_bytes!("../../ui/index.html").as_slice(),
        ),
        ("today.mjs", include_bytes!("../../ui/today.mjs").as_slice()),
        ("today.css", include_bytes!("../../ui/today.css").as_slice()),
        ("api.mjs", include_bytes!("../../ui/api.mjs").as_slice()),
        ("view.mjs", include_bytes!("../../ui/view.mjs").as_slice()),
        (
            "controller.mjs",
            include_bytes!("../../ui/controller.mjs").as_slice(),
        ),
        (
            "guest-bridge.mjs",
            include_bytes!("../../ui/guest-bridge.mjs").as_slice(),
        ),
        (
            "review-card.mjs",
            include_bytes!("../../ui/review-card.mjs").as_slice(),
        ),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("commitments", path)
            .ok_or_else(|| anyhow::anyhow!("Commitments SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("packages/commitments").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Commitments SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
