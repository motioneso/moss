//! The canonical per-install supervisor lock, shared by the Unix supervisor and Windows
//! layout qualification. This does not authenticate a PID or implement Windows Stop.

use crate::layout::Layout;
use std::fs::File;
use std::io::{Read, Write};

/// Keeps the lock handle and its layout alive until the supervisor exits. In particular,
/// Windows ancestor pins must not disappear when the caller drops its Layout.
pub struct InstallLock {
    _file: File,
    _layout: Layout,
}

/// Acquire without waiting. Publish the PID only after acquiring the OS lock, and never
/// truncate another supervisor's PID on contention. A PID is diagnostic, not process identity.
pub fn lock(layout: &Layout) -> Result<InstallLock, String> {
    let mut file = layout
        .open_supervisor_lock()
        .map_err(|e| format!("lock file: {e}"))?;
    if !portability::file_lock::try_exclusive(&file).map_err(|e| format!("lock file: {e}"))? {
        let mut holder = String::new();
        let _ = (&mut file).take(32).read_to_string(&mut holder);
        // A lock file is not an authenticated message. Only include a numeric PID in errors.
        let pid = holder.trim().parse::<u32>().ok();
        return Err(format!(
            "another supervisor (pid {}) is already running this install",
            pid.map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown".into())
        ));
    }
    file.set_len(0)
        .and_then(|_| file.write_all(std::process::id().to_string().as_bytes()))
        .map_err(|e| format!("lock file: {e}"))?;
    Ok(InstallLock {
        _file: file,
        _layout: layout.clone(),
    })
}

impl InstallLock {
    /// Windows state replacement requires the same supervisor lock for the whole write.
    /// The guard always writes to its own pinned layout, never a separately supplied path.
    #[cfg(windows)]
    pub fn write_state(&self, bytes: &[u8]) -> std::io::Result<()> {
        self._layout.write_state(bytes)
    }
}

#[cfg(test)]
mod tests;
