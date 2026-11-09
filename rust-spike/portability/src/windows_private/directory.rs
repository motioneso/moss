//! A pinned path boundary above the private-object primitives.
//!
//! The OS, administrators, SYSTEM and processes running as this user are trusted. Ancestors
//! may be shared, but every component is opened without following reparse points and kept
//! open without delete sharing before the next component is resolved. The final directory
//! must satisfy the exact private-object policy. Only local fixed drives are supported.
//!
//! This does not provision Postgres or replace the canonical Phase 1 supervisor.

use super::*;
use std::ffi::OsStr;
use std::path::{Component, PathBuf, Prefix};
use std::sync::Arc;

mod state;

/// Keeps the entire ancestor chain alive, including when a child outlives its parent value.
pub struct PrivateDirectory {
    path: PathBuf,
    _pin: Arc<Pin>,
}

struct Pin {
    _directory: File,
    _parent: Option<Arc<Pin>>,
}

impl PrivateDirectory {
    /// Open an existing private root, pinning its ancestors from the volume root down.
    /// Missing ancestors are errors; this never repairs or changes an existing ACL.
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::root(path, false)
    }

    /// Create one private root under existing ancestors. An existing root is refused.
    pub fn create(path: &Path) -> io::Result<Self> {
        Self::root(path, true)
    }

    fn root(path: &Path, create: bool) -> io::Result<Self> {
        crate::windows_child::require_standard_user()?;
        let (mut current, names) = local_path(path)?;
        let drive = wide(&current)?;
        // SAFETY: drive is a live, NUL-terminated drive-root path. DRIVE_FIXED is 3.
        if unsafe { GetDriveTypeW(drive.as_ptr()) } != 3 {
            return Err(refused("private directories require a local fixed drive"));
        }
        let mut parent = Arc::new(Pin {
            _directory: open_ancestor(&current)?,
            _parent: None,
        });
        for (index, name) in names.iter().enumerate() {
            current.push(name);
            let last = index + 1 == names.len();
            let directory = if last {
                if create {
                    create_directory(&current)?
                } else {
                    open_directory(&current)?
                }
            } else {
                open_ancestor(&current)?
            };
            parent = Arc::new(Pin {
                _directory: directory,
                _parent: Some(parent),
            });
        }
        Ok(Self {
            path: current,
            _pin: parent,
        })
    }

    /// For passing to existing code only while this value remains alive. Do not canonicalize
    /// a caller-supplied path before opening: that would hide a junction from validation.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn open_directory(&self, name: &OsStr) -> io::Result<Self> {
        self.child(name, false)
    }

    pub fn create_directory(&self, name: &OsStr) -> io::Result<Self> {
        self.child(name, true)
    }

    fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        let path = self.child_path(name)?;
        let directory = if create {
            create_directory(&path)?
        } else {
            open_directory(&path)?
        };
        Ok(Self {
            path,
            _pin: Arc::new(Pin {
                _directory: directory,
                _parent: Some(self._pin.clone()),
            }),
        })
    }

    pub fn create_file(&self, name: &OsStr) -> io::Result<File> {
        create_file(&self.child_path(name)?)
    }

    pub fn open_file(&self, name: &OsStr) -> io::Result<File> {
        open_file(&self.child_path(name)?)
    }

    fn child_path(&self, name: &OsStr) -> io::Result<PathBuf> {
        check_name(name)?;
        Ok(self.path.join(name))
    }
}

fn local_path(path: &Path) -> io::Result<(PathBuf, Vec<std::ffi::OsString>)> {
    // Restrict Win32 aliases, ADS, dot components and device namespaces before Path's
    // component iterator can normalize them. Unicode remains lossless (UTF-16 below).
    let raw: Vec<u16> = path.as_os_str().encode_wide().collect();
    if raw.len() < 4
        || !matches!(raw[0], 65..=90 | 97..=122)
        || raw[1] != b':' as u16
        || raw[2] != b'\\' as u16
    {
        return Err(invalid_name());
    }
    for name in raw[3..].split(|c| *c == b'\\' as u16) {
        use std::os::windows::ffi::OsStringExt;
        check_name(&std::ffi::OsString::from_wide(name))?;
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(invalid_name());
    };
    if !matches!(prefix.kind(), Prefix::Disk(_)) || components.next() != Some(Component::RootDir) {
        return Err(invalid_name());
    }
    let mut root = prefix.as_os_str().to_os_string();
    root.push("\\");
    let root = PathBuf::from(root);
    let mut names = Vec::new();
    for component in components {
        match component {
            Component::Normal(name) => names.push(name.to_owned()),
            _ => return Err(invalid_name()),
        }
    }
    Ok((root, names))
}

fn check_name(name: &OsStr) -> io::Result<()> {
    let text: Vec<u16> = name.encode_wide().collect();
    if text.is_empty()
        || text
            .iter()
            .any(|c| *c < 32 || b"\\/:*?\"<>|".contains(&(*c as u8)) && *c < 128)
        || matches!(text.last(), Some(32 | 46))
    {
        return Err(invalid_name());
    }
    let stem = name
        .to_string_lossy()
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err(invalid_name());
    }
    Ok(())
}

fn invalid_name() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "expected an unambiguous local path or single child name",
    )
}

fn open_ancestor(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut info: FileInformation = unsafe { std::mem::zeroed() };
    // SAFETY: the file handle and POD output buffer remain live through the call.
    check(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
    if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(refused(
            "ancestor must be a real directory, not a reparse point",
        ));
    }
    Ok(file)
}

#[cfg(test)]
mod tests;
