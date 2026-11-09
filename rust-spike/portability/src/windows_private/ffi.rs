//! Win32 security ABI for Windows private filesystem objects. No binding dependency.
use std::ffi::c_void;

pub const OWNER_SECURITY_INFORMATION: u32 = 1;
pub const DACL_SECURITY_INFORMATION: u32 = 4;
pub const SE_FILE_OBJECT: u32 = 1;
pub const SE_DACL_PROTECTED: u16 = 0x1000;
pub const FILE_ALL_ACCESS: u32 = 0x001f01ff;
pub const READ_CONTROL: u32 = 0x20000;
pub const FILE_LIST_DIRECTORY: u32 = 1;
pub const FILE_READ_ATTRIBUTES: u32 = 0x80;
pub const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
pub const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
pub const FILE_SHARE_READ: u32 = 1;
pub const FILE_SHARE_WRITE: u32 = 2;
pub const GENERIC_READ: u32 = 0x80000000;
pub const GENERIC_WRITE: u32 = 0x40000000;
pub const CREATE_NEW: u32 = 1;

#[repr(C)]
pub struct SecurityAttributes {
    pub length: u32,
    pub descriptor: *mut c_void,
    pub inherit: i32,
}

#[repr(C)]
pub struct AclSizeInformation {
    pub ace_count: u32,
    pub bytes_in_use: u32,
    pub bytes_free: u32,
}

#[repr(C)]
pub struct AceHeader {
    pub kind: u8,
    pub flags: u8,
    pub size: u16,
}

#[repr(C)]
pub struct FileInformation {
    pub attributes: u32,
    creation_time: [u32; 2],
    access_time: [u32; 2],
    write_time: [u32; 2],
    volume_serial: u32,
    size_high: u32,
    size_low: u32,
    pub links: u32,
    index_high: u32,
    index_low: u32,
}

#[link(name = "kernel32")]
extern "system" {
    pub fn GetDriveTypeW(root: *const u16) -> u32;
    pub fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    pub fn GetCurrentProcess() -> *mut c_void;
    pub fn LocalFree(memory: *mut c_void) -> *mut c_void;
    pub fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
    pub fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        attributes: *const SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: *mut c_void,
    ) -> *mut c_void;
    pub fn GetFileInformationByHandle(file: *mut c_void, info: *mut FileInformation) -> i32;
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
    pub fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
    pub fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
    pub fn GetSecurityInfo(
        handle: *mut c_void,
        kind: u32,
        information: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    pub fn GetSecurityDescriptorControl(
        descriptor: *const c_void,
        control: *mut u16,
        revision: *mut u32,
    ) -> i32;
    pub fn GetSecurityDescriptorOwner(
        descriptor: *const c_void,
        owner: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
    pub fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        dacl: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
    pub fn GetAclInformation(
        acl: *const c_void,
        info: *mut AclSizeInformation,
        size: u32,
        class: u32,
    ) -> i32;
    pub fn GetAce(acl: *const c_void, index: u32, ace: *mut *mut c_void) -> i32;
    pub fn EqualSid(a: *const c_void, b: *const c_void) -> i32;
    pub fn IsValidSid(sid: *const c_void) -> i32;
    pub fn GetLengthSid(sid: *const c_void) -> u32;
    #[cfg(test)]
    pub fn SetSecurityInfo(
        handle: *mut c_void,
        kind: u32,
        information: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
}
