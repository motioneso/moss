//! Bounded linked-file operations. Participating processes hold one folder lock until call end.
#[cfg(not(unix))]
use crate::set_create_mode;
use crate::{no_follow, Entry, EntryKind, VaultContext, VaultError};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

pub struct FolderLock {
    _file: File,
    root: PathBuf,
}

impl VaultContext {
    /// Trusted host identity for the exact folder this guarded context opened.
    pub fn folder_identity(&self) -> &Path {
        &self.root.path
    }
    /// Unix locks the directory handle, so reads do not require a writable folder or create
    /// a syncable sidecar. Other platforms retain the private, non-Markdown lock file.
    /// External editors do not participate in this lock.
    /// try_lock refuses contention rather than waiting beyond the guest's call deadline.
    pub fn try_lock_folder(&self) -> Result<FolderLock, VaultError> {
        #[cfg(unix)]
        let file = {
            use std::os::unix::fs::OpenOptionsExt;
            self.root.check_vaults(&self.root.path, "")?;
            let mut options = OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
            options.open(&self.root.path)?
        };
        #[cfg(not(unix))]
        let file = self.open_folder_lock_file()?;
        file.try_lock()
            .map_err(|error| VaultError::Io(io::Error::other(error.to_string())))?;
        Ok(FolderLock {
            _file: file,
            root: self.root.path.clone(),
        })
    }

    #[cfg(not(unix))]
    fn open_folder_lock_file(&self) -> Result<File, VaultError> {
        let path = self.root.resolve(".moss-notes.lock", false)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        set_create_mode(&mut options, 0o600);
        let file = no_follow(&mut options).open(path)?;
        if !file.metadata()?.is_file() {
            return Err(VaultError::BadPath("expected a regular folder lock".into()));
        }
        Ok(file)
    }

