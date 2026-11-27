//! Phase 7 part 4: encrypted backups of one instance folder, a ledger, retention and a restore
//! drill that proves a backup opens and restores before it counts as verified.

pub mod archive;
pub mod capture;
pub mod drill;
pub mod fence;
pub mod ledger;
pub mod retention;

use std::path::{Path, PathBuf};

/// Where an instance keeps its backups and their ledger.
pub const BACKUPS_FOLDER: &str = "backups";
pub const ARCHIVE_SUFFIX: &str = ".mossbak";

/// Top-level instance entries a backup never copies as files. The database travels as a
/// dump, the key bundle travels in the archive header, the key-file choice names a path on
/// this computer only, and the rest are this computer's runtime state.
const NOT_COPIED: [&str; 6] = [
    bundled_db_folder(),
    BACKUPS_FOLDER,
    keystore::custody::BUNDLE_FILE,
    "key-file-choice.json",
    fence::FENCE_FILE,
    keystore::custody::LEGACY_CREDENTIALS,
];

const fn bundled_db_folder() -> &'static str {
    "database"
}

pub fn database_root(instance: &Path) -> PathBuf {
    instance.join(bundled_db_folder())
}

pub fn backups_dir(instance: &Path) -> PathBuf {
    instance.join(BACKUPS_FOLDER)
}

/// A file a backup copies: its path inside the instance with `/` separators, and on disk.
pub struct InstanceFile {
    pub name: String,
    pub path: PathBuf,
}

/// Lists the files a backup copies, sorted by name. Links and other special entries are
/// returned separately and never followed.
pub fn instance_files(instance: &Path) -> Result<(Vec<InstanceFile>, Vec<String>), String> {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut stack = vec![(instance.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            let file_name = entry.file_name();
            let Some(text) = file_name.to_str() else {
                skipped.push(format!("{prefix}{}", file_name.to_string_lossy()));
                continue;
            };
            if prefix.is_empty() && NOT_COPIED.contains(&text) {
                continue;
            }
            let name = format!("{prefix}{text}");
            let kind = entry.file_type().map_err(|e| format!("{name}: {e}"))?;
            if kind.is_dir() {
                stack.push((entry.path(), format!("{name}/")));
            } else if kind.is_file() {
                files.push(InstanceFile {
                    name,
                    path: entry.path(),
                });
            } else {
                skipped.push(name);
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    skipped.sort();
    Ok((files, skipped))
}

/// A relative name from an archive, as a path under `root`. Refuses anything that could land
/// outside it.
pub fn safe_join(root: &Path, name: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    if name.is_empty() {
        return Err("an archive file has no name".into());
    }
    for part in name.split('/') {
        let bad = part.is_empty()
            || part == "."
            || part == ".."
            || part.contains(['\\', ':', '\0'])
            || (cfg!(windows) && part.ends_with(['.', ' ']));
        if bad {
            return Err(format!("unsafe file name in the archive: {name:?}"));
        }
        path.push(part);
    }
    Ok(path)
}

pub fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `(year, month, day)` of a Unix day number.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// A sortable backup id such as `20261127T031500Z-1a2b3c`.
pub fn new_backup_id(created_at: u64) -> String {
    let days = (created_at / 86_400) as i64;
    let (year, month, day) = civil_from_days(days);
    let rest = created_at % 86_400;
    let suffix: [u8; 3] = rand::random();
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z-{}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        hex::encode(suffix)
    )
}

/// Ids name files, so only these characters are allowed.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Resolves an existing instance folder. Windows keeps the plain drive form, because the
/// private-folder checks refuse the `\\?\` form that `canonicalize` returns there.
pub fn resolve_instance(path: &Path) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(windows)]
    {
        let _ = real;
        std::path::absolute(path).map_err(|e| format!("{}: {e}", path.display()))
    }
    #[cfg(not(windows))]
    Ok(real)
}

/// Creates a new owner-only file. Fails if it exists.
pub fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Creates an owner-only folder and its parents. Windows folders inherit the instance
/// folder's owner-only access list.
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Waits for a test hook file to disappear. Only the runner's `--test-pause` uses it.
pub fn test_pause(marker: &Path, body: &str) -> Result<(), String> {
    std::fs::write(marker, body).map_err(|e| format!("pause marker: {e}"))?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(300);
    while marker.exists() {
        if std::time::Instant::now() > until {
            return Err("the test pause was never released".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_ids() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_784), (2026, 11, 27));
        let id = new_backup_id(1_795_747_500);
        assert!(id.starts_with("20261127T"), "{id}");
        assert!(valid_id(&id));
        assert!(!valid_id("../x"));
    }

    #[test]
    fn archive_names_stay_inside_the_root() {
        let root = Path::new("/scratch/files");
        assert!(safe_join(root, "notes/a.md").is_ok());
        for bad in ["", "../x", "a/../b", "/abs", "a//b", "a\\b", "c:x", "./a"] {
            assert!(safe_join(root, bad).is_err(), "{bad:?} was accepted");
        }
    }
}
