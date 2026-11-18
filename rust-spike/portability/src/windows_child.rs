//! Windows database-process ownership, for the canonical bundled database supervisor.
//!
//! Launches one program without a console window, suspended until its kill-on-close job owns it.
//! The job covers descendants too. Dropping `Child` ends that job, unlike std's `Child`.
//! This is not yet wired into `moss-db`: its ACLs, stop transport and recovery still need a port.
//!
//! The supervisor must serialize all process starts, including starts through std::Command.
//! The temporary inheritable log/NUL duplicates exist until CreateProcess returns. This call's
//! handle list restricts its child, but cannot restrict a concurrent blanket-inheritance launch.

mod ffi;

use ffi::*;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;
use std::ptr::{null, null_mut};
use std::time::Duration;

/// One process tree. The job handle is never inheritable or named.
pub struct Child {
    job: OwnedHandle,
    process: OwnedHandle,
    pid: u32,
}

impl Child {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait_for(INFINITE)?
            .ok_or_else(|| io::Error::other("process wait timed out"))
    }

    pub fn wait_timeout(&mut self, timeout: Duration) -> io::Result<Option<ExitStatus>> {
        self.wait_for(timeout.as_millis().min((INFINITE - 1) as u128) as u32)
    }

    fn wait_for(&self, millis: u32) -> io::Result<Option<ExitStatus>> {
        // SAFETY: the owned process handle remains open throughout both calls.
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), millis) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                check(unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) })?;
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// Last resort only. Orderly Postgres shutdown must use its own `pg_ctl kill` signal pipe.
    pub fn kill(&mut self) -> io::Result<()> {
        // SAFETY: this handle names only the job this module created for this child.
        check(unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) })
    }
}

/// Refuse elevated launch rather than running Postgres with administrative authority.
pub fn require_standard_user() -> io::Result<()> {
    let mut token = null_mut();
    // SAFETY: the pseudo process handle is valid; `token` is an initialized output pointer.
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut elevated: u32 = 0;
    let mut returned = 0;
    // SAFETY: TokenElevation is a DWORD and the supplied output buffer has that exact size.
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TOKEN_ELEVATION,
            (&mut elevated as *mut u32).cast(),
            4,
            &mut returned,
        )
    })?;
    if elevated != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "run Moss as a standard user, not as administrator",
        ));
    }
    Ok(())
}

/// Start a direct executable, not a shell. Standard input is NUL; only duplicate log handles
/// are inherited. All PG* environment variables are removed (case-insensitively on Windows).
/// The program and working directory must be absolute. Arguments use the Windows CRT quoting
/// protocol, which is also the protocol PostgreSQL's Windows executables use.
pub fn spawn(
    program: &Path,
    args: &[OsString],
    directory: &Path,
    stdout: &File,
    stderr: &File,
) -> io::Result<Child> {
    require_standard_user()?;
    if !program.is_absolute() || !directory.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "program and working directory must be absolute",
        ));
    }
    let application = wide(program.as_os_str())?;
    let directory = wide(directory.as_os_str())?;
    let mut command = command_line(program.as_os_str(), args)?;
    let mut environment = environment()?;

    let stdin = File::open("NUL")?;
    let input = inheritable(&stdin)?;
    let output = inheritable(stdout)?;
    let error = inheritable(stderr)?;
    let mut handles = [
        input.as_raw_handle(),
        output.as_raw_handle(),
        error.as_raw_handle(),
    ];
    let attributes = Attributes::new(&mut handles)?;
    // SAFETY: these Win32 POD structs allow zero initialization; cb is filled before use.
    let mut startup: StartupInfoEx = unsafe { std::mem::zeroed() };
    startup.info.cb = std::mem::size_of::<StartupInfoEx>() as u32;
    startup.info.flags = STARTF_USESTDHANDLES;
    startup.info.stdin = input.as_raw_handle();
    startup.info.stdout = output.as_raw_handle();
    startup.info.stderr = error.as_raw_handle();
    startup.attributes = attributes.pointer();
    // Create the job before the process so every failure path has an owner to clean up.
    let job = job()?;
    let mut info: ProcessInformation = unsafe { std::mem::zeroed() };
    // SAFETY: all strings are NUL-terminated, buffers and the attribute list live through the
    // call, the handle list names only the three inheritable duplicates above. The job is not
    // in that list. lpApplicationName selects the exact executable, independently of argv[0].
    check(unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_mut_ptr().cast(),
            directory.as_ptr(),
            &mut startup,
            &mut info,
        )
    })?;
    let process = owned(info.process)?;
    let thread = owned(info.thread)?;
    let child = Child {
        job,
        process,
        pid: info.pid,
    };
    // SAFETY: the child is still suspended and both handles belong to this invocation.
    if let Err(error) = check(unsafe {
        AssignProcessToJobObject(child.job.as_raw_handle(), child.process.as_raw_handle())
    }) {
        // Assignment failed, so closing the job cannot clean up the unassigned process.
        // It has never run. Attempt termination and a bounded reap. If Windows refuses cleanup,
        // preserve both the assignment error and enough identity to diagnose the suspended child.
        let terminated = unsafe { TerminateProcess(child.process.as_raw_handle(), 1) };
        let cleanup_error = (terminated == 0).then(io::Error::last_os_error);
        let wait = if terminated == 0 { 0 } else { 30_000 };
        if unsafe { WaitForSingleObject(child.process.as_raw_handle(), wait) } != WAIT_OBJECT_0 {
            return Err(io::Error::other(format!(
                "assign child {} to job: {error}; suspended-child cleanup failed: {cleanup_error:?}", child.pid
            )));
        }
        return Err(error);
    }
    // SAFETY: CreateProcess returned the primary thread, still suspended exactly once.
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(child)
}

