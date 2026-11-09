//! Where one install keeps its database files. Everything sits under one root that only
//! this OS user can open.

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io;
use std::path::{Path, PathBuf};

/// Longest Unix socket path, NUL included: 104 on macOS, 108 on Linux. The smaller wins.
#[cfg(unix)]
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
    /// Held by the one supervisor allowed to run this install.
    pub lock: PathBuf,
    #[cfg(windows)]
    windows: std::sync::Arc<windows::Directories>,
}

impl Layout {
    /// Creates the owner-only folders. `root` may not exist yet.
    #[cfg(unix)]
    pub fn create(root: &Path) -> io::Result<Layout> {
        private_dir(root)?;
        let layout = Layout::at(root.canonicalize()?)?;
        // Each inner folder must be a real folder this user owns, because the socket folder may
        // sit in a shared temporary folder under a predictable name.
        for dir in [&layout.run, &layout.secrets, &layout.logs] {
            owned_private_dir(dir)?;
        }
        layout.check_run()?;
        Ok(layout)
    }

    /// Fails unless the socket folder holds only what this user put there.
    ///
    /// Call it before reading the state file or connecting. The folder may sit in a shared
    /// temporary folder under a predictable name, so after a reboot another user could create it
    /// first, with a state file and a socket of their own.
    #[cfg(unix)]
    pub fn check_run(&self) -> io::Result<()> {
        check_private_dir(&self.run, unsafe { libc::geteuid() })
    }

    /// The layout of an install that already exists. Creates and changes nothing.
    #[cfg(unix)]
    pub fn open(root: &Path) -> io::Result<Layout> {
        let real = root.canonicalize().map_err(|e| {
            io::Error::new(e.kind(), format!("no install at {}: {e}", root.display()))
        })?;
        Layout::at(real)
    }

    #[cfg(unix)]
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
    format!(
        "moss-{}",
        &sha2_hex(data.as_os_str().as_encoded_bytes())[..12]
    )
}

/// `<root>/run`, unless the socket path would be too long for the OS. Then a short owner-only
/// folder in the per-user runtime folder, named from a hash of the root.
#[cfg(unix)]
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
        Err(io::Error::other(
            "no folder short enough for the database socket",
        ))
    }
}

#[cfg(unix)]
fn socket_path_fits(dir: &Path) -> bool {
    dir.as_os_str().len() + "/.s.PGSQL.65535".len() < SOCKET_PATH_MAX
}

fn sha2_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// A folder only this user can enter. An existing folder is tightened to 0700.
#[cfg(unix)]
pub fn private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// `private_dir` for a folder Moss makes itself. An existing one must be a real folder, not a
/// link, and belong to this user.
#[cfg(unix)]
fn owned_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other(format!(
            "{} is not a folder that belongs to this user",
            path.display()
        )));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

/// Fails unless `path` is a real folder owned by `uid` that no one else can open, inside a parent
/// where no other user can rename it or put another folder in its place. Only the immediate parent
/// is checked. The folders above it are trusted.
#[cfg(unix)]
fn check_private_dir(path: &Path, uid: u32) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let refuse = |why: &str| Err(io::Error::other(format!("{} {why}", path.display())));
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return refuse("is not a real folder");
    }
    if meta.uid() != uid {
        return refuse("belongs to another user");
    }
    if meta.mode() & 0o077 != 0 {
        return refuse("can be opened by other users");
    }

    // Others may write to a shared parent only if it is sticky, so they cannot move this folder.
    let parent = std::fs::metadata(path.parent().unwrap_or(Path::new("/")))?;
    let others_can_write = parent.mode() & 0o022 != 0;
    let sticky = parent.mode() & 0o1000 != 0;
    if (parent.uid() != uid && parent.uid() != 0) || (others_can_write && !sticky) {
        return refuse("is in a folder where another user could replace it");
    }
    Ok(())
}

