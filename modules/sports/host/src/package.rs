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
        ("icons/sports.svg".into(), include_bytes!("../../icons/sports.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for (name, bytes) in [
        ("api.mjs", include_bytes!("../../ui/api.mjs").as_slice()),
        ("app.mjs", include_bytes!("../../ui/app.mjs").as_slice()),
        ("board.mjs", include_bytes!("../../ui/board.mjs").as_slice()),
        ("competitions.mjs", include_bytes!("../../ui/competitions.mjs").as_slice()),
        ("dom.mjs", include_bytes!("../../ui/dom.mjs").as_slice()),
        ("gameday.mjs", include_bytes!("../../ui/gameday.mjs").as_slice()),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs").as_slice()),
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("locale.mjs", include_bytes!("../../ui/locale.mjs").as_slice()),
        ("news.mjs", include_bytes!("../../ui/news.mjs").as_slice()),
        ("page.mjs", include_bytes!("../../ui/page.mjs").as_slice()),
        ("parts.mjs", include_bytes!("../../ui/parts.mjs").as_slice()),
        ("picker.mjs", include_bytes!("../../ui/picker.mjs").as_slice()),
        ("ranking.mjs", include_bytes!("../../ui/ranking.mjs").as_slice()),
        ("rotation.mjs", include_bytes!("../../ui/rotation.mjs").as_slice()),
        ("sports.css", include_bytes!("../../ui/sports.css").as_slice()),
        ("sports-ticker.css", include_bytes!("../../ui/sports-ticker.css").as_slice()),
        ("sports-broadsheet.css", include_bytes!("../../ui/sports-broadsheet.css").as_slice()),
        ("sports-news.css", include_bytes!("../../ui/sports-news.css").as_slice()),
        ("follows.mjs", include_bytes!("../../ui/follows.mjs").as_slice()),
        ("settings-api.mjs", include_bytes!("../../ui/settings-api.mjs").as_slice()),
        ("settings-logic.mjs", include_bytes!("../../ui/settings-logic.mjs").as_slice()),
        ("settings-ui.mjs", include_bytes!("../../ui/settings-ui.mjs").as_slice()),
        ("settings.mjs", include_bytes!("../../ui/settings.mjs").as_slice()),
        ("settings.css", include_bytes!("../../ui/settings.css").as_slice()),
        ("settings.html", include_bytes!("../../ui/settings.html").as_slice()),
        ("settings-follows.css", include_bytes!("../../ui/settings-follows.css").as_slice()),
        ("settings-sources.css", include_bytes!("../../ui/settings-sources.css").as_slice()),
        ("source-add.mjs", include_bytes!("../../ui/source-add.mjs").as_slice()),
        ("source-pick.mjs", include_bytes!("../../ui/source-pick.mjs").as_slice()),
        ("sources.mjs", include_bytes!("../../ui/sources.mjs").as_slice()),
        ("standings-settings.mjs", include_bytes!("../../ui/standings-settings.mjs").as_slice()),
        ("standings.mjs", include_bytes!("../../ui/standings.mjs").as_slice()),
        ("team-colors.mjs", include_bytes!("../../ui/team-colors.mjs").as_slice()),
        ("ticker.mjs", include_bytes!("../../ui/ticker.mjs").as_slice()),
        ("today-app.mjs", include_bytes!("../../ui/today-app.mjs").as_slice()),
        ("today-desk.mjs", include_bytes!("../../ui/today-desk.mjs").as_slice()),
        ("today.css", include_bytes!("../../ui/today.css").as_slice()),
        ("today.html", include_bytes!("../../ui/today.html").as_slice()),
        ("today.mjs", include_bytes!("../../ui/today.mjs").as_slice()),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let frozen = moss_module_host::legacy::entry("sports", path)
            .ok_or_else(|| anyhow::anyhow!("Sports SQL is not in the legacy inventory"))?;
        let bytes = std::fs::read(root.join("packages/sports").join(path))?;
        anyhow::ensure!(
            frozen.raw == moss_module_host::trust::digest(&bytes),
            "Legacy Sports SQL changed"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, component: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, component)?)
}
