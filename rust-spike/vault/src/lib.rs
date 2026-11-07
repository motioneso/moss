//! The only file access in the Rust server. `tools/check-safety-rules.sh` fails the build if
//! `std::fs` or `tokio::fs` appears in the server crates outside this one.
//!
//! A [`Root`] is a directory that access is confined to. Paths are relative, use `/` between
//! names, and may not hold `..`, `.`, empty names, backslashes or NUL. No symbolic link is
//! followed on the way in, and the last name is opened with `O_NOFOLLOW` on Unix. Folders are
//! made private to the owner (0700) and files 0600.
//!
//! A [`VaultContext`] is one user's vault: the folder named by their id under the vaults root.
//!
//! Known gap: names are checked one by one and then opened by path, so a folder swapped for a
//! link between the check and the open could still be followed. `openat2` with
//! `RESOLVE_BENEATH` closes that on Linux and is the next step.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
}

impl Root {
    /// An existing directory. The path is resolved once, here; nothing below it is followed.
    pub fn open(path: &Path) -> Result<Root, VaultError> {
        let path = fs::canonicalize(path)?;
        if !fs::metadata(&path)?.is_dir() {
            return Err(VaultError::BadPath(path.display().to_string()));
        }
        Ok(Root { path })
    }

    /// Creates the directory, private to the owner, if it is missing.
    pub fn create(path: &Path) -> Result<Root, VaultError> {
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
        Ok(Root { path })
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
        let dir = if relative.is_empty() { self.path.clone() } else { self.subdir(relative)?.path };
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

/// One user's vault: `<vaults>/<user id>`, created private to the owner.
pub struct VaultContext {
    root: Root,
}

impl VaultContext {
    pub fn for_user(vaults: &Root, user_id: &str) -> Result<VaultContext, VaultError> {
        if !is_uuid(user_id) {
            return Err(VaultError::BadPath(user_id.to_owned()));
        }
        Ok(VaultContext { root: vaults.create_subdir(&user_id.to_ascii_lowercase())? })
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

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
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

    fn vaults() -> (tempfile::TempDir, Root) {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::create(&dir.path().join("vaults")).unwrap();
        (dir, root)
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let (_dir, vaults) = vaults();
        let vault = VaultContext::for_user(&vaults, USER_A).unwrap();
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
        let a = VaultContext::for_user(&vaults, USER_A).unwrap();
        let b = VaultContext::for_user(&vaults, USER_B).unwrap();
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
        assert!(VaultContext::for_user(&vaults, "../x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_links() {
        let (dir, vaults) = vaults();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        let a = VaultContext::for_user(&vaults, USER_A).unwrap();
        let a_dir = vaults.path().join(USER_A);
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
        let a = VaultContext::for_user(&vaults, USER_A).unwrap();
        a.write("secret.md", b"x").unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&vaults.path().join(USER_A)), 0o700);
        assert_eq!(mode(&vaults.path().join(USER_A).join("secret.md")), 0o600);
    }
}
