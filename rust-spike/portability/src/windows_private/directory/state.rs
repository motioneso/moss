use super::*;
use std::io::Write;

impl PrivateDirectory {
    /// Replace a private state file by a same-directory, flushed temporary file. Readers
    /// holding an old no-delete-sharing handle cause replacement to fail, preserving it.
    /// Callers must serialize writers with the supervisor/startup lock. This is not a
    /// database transaction or a promise that a power loss cannot lose the rename.
    /// A crash may leave a private `.moss-state-*.tmp`; failed post-creation validation can
    /// leave an empty temporary. Opening state never consumes those files. Recovery must only
    /// use the named state file.
    pub fn replace_file(&self, name: &OsStr, bytes: &[u8]) -> io::Result<()> {
        let target = self.child_path(name)?;
        match open_file(&target) {
            Ok(file) => drop(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        // The private parent excludes other users. Same-user processes are trusted; callers
        // still need their lifecycle lock to avoid conflicting state updates.
        let temporary = self
            .path
            .join(format!(".moss-state-{:032x}.tmp", rand::random::<u128>()));
        let mut file = create_file(&temporary)?;
        let result = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        let result = result.and_then(|()| {
            let source = wide(&temporary)?;
            let destination = wide(&target)?;
            // SAFETY: both paths are NUL-terminated and in the pinned private parent.
            // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH; never copy across volumes.
            check(unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 1 | 8) })
        });
        if result.is_err() {
            // Only remove this operation's exclusive-create temporary, never the old state.
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}
