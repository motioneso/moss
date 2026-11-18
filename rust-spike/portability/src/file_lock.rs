//! Process-lifetime file locks for setup, server start and the database supervisor.
//!
//! Locking never writes to the file, and readers can still read a supervisor's pid while
//! another handle holds the lock. Windows locks a reserved byte beyond the file contents:
//! locking the contents themselves would prevent `holder` from reading the pid. All callers
//! must use this protocol; dropping the file (including on process death) releases the lock.

use std::{fs::File, io};

/// Waits for an exclusive lock. Keep `file` open for the whole protected operation.
pub fn exclusive(file: &File) -> io::Result<()> {
    acquire(file, false, true).map(|_| ())
}

/// Attempts an exclusive lock without waiting. `false` means another handle holds it.
pub fn try_exclusive(file: &File) -> io::Result<bool> {
    acquire(file, false, false)
}

/// Attempts a shared lock without waiting. `false` means an exclusive holder exists.
pub fn try_shared(file: &File) -> io::Result<bool> {
    acquire(file, true, false)
}

#[cfg(unix)]
fn acquire(file: &File, shared: bool, wait: bool) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    let kind =
        if shared { libc::LOCK_SH } else { libc::LOCK_EX } | if wait { 0 } else { libc::LOCK_NB };
    loop {
        // SAFETY: the borrowed file owns its descriptor throughout the call.
        if unsafe { libc::flock(file.as_raw_fd(), kind) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return if error.kind() == io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(error)
        };
    }
}

#[cfg(windows)]
fn acquire(file: &File, shared: bool, wait: bool) -> io::Result<bool> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 1;
    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 2;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        // A single byte at 2^63-1, well outside these small state/lock files.
        offset: u32::MAX,
        offset_high: 0x7fff_ffff,
        event: std::ptr::null_mut(),
    };
    let flags = if shared { 0 } else { LOCKFILE_EXCLUSIVE_LOCK }
        | if wait { 0 } else { LOCKFILE_FAIL_IMMEDIATELY };
    // SAFETY: OVERLAPPED matches the Win32 ABI, the file handle is borrowed and opened
    // synchronously, and the structure stays alive until this synchronous call returns.
    if unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut overlapped) } != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(test)]
mod tests;
