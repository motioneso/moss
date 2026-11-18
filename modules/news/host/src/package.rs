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
        ("icons/news.svg".into(), include_bytes!("../../icons/news.svg").to_vec()),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        ("NOTICE".into(), include_bytes!("../../NOTICE").to_vec()),
        ("CHANGELOG.md".into(), include_bytes!("../../CHANGELOG.md").to_vec()),
    ]);
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("widget.html", include_bytes!("../../ui/widget.html")),
        ("app.mjs", include_bytes!("../../ui/app.mjs")),
        ("widget.mjs", include_bytes!("../../ui/widget.mjs")),
        ("view.mjs", include_bytes!("../../ui/view.mjs")),
        ("lead-art.mjs", include_bytes!("../../ui/lead-art.mjs")),
        ("screen-api.mjs", include_bytes!("../../ui/screen-api.mjs")),
        ("images.mjs", include_bytes!("../../ui/images.mjs")),
        ("story-menu.mjs", include_bytes!("../../ui/story-menu.mjs")),
        ("news.css", include_bytes!("../../ui/news.css")),
        ("widget.css", include_bytes!("../../ui/widget.css")),
        ("settings.html", include_bytes!("../../ui/settings.html").as_slice()),
        ("settings.mjs", include_bytes!("../../ui/settings.mjs")),
        ("topics.mjs", include_bytes!("../../ui/topics.mjs")),
        ("add-source.mjs", include_bytes!("../../ui/add-source.mjs")),
        ("feedback.mjs", include_bytes!("../../ui/feedback.mjs")),
        ("parts.mjs", include_bytes!("../../ui/parts.mjs")),
        ("domain.mjs", include_bytes!("../../ui/domain.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("dom.mjs", include_bytes!("../../ui/dom.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("news-settings.css", include_bytes!("../../ui/news-settings.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let bytes = if let Some(frozen) = moss_module_host::legacy::entry("news", path) {
            let bytes = std::fs::read(root.join("packages/news").join(path))?;
            anyhow::ensure!(
                frozen.raw == moss_module_host::trust::digest(&bytes),
                "Legacy News SQL changed"
            );
            bytes
        } else {
            let bytes = std::fs::read(root.join("modules/news").join(path))?;
            let pinned = match path.as_str() {
                "sql/0370_news_story_feedback.sql" => "e02522e4628762b106a14c17b0ae8567497d2016d0f7a09af375115dc931d34e",
                _ => "",
            };
            anyhow::ensure!(
                moss_module_host::trust::digest(&bytes) == pinned,
                "News migration bytes changed: {path}"
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