/// A new file only this user can read or write.
#[cfg(unix)]
pub fn private_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Writes `bytes` to `path` through a private temporary file and a rename.
#[cfg(unix)]
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut file = private_file(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[cfg(all(test, unix))]
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

    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A temporary folder closed to others. Ubuntu's umask would leave it group-writable.
    fn private_tempdir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        chmod(dir.path(), 0o700);
        dir
    }

    fn me() -> u32 {
        unsafe { libc::geteuid() }
    }

    /// `parent/run`, a folder with `mode`.
    fn run_folder(parent: &Path, mode: u32) -> PathBuf {
        let run = parent.join("run");
        std::fs::create_dir(&run).unwrap();
        chmod(&run, mode);
        run
    }

    fn refusal(path: &Path, uid: u32) -> String {
        check_private_dir(path, uid).unwrap_err().to_string()
    }

    #[test]
    fn a_private_socket_folder_passes() {
        let dir = private_tempdir();
        check_private_dir(&run_folder(dir.path(), 0o700), me()).unwrap();
    }

    #[test]
    fn a_planted_link_is_refused() {
        let dir = private_tempdir();
        let theirs = run_folder(dir.path(), 0o700);
        let link = dir.path().join("moss-db-link");
        std::os::unix::fs::symlink(&theirs, &link).unwrap();
        assert!(refusal(&link, me()).ends_with("is not a real folder"));
    }

    #[test]
    fn a_folder_of_another_user_is_refused() {
        let dir = private_tempdir();
        let run = run_folder(dir.path(), 0o700);
        assert!(refusal(&run, me() + 1).ends_with("belongs to another user"));
    }

    #[test]
    fn a_folder_others_can_open_is_refused() {
        let dir = private_tempdir();
        let run = run_folder(dir.path(), 0o755);
        assert!(refusal(&run, me()).ends_with("can be opened by other users"));
    }

    #[test]
    fn a_shared_parent_must_be_sticky() {
        let dir = private_tempdir();
        let shared = dir.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        let run = run_folder(&shared, 0o700);
        chmod(&shared, 0o777);
        assert!(refusal(&run, me()).ends_with("is in a folder where another user could replace it"));
        chmod(&shared, 0o1777);
        check_private_dir(&run, me()).unwrap();
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
        assert!(
            error
                .to_string()
                .contains("is not a folder that belongs to this user"),
            "{error}"
        );
    }
}

#[cfg(windows)]
mod windows;

/// Bounded UTF-8 reads for the supervisor's small metadata and password files.
fn read_bounded(file: std::fs::File, limit: u64) -> std::io::Result<String> {
    use std::io::Read;
    let mut text = String::new();
    file.take(limit + 1).read_to_string(&mut text)?;
    if text.len() as u64 > limit {
        return Err(std::io::Error::other("private file exceeds its size limit"));
    }
    Ok(text)
}

impl Layout {
    pub(crate) fn read_secret(&self, role: &str) -> std::io::Result<String> {
        check_secret_name(role)?;
        #[cfg(unix)]
        let file = std::fs::File::open(self.secrets.join(role))?;
        #[cfg(windows)]
        let file = self.windows.secrets.open_file(std::ffi::OsStr::new(role))?;
        read_bounded(file, 256)
    }

    pub(crate) fn create_secret(&self, role: &str) -> std::io::Result<std::fs::File> {
        check_secret_name(role)?;
        #[cfg(unix)]
        {
            private_file(&self.secrets.join(role))
        }
        #[cfg(windows)]
        {
            self.windows.secrets.create_file(std::ffi::OsStr::new(role))
        }
    }

    #[cfg(unix)]
    pub fn write_state(&self, bytes: &[u8]) -> std::io::Result<()> {
        self.check_run()?;
        write_private(&self.state_file(), bytes)
    }

    #[cfg(unix)]
    pub fn read_state(&self) -> std::io::Result<String> {
        self.check_run()?;
        read_bounded(std::fs::File::open(self.state_file())?, 65536)
    }
}

fn check_secret_name(role: &str) -> std::io::Result<()> {
    if !crate::RUNTIME_ROLES.contains(&role)
        && role != crate::SUPERUSER
        && !["session-signing-secret", "connector-key"].contains(&role)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unknown private credential name",
        ));
    }
    Ok(())
}
