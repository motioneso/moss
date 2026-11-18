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
        ("icons/wellness.svg".into(), include_bytes!("../../icons/wellness.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("app.mjs", include_bytes!("../../ui/app.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("hero.mjs", include_bytes!("../../ui/hero.mjs")),
        ("core.mjs", include_bytes!("../../ui/core.mjs")),
        ("html.mjs", include_bytes!("../../ui/html.mjs")),
        ("today.mjs", include_bytes!("../../ui/today.mjs")),
        ("history.mjs", include_bytes!("../../ui/history.mjs")),
        ("trends.mjs", include_bytes!("../../ui/trends.mjs")),
        ("checkin-modal.mjs", include_bytes!("../../ui/checkin-modal.mjs")),
        ("meds-form.mjs", include_bytes!("../../ui/meds-form.mjs")),
        ("meds-view.mjs", include_bytes!("../../ui/meds-view.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("wellness.css", include_bytes!("../../ui/wellness.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("wellness", path)
            .ok_or_else(|| anyhow::anyhow!("Wellness SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("packages/wellness").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Wellness SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
