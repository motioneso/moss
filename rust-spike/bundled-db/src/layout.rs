//! Where one install keeps its database files. Everything sits under one root that only
//! this OS user can open.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Longest Unix socket path, NUL included: 104 on macOS, 108 on Linux. The smaller wins.
const SOCKET_PATH_MAX: usize = 104;

#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
    /// The Postgres data directory (`PGDATA`).
    pub data: PathBuf,
    /// Socket directory and the running state file.
    pub run: PathBuf,
    /// Spike stand-in for the OS key store: one owner-only file per database password.
    pub secrets: PathBuf,
    pub logs: PathBuf,
    /// Held with `flock` by the one supervisor allowed to run this install.
    pub lock: PathBuf,
}

impl Layout {
    /// Creates the owner-only folders. `root` may not exist yet.
    pub fn create(root: &Path) -> io::Result<Layout> {
        private_dir(root)?;
        let layout = Layout::at(root.canonicalize()?)?;
        // Each inner folder must be a real folder this user owns, because the socket folder may
        // sit in a shared temporary folder under a predictable name.
        for dir in [&layout.run, &layout.secrets, &layout.logs] {
            owned_private_dir(dir)?;
        }
        Ok(layout)
    }

    /// The layout of an install that already exists. Creates and changes nothing.
    pub fn open(root: &Path) -> io::Result<Layout> {
        let real = root
            .canonicalize()
            .map_err(|e| io::Error::new(e.kind(), format!("no install at {}: {e}", root.display())))?;
        Layout::at(real)
    }

    fn at(root: PathBuf) -> io::Result<Layout> {
        Ok(Layout {
            data: root.join("db"),
            run: socket_dir(&root)?,
            secrets: root.join("secrets"),
            logs: root.join("logs"),
            lock: root.join("moss-db.lock"),
            root,
        })
    }

    pub fn state_file(&self) -> PathBuf {
        self.run.join("state.json")
    }

    pub fn postmaster_pid(&self) -> PathBuf {
        self.data.join("postmaster.pid")
    }

    pub fn cluster_name(&self) -> String {
        cluster_name(&self.data)
    }
}

/// The Postgres `cluster_name` for a data folder: `moss-` and 12 hex digits of its path hash.
/// Server processes carry it in their titles, so it tells this install's leftovers apart from
/// any other install's.
pub fn cluster_name(data: &Path) -> String {
    format!("moss-{}", &sha2_hex(data.as_os_str().as_encoded_bytes())[..12])
}

/// `<root>/run`, unless the socket path would be too long for the OS. Then a short owner-only
/// folder in the per-user runtime folder, named from a hash of the root.
fn socket_dir(root: &Path) -> io::Result<PathBuf> {
    let preferred = root.join("run");
    if socket_path_fits(&preferred) {
        return Ok(preferred);
    }
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .or_else(|| std::env::var_os("TMPDIR"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let digest = sha2_hex(root.as_os_str().as_encoded_bytes());
    let short = base.join(format!("moss-db-{}", &digest[..12]));
    if socket_path_fits(&short) {
        Ok(short)
    } else {
        Err(io::Error::other("no folder short enough for the database socket"))
    }
}

fn socket_path_fits(dir: &Path) -> bool {
    dir.as_os_str().len() + "/.s.PGSQL.65535".len() < SOCKET_PATH_MAX
}

fn sha2_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// A folder only this user can enter. An existing folder is tightened to 0700.
pub fn private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// `private_dir` for a folder Moss makes itself. An existing one must be a real folder, not a
/// link, and belong to this user.
fn owned_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other(format!("{} is not a folder that belongs to this user", path.display())));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// A new file only this user can read or write.
pub fn private_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

/// Writes `bytes` to `path` through a private temporary file and a rename.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut file = private_file(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("typo");
        assert!(Layout::open(&missing).is_err());
        assert!(!missing.exists());

        let layout = Layout::create(&dir.path().join("install")).unwrap();
        let opened = Layout::open(&layout.root).unwrap();
        assert_eq!(opened.run, layout.run);
        assert_eq!(opened.data, layout.data);
        assert!(!opened.data.exists());
    }

    #[test]
    fn a_linked_inner_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let root = dir.path().join("install");
        std::fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("logs")).unwrap();
        let error = Layout::create(&root).unwrap_err();
        assert!(error.to_string().contains("is not a folder that belongs to this user"), "{error}");
    }
}
