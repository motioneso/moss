//! The write fence that makes one backup a single moment in time.
//!
//! A writer that changes both a file and a database row holds the fence shared from before
//! the file write until the row commits. A backup holds it exclusive for the whole capture,
//! and inside it also holds every app table in SHARE mode, which stops all row writes while
//! still letting `pg_dump` read. So a write either finishes before the capture starts and is in
//! both the dump and the files, or waits until the capture ends and is in neither.

use std::fs::File;
use std::io;
use std::path::Path;

pub const FENCE_FILE: &str = "write-fence.lock";

/// Held for as long as the guard lives.
pub struct Fence {
    _file: File,
}

fn open(instance: &Path) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(instance.join(FENCE_FILE))
}

/// Waits until no writer is inside, then keeps new writers out.
pub fn exclusive(instance: &Path) -> io::Result<Fence> {
    let file = open(instance)?;
    portability::file_lock::exclusive(&file)?;
    Ok(Fence { _file: file })
}

/// Waits while a backup is capturing. Writers hold this across a file write and its row.
pub fn writer(instance: &Path) -> io::Result<Fence> {
    let file = open(instance)?;
    portability::file_lock::shared(&file)?;
    Ok(Fence { _file: file })
}
