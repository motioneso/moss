//! Usage: pack_people <component.wasm> <built-ui-directory> <package.mossmod>
//! Local build utility only. Signing and registry publication remain separate host operations.
use anyhow::{ensure, Context, Result};
use moss_module_host::{archive, legacy, manifest::Manifest, trust};
use std::{collections::BTreeMap, path::Path};
fn add_ui(files: &mut BTreeMap<String, Vec<u8>>, root: &Path, current: &Path) -> Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "UI assets must not be links");
        if kind.is_dir() {
            add_ui(files, root, &entry.path())?;
        } else {
            ensure!(kind.is_file(), "UI asset must be a regular file");
            let path = format!(
                "ui/{}",
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .context("UI path is not UTF-8")?
            );
            ensure!(
                moss_module_host::manifest::relative_path(&path),
                "Invalid UI asset path"
            );
            files.insert(path, std::fs::read(entry.path())?);
        }
    }
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 3,
        "Usage: pack_people component.wasm ui-directory output.mossmod"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let module = root.join("modules/people");
    let manifest_bytes = std::fs::read(module.join("moss.module.json"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut files = BTreeMap::from([
        ("moss.module.json".into(), manifest_bytes),
        ("code/module.wasm".into(), std::fs::read(&args[0])?),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        (
            "NOTICE".into(),
            b"Moss People; preserves the original People migration identity.".to_vec(),
        ),
        (
            "CHANGELOG.md".into(),
            std::fs::read(module.join("CHANGELOG.md"))?,
        ),
        (
            "icons/people.svg".into(),
            std::fs::read(module.join("icons/people.svg"))?,
        ),
    ]);
    for path in &manifest.database.migrations {
        let bytes = std::fs::read(root.join("packages/people").join(path))?;
        ensure!(
            legacy::entry("people", path).is_some_and(|entry| entry.raw == trust::digest(&bytes)),
            "Legacy People migration changed"
        );
        files.insert(path.clone(), bytes);
    }
    add_ui(&mut files, Path::new(&args[1]), Path::new(&args[1]))?;
    for path in manifest.screens.values() {
        ensure!(files.contains_key(path), "Declared screen is missing");
    }
    let bytes = archive::pack(&files)?;
    archive::Package::read(&bytes, &trust::digest(&bytes), &"0.1.0".parse()?)?;
    std::fs::write(&args[2], &bytes)?;
    println!(
        "People package sha256:{} ({} bytes)",
        trust::digest(&bytes),
        bytes.len()
    );
    Ok(())
}
