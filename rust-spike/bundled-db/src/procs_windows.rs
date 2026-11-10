//! Windows process facts for the supervisor. The kill-on-close job in `portability` already
//! ends the whole database tree when the supervisor dies, so no leftover scan is needed.

use std::ffi::c_void;
use std::path::Path;

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const STILL_ACTIVE: u32 = 259;

/// Whether `pid` names a running process this account may query.
pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: plain Win32 calls; the handle is closed before return.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE;
        CloseHandle(handle);
        ok
    }
}

/// Windows has no crash-dump switch as cheap as the Unix core limit. Postgres memory is not
/// read by this process, and the supervisor holds passwords only briefly.
pub fn protect_from_crash_dumps() -> std::io::Result<()> {
    Ok(())
}

/// The install lock is held for the supervisor's whole life, so a live lock holder whose pid is
/// running is the supervisor.
pub fn is_supervisor(pid: i32) -> bool {
    alive(pid)
}

/// Whether a `postgres` process with these arguments belongs to the install.
pub fn belongs(args: &[&str], data: &Path, cluster: &str) -> bool {
    let data = data.to_string_lossy();
    let title = format!("postgres: {cluster}: ");
    args.windows(2).any(|pair| pair[0] == "-D" && pair[1] == data)
        || args.first().is_some_and(|first| first.starts_with(&title))
}

/// Nothing outlives the job object, so there is nothing to find.
pub fn database_processes(_data: &Path, _cluster: &str) -> Vec<i32> {
    Vec::new()
}
