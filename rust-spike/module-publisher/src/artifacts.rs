//! Build tools share the host's archive format; no module manifest is synthesized here.
use crate::read_bounded;
use anyhow::{ensure, Context, Result};
use moss_module_host::{
    archive::{self, Package, MAX_PACKAGE, MAX_UNPACKED},
    trust,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

pub fn input_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    fn visit(
        root: &Path,
        dir: &Path,
        files: &mut BTreeMap<String, Vec<u8>>,
        total: &mut u64,
        depth: usize,
    ) -> Result<()> {
        ensure!(depth < 32, "Input folders are nested too deeply");
        ensure!(
            fs::symlink_metadata(dir)?.is_dir(),
            "Input must be a regular folder"
        );
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            ensure!(!meta.file_type().is_symlink(), "Input links are refused");
            if meta.is_dir() {
                visit(root, &path, files, total, depth + 1)?;
            } else {
                ensure!(meta.is_file(), "Input special files are refused");
                ensure!(files.len() < 4096, "Too many input files");
                let bytes = read_bounded(&path, MAX_UNPACKED.saturating_sub(*total))?;
                *total += bytes.len() as u64;
                let name = path
                    .strip_prefix(root)?
                    .to_str()
                    .context("Invalid input name")?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                files.insert(name, bytes);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files, &mut 0, 0)?;
    Ok(files)
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}
pub fn pack(root: &Path, output: &Path) -> Result<Value> {
    let bytes = archive::pack(&input_files(root)?)?;
    Package::read_for_review(&bytes, &trust::digest(&bytes))?;
    write_new(output, &bytes)?;
    Ok(json!({"digest":trust::digest(&bytes),"size":bytes.len()}))
}
pub fn inspect(path: &Path) -> Result<Value> {
    let bytes = read_bounded(path, MAX_PACKAGE)?;
    let package = Package::read_for_review(&bytes, &trust::digest(&bytes))?;
    Ok(
        json!({"authenticated":false,"digest":package.digest,"manifest":serde_json::from_slice::<Value>(&package.files["moss.module.json"])?,"files":package.files.keys().collect::<Vec<_>>()}),
    )
}

pub fn configuration(path: &Path) -> Result<crate::Configuration> {
    Ok(serde_json::from_slice(&read_bounded(path, 1024 * 1024)?)?)
}
pub fn catalog(config: &crate::Configuration) -> Result<moss_module_host::registry::Catalog> {
    use moss_module_host::registry::{Catalog, SeenRegistry, Source};
    let catalog = Catalog::fetch(
        Source::Folder(config.registry_path.clone()),
        &config.root_key,
        &config.first_party_key,
        &mut SeenRegistry::default(),
    )?;
    ensure!(
        catalog.trust.identity.id == config.registry_id,
        "Wrong registry identity"
    );
    Ok(catalog)
}
pub fn validate(package: &Package) -> Result<()> {
    use moss_module_host::{
        runtime::{Host, Limits},
        sql::LegacyInventory,
    };
    archive::validate_install(
        package,
        &Host::new(Limits::default())?,
        &LegacyInventory::default(),
    )
}
pub fn verify(config_path: &Path, submission_path: &Path) -> Result<Value> {
    let config = configuration(config_path)?;
    let catalog = catalog(&config)?;
    let submission: crate::Submission =
        serde_json::from_slice(&read_bounded(submission_path, 1024 * 1024)?)?;
    let bytes = read_bounded(&submission.package_path, MAX_PACKAGE)?;
    let digest = trust::digest(&bytes);
    let package = Package::read(&bytes, &digest, &config.moss_version)?;
    catalog.trust.verify_package(
        &submission.publisher_key,
        &package.manifest.id,
        &digest,
        &submission.signature,
    )?;
    let mut seen = moss_module_host::registry::SeenRegistry::default();
    // Evaluate the same cumulative policy as an initial registry observation.
    seen.accept(
        &catalog.index,
        &serde_json::to_vec(&catalog.index)?,
        &catalog.trust,
    )?;
    let publisher = catalog
        .trust
        .publisher(&submission.publisher_key, &package.manifest.id)?;
    ensure!(
        !seen.blocks_package(&digest, &submission.publisher_key, &publisher.key),
        "Package or publisher is blocked"
    );
    validate(&package)?;
    Ok(
        json!({"authenticated":true,"digest":digest,"id":package.manifest.id,"version":package.manifest.version}),
    )
}
