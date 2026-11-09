//! Win32 ABI declarations used only by windows_child. No new Windows binding dependency.
use std::ffi::c_void;

pub const INFINITE: u32 = u32::MAX;
pub const WAIT_OBJECT_0: u32 = 0;
pub const WAIT_TIMEOUT: u32 = 258;
pub const TOKEN_QUERY: u32 = 8;
pub const TOKEN_ELEVATION: u32 = 20;
pub const CREATE_SUSPENDED: u32 = 4;
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
pub const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x80000;
pub const STARTF_USESTDHANDLES: u32 = 0x100;
pub const DUPLICATE_SAME_ACCESS: u32 = 2;
pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
pub const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x20002;

#[repr(C)]
pub struct StartupInfo {
    pub cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    pub flags: u32,
    show_window: u16,
    reserved2_len: u16,
    reserved2: *mut u8,
    pub stdin: *mut c_void,
    pub stdout: *mut c_void,
    pub stderr: *mut c_void,
}

#[repr(C)]
pub struct StartupInfoEx {
    pub info: StartupInfo,
    pub attributes: *mut c_void,
}

#[repr(C)]
pub struct ProcessInformation {
    pub process: *mut c_void,
    pub thread: *mut c_void,
    pub pid: u32,
    thread_id: u32,
}

#[repr(C)]
pub struct BasicLimitInformation {
    per_process_time: i64,
    per_job_time: i64,
    pub flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
pub struct ExtendedLimitInformation {
    pub basic: BasicLimitInformation,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

#[link(name = "kernel32")]
extern "system" {
    pub fn GetCurrentProcess() -> *mut c_void;
    pub fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    pub fn SetInformationJobObject(
        job: *mut c_void,
        class: u32,
        info: *const c_void,
        size: u32,
    ) -> i32;
    pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    pub fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    pub fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
    pub fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
    pub fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
    pub fn ResumeThread(thread: *mut c_void) -> u32;
    pub fn DuplicateHandle(
        source_process: *mut c_void,
        source: *mut c_void,
        target_process: *mut c_void,
        target: *mut *mut c_void,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    pub fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    pub fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        returned_size: *mut usize,
    ) -> i32;
    pub fn DeleteProcThreadAttributeList(list: *mut c_void);
    pub fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_security: *const c_void,
        thread_security: *const c_void,
        inherit_handles: i32,
        flags: u32,
        environment: *mut c_void,
        directory: *const u16,
        startup: *mut StartupInfoEx,
        information: *mut ProcessInformation,
    ) -> i32;
    pub fn CompareStringOrdinal(
        a: *const u16,
        a_len: i32,
        b: *const u16,
        b_len: i32,
        ignore_case: i32,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    pub fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    pub fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        info: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
}