    pub fn read_limited(&self, relative: &str, limit: usize) -> Result<Vec<u8>, VaultError> {
        let path = self.root.resolve(relative, true)?;
        let mut options = OpenOptions::new();
        options.read(true);
        no_follow(&mut options);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(VaultError::BadPath("expected a regular note file".into()));
        }
        let mut bytes = Vec::new();
        file.take(limit.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(VaultError::BadPath("note file is too large".into()));
        }
        Ok(bytes)
    }

    pub fn list_limited(&self, relative: &str, limit: usize) -> Result<Vec<Entry>, VaultError> {
        let directory = if relative.is_empty() {
            self.root.clone()
        } else {
            self.root.subdir(relative)?
        };
        self.root.check_vaults(&directory.path, relative)?;
        let mut entries = Vec::new();
        for item in fs::read_dir(&directory.path)?.take(limit.saturating_add(1)) {
            let item = item?;
            let kind = item.file_type()?;
            entries.push(Entry {
                name: item
                    .file_name()
                    .into_string()
                    .map_err(|_| VaultError::BadPath("invalid UTF-8 file name".into()))?,
                kind: if kind.is_symlink() {
                    EntryKind::Link
                } else if kind.is_file() {
                    EntryKind::File
                } else if kind.is_dir() {
                    EntryKind::Dir
                } else {
                    EntryKind::Other
                },
            });
        }
        if entries.len() > limit {
            return Err(VaultError::BadPath(
                "notes folder has too many entries".into(),
            ));
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    pub fn current_text(&self, path: &str, limit: usize) -> Result<Option<String>, VaultError> {
        match self.read_limited(path, limit) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| VaultError::BadPath("note is not UTF-8".into())),
            Err(VaultError::NotFound(_)) => Ok(None),
            Err(VaultError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Serializes cooperating writers and compares completed edits before publishing.
    /// The known component-check/open race and arbitrary editors' final compare/rename race remain.
    pub fn compare_replace(
        &self,
        lock: &FolderLock,
        path: &str,
        expected: Option<&str>,
        replacement: Option<&str>,
        limit: usize,
    ) -> Result<(), VaultError> {
        if lock.root != self.root.path {
            return Err(VaultError::Escape("wrong folder lock".into()));
        }
        crate::split_relative(path)?;
        if replacement.is_some_and(|text| text.len() > limit) {
            return Err(VaultError::BadPath("note file is too large".into()));
        }
        if self.current_text(path, limit)?.as_deref() != expected {
            return Err(VaultError::BadPath(
                "note changed; read its current text and retry".into(),
            ));
        }
        if let Some(text) = replacement {
            let mut parent = String::new();
            let parts: Vec<_> = path.split('/').collect();
            for part in &parts[..parts.len() - 1] {
                if !parent.is_empty() {
                    parent.push('/');
                }
                parent.push_str(part);
                self.create_dir(&parent)?;
            }
            self.write(path, text.as_bytes())
        } else if expected.is_some() {
            self.remove(path)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AccessContext, Vaults};
    fn fixture() -> (tempfile::TempDir, VaultContext) {
        let dir = tempfile::tempdir().unwrap();
        let vaults = Vaults::create(&dir.path().join("accounts")).unwrap();
        let access = AccessContext::new(
            "00000000-0000-4000-8000-000000000001".parse().unwrap(),
            "test",
        );
        let context = VaultContext::for_access(&vaults, &access).unwrap();
        (dir, context)
    }
    #[test]
    fn bounded_reads_and_file_kinds() {
        let (_dir, context) = fixture();
        context.write("large.md", b"12345").unwrap();
        assert!(context.read_limited("large.md", 4).is_err());
        assert_eq!(context.read_limited("large.md", 5).unwrap(), b"12345");
        assert!(context.read_limited("", 5).is_err());
        assert!(context.list_limited("", 0).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_named_pipe_is_refused_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let (_dir, context) = fixture();
        let path = std::ffi::CString::new(
            context
                .folder_identity()
                .join("pipe.md")
                .as_os_str()
                .as_bytes(),
        )
        .unwrap();
        // The fixture path is NUL-terminated and belongs to this test's temp folder.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(context.read_limited("pipe.md", 100).is_err());
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("a note read blocked on a pipe"));
    }
    #[test]
    fn compare_write_delete_and_conflicting_editor() {
        let (_dir, context) = fixture();
        let lock = context.try_lock_folder().unwrap();
        assert!(context.try_lock_folder().is_err());
        context
            .compare_replace(&lock, "Nested/note.md", None, Some("first"), 100)
            .unwrap();
        assert!(context
            .compare_replace(&lock, "Nested/note.md", None, Some("lost"), 100)
            .is_err());
        context.write("Nested/note.md", b"external edit").unwrap();
        assert!(context
            .compare_replace(&lock, "Nested/note.md", Some("first"), Some("lost"), 100)
            .is_err());
        assert_eq!(
            context
                .current_text("Nested/note.md", 100)
                .unwrap()
                .as_deref(),
            Some("external edit")
        );
        context
            .compare_replace(&lock, "Nested/note.md", Some("external edit"), None, 100)
            .unwrap();
        assert_eq!(context.current_text("Nested/note.md", 100).unwrap(), None);
        assert!(context
            .compare_replace(&lock, "../escaped.md", None, Some("no"), 100)
            .is_err());
        drop(lock);
        assert!(context.try_lock_folder().is_ok());
    }

    #[test]
    fn folder_lock_is_shared_with_another_process() {
        let (_dir, context) = fixture();
        let _lock = context.try_lock_folder().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "linked_files::tests::child_lock_probe",
            ])
            .env("JS47_LOCK_PROBE_FOLDER", &context.root.path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    #[test]
    #[ignore = "subprocess helper for folder_lock_is_shared_with_another_process"]
    fn child_lock_probe() {
        let root = crate::Root::open(&PathBuf::from(
            std::env::var_os("JS47_LOCK_PROBE_FOLDER").unwrap(),
        ))
        .unwrap();
        let context = VaultContext { root };
        assert!(
            context.try_lock_folder().is_err(),
            "another process acquired the held folder lock"
        );
    }
}
