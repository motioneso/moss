//! Package construction from the built component and the immutable legacy SQL.
use anyhow::Result;
use moss_module_host::{archive, manifest::Manifest};
use std::{collections::BTreeMap, path::Path};

pub fn manifest() -> Result<Manifest> {
    Ok(serde_json::from_str(include_str!(
        "../../moss.module.json"
    ))?)
}
pub fn files(root: &Path, component: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut files = BTreeMap::from([
        ("moss.module.json".into(), serde_json::to_vec(&manifest)?),
        ("code/module.wasm".into(), component.to_vec()),
        (
            "icons/scratchpad.svg".into(),
            include_bytes!("../../icons/scratchpad.svg").to_vec(),
        ),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        (
            "CHANGELOG.md".into(),
            include_bytes!("../../CHANGELOG.md").to_vec(),
        ),
    ]);
    for (name, bytes) in [
        (
            "index.html",
            include_bytes!("../../ui/index.html").as_slice(),
        ),
        ("app.mjs", include_bytes!("../../ui/app.mjs").as_slice()),
        (
            "settings.html",
            include_bytes!("../../ui/settings.html").as_slice(),
        ),
        (
            "settings.mjs",
            include_bytes!("../../ui/settings.mjs").as_slice(),
        ),
        (
            "scratchpad.css",
            include_bytes!("../../ui/scratchpad.css").as_slice(),
        ),
        (
            "guest-bridge.mjs",
            include_bytes!("../../ui/guest-bridge.mjs").as_slice(),
        ),
        ("api.mjs", include_bytes!("../../ui/api.mjs").as_slice()),
        (
            "editor.mjs",
            include_bytes!("../../ui/editor.mjs").as_slice(),
        ),
        ("model.mjs", include_bytes!("../../ui/model.mjs").as_slice()),
        ("view.mjs", include_bytes!("../../ui/view.mjs").as_slice()),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("scratchpad", path).ok_or_else(|| {
            anyhow::anyhow!("Scratchpad migration is not in the legacy list: {path}")
        })?;
        let bytes = std::fs::read(root.join("packages/scratchpad").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Scratchpad SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