fn job() -> io::Result<OwnedHandle> {
    // SAFETY: null security attributes produce a non-inheritable unnamed job handle.
    let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
    limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // No breakaway flag: descendants must remain in this job.
    check(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&limits as *const ExtendedLimitInformation).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    })?;
    Ok(job)
}

fn inheritable(file: &File) -> io::Result<OwnedHandle> {
    let mut duplicate = null_mut();
    // SAFETY: borrowing both the source handle and current-process pseudo handle is valid;
    // the newly returned handle is uniquely owned and closed after CreateProcess returns.
    check(unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            file.as_raw_handle(),
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    owned(duplicate)
}

fn owned(handle: *mut c_void) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle as isize == -1 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: callers pass only new handles returned by successful Win32 creation calls.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

fn check(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(text: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = text.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    wide.push(0);
    Ok(wide)
}

fn command_line(program: &OsStr, args: &[OsString]) -> io::Result<Vec<u16>> {
    let mut line = Vec::new();
    for arg in std::iter::once(program).chain(args.iter().map(OsString::as_os_str)) {
        if !line.is_empty() {
            line.push(b' ' as u16);
        }
        line.push(b'"' as u16);
        let units = wide(arg)?;
        let mut slashes = 0;
        for &unit in &units[..units.len() - 1] {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            if unit == b'"' as u16 {
                line.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
            } else {
                line.extend(std::iter::repeat_n(b'\\' as u16, slashes));
            }
            slashes = 0;
            line.push(unit);
        }
        line.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        line.push(b'"' as u16);
    }
    line.push(0);
    if line.len() > 32767 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command line too long",
        ));
    }
    Ok(line)
}

fn environment() -> io::Result<Vec<u16>> {
    let mut entries: Vec<Vec<u16>> = std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().to_ascii_uppercase().starts_with("PG"))
        .map(|(key, value)| {
            let mut entry = key;
            entry.push("=");
            entry.push(value);
            wide(&entry)
        })
        .collect::<io::Result<_>>()?;
    // Windows expects the environment sorted without regard to case, in Unicode order.
    entries.sort_by(|a, b| {
        // Sort names only: e.g. ProgramFiles must precede ProgramFiles(x86). Hidden drive
        // entries start with '='; the separator is the next '=' in those entries.
        let name_len = |entry: &[u16]| {
            entry
                .iter()
                .enumerate()
                .skip(1)
                .find_map(|(i, &unit)| (unit == b'=' as u16).then_some(i))
                .unwrap_or(entry.len() - 1)
        };
        // SAFETY: both name lengths lie inside the NUL-terminated UTF-16 entries.
        let order = unsafe {
            CompareStringOrdinal(
                a.as_ptr(),
                name_len(a) as i32,
                b.as_ptr(),
                name_len(b) as i32,
                1,
            )
        };
        order.cmp(&2)
    });
    let mut block: Vec<u16> = entries.into_iter().flatten().collect();
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// Aligned storage whose address remains stable for the life of the attribute list.
struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    fn new(handles: &mut [*mut c_void]) -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: the first call asks for buffer size and intentionally fails.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        check(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut bytes)
        })?;
        let attributes = Self { storage };
        check(unsafe {
            UpdateProcThreadAttribute(
                attributes.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_mut_ptr().cast(),
                std::mem::size_of_val(handles),
                null_mut(),
                null_mut(),
            )
        })?;
        Ok(attributes)
    }
    fn pointer(&self) -> *mut c_void {
        self.storage.as_ptr().cast_mut().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: construction initialized this list; no CreateProcess call still borrows it.
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}

#[cfg(test)]
mod tests;
