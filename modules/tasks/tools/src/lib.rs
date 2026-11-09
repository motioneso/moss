//! Host-side verification only; never linked into the module guest.
use anyhow::{ensure, Result};
use moss_module_host::{legacy, manifest::Manifest, trust};
use std::path::Path;
pub mod screen;

pub fn manifest() -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_str(include_str!("../../moss.module.json"))?;
    manifest.validate(&"0.1.0".parse()?)?;
    Ok(manifest)
}
/// Load the original SQL bytes; reject any divergence from the release inventory.
pub fn legacy_files(root: &Path) -> Result<std::collections::BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    let mut files = std::collections::BTreeMap::new();
    for path in &manifest.database.migrations {
        let bytes = std::fs::read(root.join("packages/tasks").join(path))?;
        let frozen = legacy::entry("tasks", path)
            .ok_or_else(|| anyhow::anyhow!("Unreviewed Tasks migration"))?;
        ensure!(
            trust::digest(&bytes) == frozen.raw,
            "Tasks migration bytes changed: {path}"
        );
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}

/// Reproducible package inputs. SQL comes from the original, hash-checked module ledger.
pub fn package_files(
    root: &Path,
    component: Vec<u8>,
) -> Result<std::collections::BTreeMap<String, Vec<u8>>> {
    let mut files = legacy_files(root)?;
    for (name, path) in [
        ("moss.module.json", "modules/tasks/moss.module.json"),
        ("icons/tasks.svg", "modules/tasks/icons/tasks.svg"),
        ("LICENSE", "LICENSE"),
        ("NOTICE", "modules/tasks/NOTICE"),
        ("CHANGELOG.md", "modules/tasks/CHANGELOG.md"),
    ] {
        files.insert(name.into(), std::fs::read(root.join(path))?);
    }
    files.insert("code/module.wasm".into(), component);
    files.insert("ui/index.html".into(), screen::render().into_bytes());
    for name in ["app.mjs", "model.mjs", "tags.mjs", "tasks.css"] {
        files.insert(
            format!("ui/{name}"),
            std::fs::read(root.join("modules/tasks/ui").join(name))?,
        );
    }
    files.insert(
        "ui/guest-bridge.mjs".into(),
        std::fs::read(root.join("rust-spike/module-ui/web/guest-bridge.mjs"))?,
    );
    Ok(files)
}
