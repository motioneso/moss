//! Build and verification utilities. Never linked into the Notes guest.
use anyhow::{ensure, Context, Result};
use moss_module_host::{legacy, manifest::Manifest, trust};
use std::{collections::BTreeMap, path::Path};

pub mod screen;

pub fn manifest() -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_str(include_str!("../../moss.module.json"))?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut tables = manifest.database.owned_tables.clone();
    tables.sort();
    ensure!(
        tables == legacy::tables("notes"),
        "Notes table inventory changed"
    );
    Ok(manifest)
}

pub fn package_files(root: &Path, component: Vec<u8>) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    let expected: Vec<_> = legacy::hashes()
        .into_keys()
        .filter(|(module, _)| module == "notes")
        .map(|(_, path)| path)
        .collect();
    ensure!(
        manifest.database.migrations == expected,
        "Notes migration inventory changed"
    );
    let mut files = BTreeMap::new();
    for path in &manifest.database.migrations {
        let bytes = std::fs::read(root.join("packages/notes").join(path))?;
        let frozen = legacy::entry("notes", path).context("Unreviewed Notes migration")?;
        ensure!(
            trust::digest(&bytes) == frozen.raw,
            "Notes migration bytes changed: {path}"
        );
        files.insert(path.clone(), bytes);
    }
    for (name, path) in [
        ("moss.module.json", "modules/notes/moss.module.json"),
        ("icons/notes.svg", "modules/notes/icons/notes.svg"),
        ("LICENSE", "LICENSE"),
        ("NOTICE", "modules/notes/NOTICE"),
        ("CHANGELOG.md", "modules/notes/CHANGELOG.md"),
    ] {
        files.insert(name.into(), std::fs::read(root.join(path))?);
    }
    files.insert("code/module.wasm".into(), component);
    files.insert("ui/index.html".into(), screen::render().into_bytes());
    for name in ["app.mjs", "notes.css"] {
        files.insert(
            format!("ui/{name}"),
            std::fs::read(root.join("modules/notes/ui").join(name))?,
        );
    }
    files.insert(
        "ui/guest-bridge.mjs".into(),
        std::fs::read(root.join("rust-spike/module-ui/web/guest-bridge.mjs"))?,
    );
    Ok(files)
}
