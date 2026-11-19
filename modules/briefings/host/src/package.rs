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
        ("icons/briefings.svg".into(), include_bytes!("../../icons/briefings.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("briefings", path)
            .ok_or_else(|| anyhow::anyhow!("Briefings SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("packages/briefings").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Briefings SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("briefing.html", include_bytes!("../../ui/briefing.html")),
        ("settings.mjs", include_bytes!("../../ui/settings.mjs")),
        ("briefing.mjs", include_bytes!("../../ui/briefing.mjs")),
        ("parts.mjs", include_bytes!("../../ui/parts.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("view.mjs", include_bytes!("../../ui/view.mjs")),
        ("markdown.mjs", include_bytes!("../../ui/markdown.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("briefings.css", include_bytes!("../../ui/briefings.css")),
        ("reader.css", include_bytes!("../../ui/reader.css")),
        ("today.html", include_bytes!("../../ui/today.html")),
        ("today.mjs", include_bytes!("../../ui/today.mjs")),
        ("today-view.mjs", include_bytes!("../../ui/today-view.mjs")),
        ("today.css", include_bytes!("../../ui/today.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
