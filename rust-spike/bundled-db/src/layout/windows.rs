//! Windows side of the canonical layout; no second provisioner or supervisor.
//!
//! The OS, administrators, SYSTEM and same-user processes are trusted. The portability
//! boundary pins every existing ancestor (shared ancestors are allowed), refuses reparses,
//! and validates the exact private DACL on the root and each owned child. Keep this Layout
//! alive for every path-based Postgres operation. Missing ancestors are never manufactured.
use super::Layout;
use portability::windows_private::directory::PrivateDirectory;
use std::ffi::OsStr;
use std::fmt;
use std::io;
use std::path::Path;
use std::sync::Arc;

pub(super) struct Directories {
    _root: PrivateDirectory,
    _data: PrivateDirectory,
    run: PrivateDirectory,
    pub(super) secrets: PrivateDirectory,
    _logs: PrivateDirectory,
}

impl fmt::Debug for Directories {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PinnedWindowsDirectories")
    }
}

impl Layout {
    /// Create or resume a private layout. Existing ACLs are checked, never repaired.
    /// Partial setup can be resumed; a missing *ancestor* is still an error.
    pub fn create(path: &Path) -> io::Result<Self> {
        Self::windows_layout(path, true)
    }

    /// Open and validate an existing complete layout, without creating anything.
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::windows_layout(path, false)
    }

    fn windows_layout(path: &Path, create: bool) -> io::Result<Self> {
        // Never canonicalize the caller's path: that would erase junction evidence.
        let root = match PrivateDirectory::open(path) {
            Ok(root) => root,
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                PrivateDirectory::create(path)?
            }
            Err(error) => return Err(error),
        };
        let child = |name: &str| {
            let name = OsStr::new(name);
            match root.open_directory(name) {
                Ok(dir) => Ok(dir),
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    root.create_directory(name)
                }
                Err(error) => Err(error),
            }
        };
        // The future supervisor must qualify initdb inside this pinned empty data
        // directory with real Windows Postgres before enabling app creation.
        let data = child("db")?;
        let run = child("run")?;
        let secrets = child("secrets")?;
        let logs = child("logs")?;
        Ok(Self {
            root: root.path().to_owned(),
            data: data.path().to_owned(),
            run: run.path().to_owned(),
            secrets: secrets.path().to_owned(),
            logs: logs.path().to_owned(),
            lock: root.path().join("moss-db.lock"),
            windows: Arc::new(Directories {
                _root: root,
                _data: data,
                run,
                secrets,
                _logs: logs,
            }),
        })
    }

    pub fn check_run(&self) -> io::Result<()> {
        // Re-open the path as well, so accidentally changed public path fields cannot
        // redirect a later state read to an unvalidated directory.
        let run = PrivateDirectory::open(&self.run)?;
        if run.path() != self.windows.run.path() {
            return Err(io::Error::other("run path differs from the pinned layout"));
        }
        Ok(())
    }

    /// Writers must hold the supervisor/startup lock. This API does not acquire it.
    pub fn write_state(&self, bytes: &[u8]) -> io::Result<()> {
        self.check_run()?;
        self.windows
            .run
            .replace_file(OsStr::new("state.json"), bytes)
    }

    pub fn read_state(&self) -> io::Result<String> {
        self.check_run()?;
        super::read_bounded(self.windows.run.open_file(OsStr::new("state.json"))?, 65536)
    }
}

#[cfg(test)]
mod tests;
