//! Confined file access for the server code. `tools/check-safety-rules.sh` fails if `std::fs` or
//! `tokio::fs` appears in the safety-core or tasks crates. The built screens served from
//! `tasks/src/main.rs` and the migration files read by the portability crate sit outside it.
//!
//! A [`Root`] is a directory that access is confined to. Paths are relative, use `/` between
//! names, and may not hold `..`, `.`, empty names, backslashes or NUL. No symbolic link is
//! followed on the way in, and the last name is opened with `O_NOFOLLOW` on Unix. Folders are
//! made private to the owner (0700) and files 0600.
//!
//! [`Vaults`] is the folder that holds every user's vault, opened once at start-up. A
//! [`VaultContext`] is the acting user's vault, the folder named by their id inside it. It opens
//! only from an [`AccessContext`], as `withVaultContext` does in TypeScript. Once a vaults folder
//! is open, no plain [`Root`] in the process can open it, sit inside it or walk into it.
//!
//! Known gap: names are checked one by one and then opened by path, so a folder swapped for a
//! link between the check and the open could still be followed. `openat2` with
//! `RESOLVE_BENEATH` closes that on Linux and is the next step.

mod allowed_roots;
pub use allowed_roots::AllowedRoots;

use std::fmt;

pub use access_context::AccessContext;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

mod module_files;
mod linked_files;
pub use linked_files::FolderLock;

