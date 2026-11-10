//! Migration file loading and checksums (`packages/db/src/migrations/sql-runner.ts` and
//! `module-sql-runner.ts`).

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::js;

const BACKFILL_DOMAIN: &[u8] = b"moss:sql-migration+backfill:v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationFile {
    pub version: String,
    pub name: String,
    pub checksum: String,
    pub backfill: Option<String>,
    /// SHA-256 of the raw SQL bytes, the only rule before backfill sidecars existed.
    pub old_rule_checksum: String,
}

/// `.sql` names in the default JavaScript sort order.
fn sql_names(directory: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let name = entry?.file_name().into_string().map_err(|name| {
            std::io::Error::new(ErrorKind::InvalidData, format!("file name is not UTF-8: {name:?}"))
        })?;
        if name.ends_with(".sql") {
            names.push(name);
        }
    }
    names.sort_by(|a, b| js::cmp_utf16(a, b));
    Ok(names)
}

/// Reads a file, with Node's wording for a missing one.
fn read(directory: &Path, name: &str) -> Result<Vec<u8>, String> {
    let path = directory.join(name);
    fs::read(&path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => {
            format!("ENOENT: no such file or directory, open '{}'", path.display())
        }
        _ => format!("{error}, open '{}'", path.display()),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `loadMigrationFiles`: core and built-in module folders. Files are read one at a time, so
/// when several are bad the first in name order is reported. Node reads them all at once and
/// reports whichever fails first.
pub fn load_migration_files(directory: &Path) -> Result<Vec<MigrationFile>, String> {
    let names = sql_names(directory).map_err(|error| error.to_string())?;
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let sql_bytes = read(directory, &name)?;
        let sql = std::str::from_utf8(&sql_bytes)
            .map_err(|_| format!("Migration file {name} must contain valid UTF-8"))?;
        let version = name.split('_').next().unwrap_or_default().to_string();
        if version.is_empty() {
            return Err(format!("Migration file {name} is missing a version prefix"));
        }

        let old_rule_checksum = sha256_hex(&sql_bytes);
        let (checksum, backfill) = match declared_backfill(sql, &name)? {
            None => (old_rule_checksum.clone(), None),
            Some(backfill) => {
                let backfill_bytes = read(directory, &backfill)?;
                std::str::from_utf8(&backfill_bytes)
                    .map_err(|_| format!("Migration file {backfill} must contain valid UTF-8"))?;
                // Every byte counts, BOM and CRLF included. The lengths make the joins unambiguous.
                let mut hash = Sha256::new();
                hash.update(BACKFILL_DOMAIN);
                hash.update(format!("{}:", sql_bytes.len()));
                hash.update(&sql_bytes);
                hash.update(format!("{}:", backfill_bytes.len()));
                hash.update(&backfill_bytes);
                (hex::encode(hash.finalize()), Some(backfill))
            }
        };
        files.push(MigrationFile { version, name, checksum, backfill, old_rule_checksum });
    }
    Ok(files)
}

/// `declaredBackfill`. Lines are split on `\n` and trimmed the JavaScript way, which also
/// removes the `\r` of a CRLF. A lone `\r` does not end a line.
fn declared_backfill(sql: &str, name: &str) -> Result<Option<String>, String> {
    let lines: Vec<&str> = sql.split('\n').map(js::trim).collect();
    let is_declaration = |line: &str| {
        line.strip_prefix("--")
            .is_some_and(|rest| rest.trim_start_matches(js::is_space).starts_with("moss:backfill"))
    };
    let declarations: Vec<usize> = (0..lines.len()).filter(|&at| is_declaration(lines[at])).collect();
    let Some(&first) = declarations.first() else {
        return Ok(None);
    };

    let expected = format!("{}.backfill.mjs", name.strip_suffix(".sql").unwrap_or(name));
    let header_is_comments = lines[..first].iter().all(|line| line.is_empty() || line.starts_with("--"));
    if declarations.len() != 1
        || !is_backfill_file_name(&expected)
        || lines[first] != format!("-- moss:backfill {expected}")
        || !header_is_comments
    {
        return Err(format!("Migration {name} has an invalid backfill declaration"));
    }
    Ok(Some(expected))
}

/// `/^[A-Za-z0-9][A-Za-z0-9_-]*\.backfill\.mjs$/`
fn is_backfill_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".backfill.mjs") else {
        return false;
    };
    let mut chars = stem.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `loadModuleMigrationFiles` without its wire-contract SQL validator. A missing folder is
/// empty, bad UTF-8 is replaced rather than refused, and the checksum is of the decoded text.
pub fn load_module_migration_files(directory: &Path) -> Result<Vec<MigrationFile>, String> {
    let names = match sql_names(directory) {
        Ok(names) => names,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let bytes = read(directory, &name)?;
        let sql = String::from_utf8_lossy(&bytes);
        files.push(MigrationFile {
            version: name.split('_').next().unwrap_or_default().to_string(),
            checksum: sha256_hex(sql.as_bytes()),
            old_rule_checksum: sha256_hex(&bytes),
            backfill: None,
            name,
        });
    }
    Ok(files)
}

/// `assertUniqueMigrationVersions`.
pub fn assert_unique_versions(files: &[MigrationFile]) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut duplicates: Vec<&str> = Vec::new();
    for file in files {
        if !seen.insert(file.version.as_str()) && !duplicates.contains(&file.version.as_str()) {
            duplicates.push(&file.version);
        }
    }
    if duplicates.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Duplicate migration version numbers across directories: {}",
        duplicates.join(", ")
    ))
}
