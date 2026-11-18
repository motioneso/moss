//! Package construction from the built component. Weather has no database tables.
use anyhow::Result;
use moss_module_host::{archive, manifest::Manifest};
use std::{collections::BTreeMap, path::Path};

pub fn manifest() -> Result<Manifest> {
    Ok(serde_json::from_str(include_str!("../../moss.module.json"))?)
}
pub fn files(root: &Path, component: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    manifest.validate(&"0.1.0".parse()?)?;
    let files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        ("moss.module.json".into(), serde_json::to_vec(&manifest)?),
        ("code/module.wasm".into(), component.to_vec()),
        ("icons/weather.svg".into(), include_bytes!("../../icons/weather.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    let mut files = files;
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("forecast.html", include_bytes!("../../ui/forecast.html")),
        ("app.mjs", include_bytes!("../../ui/app.mjs")),
        ("forecast.mjs", include_bytes!("../../ui/forecast.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("view.mjs", include_bytes!("../../ui/view.mjs")),
        ("icons.mjs", include_bytes!("../../ui/icons.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("weather.css", include_bytes!("../../ui/weather.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
