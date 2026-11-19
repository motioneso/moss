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
            "icons/meals.svg".into(),
            include_bytes!("../../icons/meals.svg").to_vec(),
        ),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        (
            "CHANGELOG.md".into(),
            include_bytes!("../../CHANGELOG.md").to_vec(),
        ),
    ]);
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("app.mjs", include_bytes!("../../ui/app.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("format.mjs", include_bytes!("../../ui/format.mjs")),
        ("kit.mjs", include_bytes!("../../ui/kit.mjs")),
        ("plan.mjs", include_bytes!("../../ui/plan.mjs")),
        ("plan-day.mjs", include_bytes!("../../ui/plan-day.mjs")),
        ("recipe.mjs", include_bytes!("../../ui/recipe.mjs")),
        ("list.mjs", include_bytes!("../../ui/list.mjs")),
        ("list-dialogs.mjs", include_bytes!("../../ui/list-dialogs.mjs")),
        ("pantry.mjs", include_bytes!("../../ui/pantry.mjs")),
        ("pantry-dialogs.mjs", include_bytes!("../../ui/pantry-dialogs.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("meals.css", include_bytes!("../../ui/meals.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("meals", path)
            .ok_or_else(|| anyhow::anyhow!("Meals SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("external-modules/meals").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Meals SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
