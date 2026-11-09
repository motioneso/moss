//! Build and verification utilities. Never linked into the Notes guest.
use anyhow::{ensure, Result};
use moss_module_host::{legacy, manifest::Manifest, trust};
use std::{collections::BTreeMap, path::Path};

pub mod screen;

pub fn manifest() -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_str(include_str!("../../moss.module.json"))?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut tables = manifest.database.owned_tables.clone();
    tables.sort();
    ensure!(
        tables == {
            let mut expected = legacy::tables("notes").to_vec();
            expected.push("app.notes_sync_checkpoints".into());
            expected.sort();
            expected
        },
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
        manifest.database.migrations == {
            let mut expected = expected;
            expected.push("sql/0360_notes_sync_checkpoints.sql".into());
            expected
        },
        "Notes migration inventory changed"
    );
    let mut files = BTreeMap::new();
    for path in &manifest.database.migrations {
        let bytes = if let Some(frozen) = legacy::entry("notes", path) {
            let bytes = std::fs::read(root.join("packages/notes").join(path))?;
            ensure!(
                trust::digest(&bytes) == frozen.raw,
                "Notes migration bytes changed: {path}"
            );
            bytes
        } else {
            let bytes = std::fs::read(root.join("modules/notes").join(path))?;
            ensure!(
                trust::digest(&bytes)
                    == "15e85bbf3d2fcc0ba8aced4b5107069ef597dcd6a2cb1282304d082a65d34747",
                "Notes migration bytes changed: {path}"
            );
            bytes
        };
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
    // Reuse the app's authored document defaults; isolated frames do not
    // inherit the shell's typography, background or box sizing.
    files.insert(
        "ui/base.css".into(),
        std::fs::read(root.join("rust-spike/module-ui/web/base.css"))?,
    );
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
