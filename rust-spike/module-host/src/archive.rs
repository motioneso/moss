//! Archives are parsed into bounded memory before any file reaches the installed tree.
use crate::{
    manifest::{relative_path, Manifest},
    trust,
};
use anyhow::{ensure, Context, Result};
use semver::Version;
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

pub const MAX_PACKAGE: u64 = 64 * 1024 * 1024;
pub const MAX_UNPACKED: u64 = 128 * 1024 * 1024;
pub struct Package {
    pub manifest: Manifest,
    pub files: BTreeMap<String, Vec<u8>>,
    pub digest: String,
}
impl Package {
    pub fn read(bytes: &[u8], expected: &str, moss: &Version) -> Result<Self> {
        ensure!(
            bytes.len() as u64 <= MAX_PACKAGE,
            "The package is too large"
        );
        ensure!(
            trust::digest(bytes) == expected,
            "The package hash does not match; nothing was installed"
        );
        let decoder = zstd::stream::read::Decoder::new(bytes)?;
        let mut unpacked = Vec::new();
        decoder.take(MAX_UNPACKED + 1).read_to_end(&mut unpacked)?;
        ensure!(
            unpacked.len() as u64 <= MAX_UNPACKED,
            "The expanded package is too large"
        );
        let mut archive = tar::Archive::new(Cursor::new(unpacked));
        let mut files = BTreeMap::new();
        let mut previous = String::new();
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = std::str::from_utf8(&entry.path_bytes())?.to_string();
            let file = entry.header().entry_type().is_file();
            ensure!(
                file || entry.header().entry_type().is_dir(),
                "Package links and special files are refused"
            );
            let name = path.trim_end_matches('/');
            // Fixed metadata filenames are the only uppercase archive names in the spec.
            ensure!(
                matches!(name, "LICENSE" | "NOTICE" | "CHANGELOG.md") || relative_path(name),
                "An archive file name is unsafe"
            );
            ensure!(path > previous, "Archive entries must be sorted and unique");
            ensure!(
                entry.header().mtime()? == 0,
                "Archive timestamps must be zero"
            );
            previous = path.clone();
            ensure!(files.len() < 4096, "The package has too many files");
            if file {
                let mut content = Vec::new();
                entry.read_to_end(&mut content)?;
                ensure!(
                    files.insert(path, content).is_none(),
                    "An archive file is repeated"
                );
            }
        }
        for required in ["moss.module.json", "LICENSE", "NOTICE", "CHANGELOG.md"] {
            ensure!(
                files.contains_key(required),
                "The package is missing {required}"
            );
        }
        let manifest: Manifest = serde_json::from_slice(&files["moss.module.json"])?;
        manifest.validate(moss)?;
        ensure!(
            files.contains_key("code/module.wasm") || !manifest.screens.is_empty(),
            "A package needs code or a screen"
        );
        for path in manifest
            .icons
            .iter()
            .chain(manifest.screens.values())
            .chain(&manifest.database.migrations)
        {
            ensure!(
                files.contains_key(path),
                "A declared package file is missing"
            );
        }
        let actual: Vec<_> = files
            .keys()
            .filter(|p| p.starts_with("sql/"))
            .cloned()
            .collect();
        let mut declared = manifest.database.migrations.clone();
        declared.sort();
        ensure!(
            actual == declared,
            "The SQL file list does not match the manifest"
        );
        for name in files.keys() {
            ensure!(
                matches!(
                    name.as_str(),
                    "moss.module.json" | "LICENSE" | "NOTICE" | "CHANGELOG.md" | "code/module.wasm"
                ) || ["sql/", "ui/", "icons/", "locales/"]
                    .iter()
                    .any(|p| name.starts_with(p)),
                "Unexpected package file"
            );
        }
        Ok(Self {
            manifest,
            files,
            digest: expected.into(),
        })
    }
    pub fn unchanged_sql(&self, old: &Self) -> Result<()> {
        for path in &old.manifest.database.migrations {
            ensure!(
                self.files.get(path) == old.files.get(path),
                "An already published migration was changed or removed"
            );
        }
        Ok(())
    }
}
/// Publisher-side reproducible archive writer. Key material is supplied by the publisher.
pub fn pack(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let mut archive = tar::Builder::new(Vec::new());
    for (path, bytes) in files {
        let mut header = tar::Header::new_ustar();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o444);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, path, bytes.as_slice())
            .with_context(|| format!("Could not pack {path}"))?;
    }
    Ok(zstd::stream::encode_all(
        archive.into_inner()?.as_slice(),
        9,
    )?)
}
