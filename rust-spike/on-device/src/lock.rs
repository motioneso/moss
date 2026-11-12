//! One lock per model folder, so two Moss processes on the same data folder never download or
//! repair the same files at once.
use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    time::{Duration, Instant},
};

/// Held for as long as the value lives. The operating system drops it if the process dies.
pub struct CacheLock {
    _file: File,
}

impl CacheLock {
    /// Waits up to `wait` for the lock, then gives up with a plain message.
    pub fn acquire(folder: &Path, wait: Duration) -> Result<Self> {
        std::fs::create_dir_all(folder).context("Cannot create the model folder")?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(folder.join(".lock"))
            .context("Cannot open the model folder lock")?;
        let start = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) if start.elapsed() < wait => {
                    std::thread::sleep(Duration::from_millis(200))
                }
                Err(TryLockError::WouldBlock) => anyhow::bail!(
                    "Another Moss process is using the search model folder. Try again in a minute"
                ),
                Err(TryLockError::Error(e)) => {
                    return Err(e).context("Cannot lock the model folder")
                }
            }
        }
    }
}