#[derive(Debug)]
pub enum VaultError {
    /// The path is not a plain relative path.
    BadPath(String),
    /// The path leads through a symbolic link or out of the root.
    Escape(String),
    NotFound(String),
    Io(io::Error),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::BadPath(path) => write!(f, "not a plain relative path: {path:?}"),
            VaultError::Escape(path) => write!(f, "path leaves its folder: {path:?}"),
            VaultError::NotFound(path) => write!(f, "no such file: {path:?}"),
            VaultError::Io(error) => write!(f, "file access failed: {error}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        VaultError::Io(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Link,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Clone, Debug)]
pub struct Root {
    path: PathBuf,
    /// Set only on the handles inside [`Vaults`] and [`VaultContext`].
    in_vault: bool,
}

impl Root {
    /// An existing directory. The path is resolved once, here; nothing below it is followed.
    /// A vaults folder, or anything inside one, is refused.
    pub fn open(path: &Path) -> Result<Root, VaultError> {
        let path = fs::canonicalize(path)?;
        if !fs::metadata(&path)?.is_dir() {
            return Err(VaultError::BadPath(path.display().to_string()));
        }
        if in_vaults(&path) {
            return Err(VaultError::Escape(path.display().to_string()));
        }
        Ok(Root { path, in_vault: false })
    }

    /// Creates the directory, private to the owner, if it is missing. Nothing is made when the
    /// path holds ".." or its deepest existing folder is in a vaults folder.
    pub fn create(path: &Path) -> Result<Root, VaultError> {
        if path.components().any(|part| part == Component::ParentDir) {
            return Err(VaultError::BadPath(path.display().to_string()));
        }
        let existing = path
            .ancestors()
            .find(|folder| fs::symlink_metadata(folder).is_ok())
            .unwrap_or(Path::new("."));
        if in_vaults(&fs::canonicalize(existing)?) {
            return Err(VaultError::Escape(path.display().to_string()));
        }
        fs::create_dir_all(path)?;
        set_mode(path, 0o700)?;
        Root::open(path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether `other` is this directory or inside it.
    pub fn contains(&self, other: &Root) -> bool {
        other.path.starts_with(&self.path)
    }

    pub fn subdir(&self, relative: &str) -> Result<Root, VaultError> {
        let path = self.resolve(relative, true)?;
        if !fs::symlink_metadata(&path)?.is_dir() {
            return Err(VaultError::NotFound(relative.to_owned()));
        }
        Ok(Root { path, in_vault: self.in_vault })
    }

    pub fn create_subdir(&self, relative: &str) -> Result<Root, VaultError> {
        let path = self.resolve(relative, false)?;
        match fs::create_dir(&path) {
            Ok(()) => set_mode(&path, 0o700)?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        self.subdir(relative)
    }

    pub fn read(&self, relative: &str) -> Result<Vec<u8>, VaultError> {
        let path = self.resolve(relative, true)?;
        let mut file = no_follow(OpenOptions::new().read(true)).open(&path)?;
        if !file.metadata()?.is_file() {
            return Err(VaultError::NotFound(relative.to_owned()));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub fn read_to_string(&self, relative: &str) -> Result<String, VaultError> {
        String::from_utf8(self.read(relative)?)
            .map_err(|_| VaultError::Io(io::Error::new(io::ErrorKind::InvalidData, "not UTF-8")))
    }

    /// Writes through a private temporary file and a rename, so readers never see half a file.
    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<(), VaultError> {
        let path = self.resolve(relative, false)?;
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            return Err(VaultError::BadPath(relative.to_owned()));
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("file");
        let temp = path.with_file_name(format!(
            ".{name}.tmp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_create_mode(&mut options, 0o600);
        let result = (|| {
            let mut file = no_follow(&mut options).open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temp, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        Ok(result?)
    }

    pub fn list(&self, relative: &str) -> Result<Vec<Entry>, VaultError> {
        let dir = if relative.is_empty() {
            self.check_vaults(&self.path, relative)?;
            self.path.clone()
        } else {
            self.subdir(relative)?.path
        };
        let mut entries = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let kind = if file_type.is_symlink() {
                EntryKind::Link
            } else if file_type.is_dir() {
                EntryKind::Dir
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            entries.push(Entry { name: entry.file_name().to_string_lossy().into_owned(), kind });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    pub fn remove(&self, relative: &str) -> Result<(), VaultError> {
        let path = self.resolve(relative, true)?;
        Ok(fs::remove_file(path)?)
    }

    /// Checks `relative` and walks it name by name, refusing links. The last name may be
    /// missing unless `must_exist`.
    fn resolve(&self, relative: &str, must_exist: bool) -> Result<PathBuf, VaultError> {
        let names = split_relative(relative)?;
        let mut path = self.path.clone();
        for (index, name) in names.iter().enumerate() {
            path.push(name);
            self.check_vaults(&path, relative)?;
            let last = index + 1 == names.len();
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(VaultError::Escape(relative.to_owned()))
                }
                Ok(meta) if !last && !meta.is_dir() => {
                    return Err(VaultError::NotFound(relative.to_owned()))
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if must_exist || !last {
                        return Err(VaultError::NotFound(relative.to_owned()));
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(path)
    }

    /// A plain handle may not sit in a vaults folder or walk into one.
    fn check_vaults(&self, path: &Path, relative: &str) -> Result<(), VaultError> {
        if !self.in_vault && in_vaults(path) {
            return Err(VaultError::Escape(relative.to_owned()));
        }
        Ok(())
    }
}

/// The canonical paths of the vaults folders this process has opened.
static VAULT_FOLDERS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Whether `path` is a vaults folder or inside one.
fn in_vaults(path: &Path) -> bool {
    let folders = VAULT_FOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    folders.iter().any(|folder| path.starts_with(folder))
}

fn split_relative(relative: &str) -> Result<Vec<&str>, VaultError> {
    let bad = || VaultError::BadPath(relative.to_owned());
    if relative.is_empty() || relative.contains(['\0', '\\']) || relative.starts_with('/') {
        return Err(bad());
    }
    let names: Vec<&str> = relative.split('/').collect();
    // A Windows drive ("C:"); on Windows, any stream name too.
    let first = names[0].as_bytes();
    if (first.len() >= 2 && first[0].is_ascii_alphabetic() && first[1] == b':')
        || (cfg!(windows) && relative.contains(':'))
    {
        return Err(bad());
    }
    if names.iter().any(|name| name.is_empty() || *name == "." || *name == "..") {
        return Err(bad());
    }
    Ok(names)
}

/// The canonical form of an existing directory, for comparing two folders.
pub fn canonical_dir(path: &Path) -> Result<PathBuf, VaultError> {
    Ok(Root::open(path)?.path)
}

/// The folder that holds every user's vault, opened once at start-up. It has no file access of
/// its own. A user's folder inside it opens only through [`VaultContext::for_access`].
pub struct Vaults {
    root: Root,
}

impl Vaults {
    /// Creates the folder, private to the owner, if it is missing, and closes it to plain
    /// handles for the rest of the process.
    pub fn create(path: &Path) -> Result<Vaults, VaultError> {
        fs::create_dir_all(path)?;
        set_mode(path, 0o700)?;
        let path = fs::canonicalize(path)?;
        let mut folders = VAULT_FOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !folders.contains(&path) {
            folders.push(path.clone());
        }
        Ok(Vaults { root: Root { path, in_vault: true } })
    }
}

/// The acting user's vault: `<vaults>/<actor id>`, created private to the owner.
pub struct VaultContext {
    root: Root,
}

impl VaultContext {
    pub fn for_access(vaults: &Vaults, access: &AccessContext) -> Result<VaultContext, VaultError> {
        Ok(VaultContext { root: vaults.root.create_subdir(&access.actor_user_id().to_string())? })
    }

    pub fn read(&self, relative: &str) -> Result<Vec<u8>, VaultError> {
        self.root.read(relative)
    }

    pub fn read_to_string(&self, relative: &str) -> Result<String, VaultError> {
        self.root.read_to_string(relative)
    }

    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<(), VaultError> {
        self.root.write(relative, bytes)
    }

    pub fn create_dir(&self, relative: &str) -> Result<(), VaultError> {
        self.root.create_subdir(relative).map(|_| ())
    }

    pub fn list(&self, relative: &str) -> Result<Vec<Entry>, VaultError> {
        self.root.list(relative)
    }

    pub fn remove(&self, relative: &str) -> Result<(), VaultError> {
        self.root.remove(relative)
    }
}

#[cfg(unix)]
fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW)
}

#[cfg(not(unix))]
fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}

#[cfg(unix)]
fn set_create_mode(options: &mut OpenOptions, mode: u32) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(mode);
}

#[cfg(not(unix))]
fn set_create_mode(_options: &mut OpenOptions, _mode: u32) {}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_A: &str = "00000000-0000-4000-8000-000000000001";
    const USER_B: &str = "00000000-0000-4000-8000-000000000002";

    fn open(vaults: &Vaults, user_id: &str) -> VaultContext {
        let access = AccessContext::new(user_id.parse().unwrap(), "test");
        VaultContext::for_access(vaults, &access).unwrap()
    }

    fn vaults() -> (tempfile::TempDir, Vaults) {
        let dir = tempfile::tempdir().unwrap();
        let vaults = Vaults::create(&dir.path().join("vaults")).unwrap();
        (dir, vaults)
    }

    fn escaped<T>(result: Result<T, VaultError>) -> bool {
        matches!(result, Err(VaultError::Escape(_)))
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let (_dir, vaults) = vaults();
        let vault = open(&vaults, USER_A);
        vault.create_dir("notes").unwrap();
        vault.write("notes/today.md", b"hello").unwrap();
        assert_eq!(vault.read("notes/today.md").unwrap(), b"hello");
        vault.write("notes/today.md", b"again").unwrap();
        assert_eq!(vault.read_to_string("notes/today.md").unwrap(), "again");
        let names: Vec<_> = vault.list("notes").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["today.md"]);
    }

    #[test]
    fn refuses_paths_that_climb_out() {
        let (_dir, vaults) = vaults();
        let a = open(&vaults, USER_A);
        let b = open(&vaults, USER_B);
        b.write("private.md", b"b only").unwrap();
        for path in [
            format!("../{USER_B}/private.md"),
            "/etc/passwd".to_owned(),
            "notes/../../x".to_owned(),
            "..\\x".to_owned(),
            "C:/x".to_owned(),
            "./x".to_owned(),
            "a//b".to_owned(),
            String::new(),
        ] {
            assert!(matches!(a.read(&path), Err(VaultError::BadPath(_))), "read {path:?}");
            assert!(matches!(a.write(&path, b"x"), Err(VaultError::BadPath(_))), "write {path:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_links() {
        let (dir, vaults) = vaults();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        let a = open(&vaults, USER_A);
        let a_dir = vaults.root.path().join(USER_A);
        std::os::unix::fs::symlink(&outside, a_dir.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path(), a_dir.join("linkdir")).unwrap();
        assert!(matches!(a.read("link.txt"), Err(VaultError::Escape(_))));
        assert!(matches!(a.write("link.txt", b"x"), Err(VaultError::Escape(_))));
        assert!(matches!(a.read("linkdir/outside.txt"), Err(VaultError::Escape(_))));
        assert!(matches!(a.list("linkdir"), Err(VaultError::Escape(_))));
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_files_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, vaults) = vaults();
        let a = open(&vaults, USER_A);
        a.write("secret.md", b"x").unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&vaults.root.path().join(USER_A)), 0o700);
        assert_eq!(mode(&vaults.root.path().join(USER_A).join("secret.md")), 0o600);
    }

    #[test]
    fn plain_handles_cannot_open_the_vaults_folder() {
        let (dir, vaults) = vaults();
        open(&vaults, USER_A).write("secret.md", b"a only").unwrap();
        let folder = dir.path().join("vaults");
        assert!(escaped(Root::open(&folder)));
        assert!(escaped(Root::open(&folder.join(USER_A))));
        assert!(escaped(Root::create(&folder.join(USER_B))));
        assert!(!folder.join(USER_B).exists());
        let climb = dir.path().join("new/../vaults/x");
        assert!(matches!(Root::create(&climb), Err(VaultError::BadPath(_))));
        assert!(!folder.join("x").exists());
    }

    #[test]
    fn plain_handles_cannot_walk_into_the_vaults_folder() {
        let (dir, vaults) = vaults();
        open(&vaults, USER_A).write("secret.md", b"a only").unwrap();
        let parent = Root::open(dir.path()).unwrap();
        let secret = format!("vaults/{USER_A}/secret.md");
        assert!(escaped(parent.read(&secret)));
        assert!(escaped(parent.write(&secret, b"changed")));
        assert!(escaped(parent.remove(&secret)));
        assert!(escaped(parent.list("vaults")));
        assert!(escaped(parent.subdir(&format!("vaults/{USER_A}"))));
        assert!(escaped(parent.create_subdir(&format!("vaults/{USER_B}"))));
        assert!(escaped(parent.write("vaults", b"x")));
        assert_eq!(open(&vaults, USER_A).read("secret.md").unwrap(), b"a only");
    }

    #[test]
    fn a_handle_made_before_the_vaults_folder_opens_is_closed_after() {
        let dir = tempfile::tempdir().unwrap();
        let early = Root::create(&dir.path().join("vaults")).unwrap();
        early.write("before.md", b"x").unwrap();
        let _vaults = Vaults::create(&dir.path().join("vaults")).unwrap();
        assert!(escaped(early.read("before.md")));
        assert!(escaped(early.list("")));
        assert!(escaped(early.write("after.md", b"x")));
    }
}
