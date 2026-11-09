//! Windows private-object primitives for the canonical database supervisor's future layout port.
//!
//! New objects receive a protected DACL at creation, granting full control only to the process
//! user and SYSTEM. Existing objects are validated, never silently repaired. Returned handles
//! do not share deletion, so the opened object cannot be renamed/deleted while held.
//!
//! This is an object boundary, NOT a safe path resolver: callers must independently establish a
//! trusted parent and ancestors before use, and retain the returned directory handles while
//! accessing children. Intermediate path components may otherwise follow junctions. There is no
//! recursive creation, secret persistence, or supervisor integration here yet.

mod ffi;
use ffi::*;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null_mut, NonNull};

/// Create exactly one new directory. Its parent must already exist and be trusted by the caller.
/// An existing directory, including a junction, is refused without changing its permissions.
pub fn create_directory(path: &Path) -> io::Result<File> {
    crate::windows_child::require_standard_user()?;
    let path_wide = wide(path)?;
    let security = Security::current(true)?;
    // SAFETY: the UTF-16 path and security descriptor remain live through the call.
    check(unsafe { CreateDirectoryW(path_wide.as_ptr(), &security.attributes()) })?;
    open_directory(path)
}

/// Create an empty read/write file, with no interval in which it inherits the parent's ACL.
/// Existing objects are never opened or overwritten by this operation.
pub fn create_file(path: &Path) -> io::Result<File> {
    crate::windows_child::require_standard_user()?;
    let path = wide(path)?;
    let security = Security::current(false)?;
    // SAFETY: pointers remain live, CREATE_NEW refuses existing files, and inheritance is off.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &security.attributes(),
            CREATE_NEW,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateFileW transfers ownership of a new handle.
    let file = unsafe { File::from_raw_handle(raw) };
    validate(&file, false)?;
    Ok(file)
}

/// Open a directory without following its final component if it is a reparse point.
/// No contents are read until its owner, DACL, and object type have been validated.
pub fn open_directory(path: &Path) -> io::Result<File> {
    open(path, true)
}

/// Open an existing read/write file only if it has this module's exact private-file policy.
pub fn open_file(path: &Path) -> io::Result<File> {
    open(path, false)
}

fn open(path: &Path, directory: bool) -> io::Result<File> {
    crate::windows_child::require_standard_user()?;
    wide(path)?;
    let mut options = OpenOptions::new();
    options.access_mode(if directory {
        READ_CONTROL | FILE_READ_ATTRIBUTES
    } else {
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL
    });
    let file = options
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    validate(&file, directory)?;
    Ok(file)
}

/// Validate the opened object, rather than checking a path and then reopening a different object.
/// The exact two-ACE policy deliberately rejects broader or inherited ACLs, even if they happen
/// to be equivalent. It also rejects file hard links and all final-component reparse points.
fn validate(file: &File, directory: bool) -> io::Result<()> {
    let expected = Security::current(directory)?;
    let mut info: FileInformation = unsafe { std::mem::zeroed() };
    // SAFETY: file owns the handle; info is a correctly sized output buffer.
    check(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
    if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.links != 1)
    {
        return Err(refused(
            "expected a real private object of the requested type, without file hard links",
        ));
    }
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are initialized, file remains open. GetSecurityInfo allocates
    // descriptor with LocalAlloc; owner and dacl point inside it and are not separately freed.
    let code = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    let descriptor = LocalMemory::new(descriptor)?;
    let mut control = 0;
    let mut revision = 0;
    check(unsafe { GetSecurityDescriptorControl(descriptor.ptr(), &mut control, &mut revision) })?;
    if control & SE_DACL_PROTECTED == 0 || dacl.is_null() || owner.is_null() {
        return Err(refused("expected a protected, non-null private DACL"));
    }
    let (expected_owner, expected_acl) = expected.owner_and_acl()?;
    if unsafe { EqualSid(owner, expected_owner) } == 0 {
        return Err(refused("object belongs to another user"));
    }
    compare_acl(dacl, expected_acl)
}

fn compare_acl(actual: *const c_void, expected: *const c_void) -> io::Result<()> {
    fn count(acl: *const c_void) -> io::Result<u32> {
        let mut info = AclSizeInformation {
            ace_count: 0,
            bytes_in_use: 0,
            bytes_free: 0,
        };
        // SAFETY: acl comes from a Win32 security descriptor, info is correctly sized.
        check(unsafe {
            GetAclInformation(acl, &mut info, std::mem::size_of_val(&info) as u32, 2)
        })?;
        Ok(info.ace_count)
    }
    if count(actual)? != 2 || count(expected)? != 2 {
        return Err(refused("expected only the user and SYSTEM access entries"));
    }
    // Compare as a set: Windows may reorder access entries. Duplicates cannot satisfy both.
    let mut matched = 0;
    for index in 0..2 {
        let (flags, mask, sid) = ace(actual, index)?;
        let mut found = false;
        for other in 0..2 {
            let (wanted_flags, _, wanted_sid) = ace(expected, other)?;
            if flags == wanted_flags
                && mask == FILE_ALL_ACCESS
                && unsafe { EqualSid(sid, wanted_sid) } != 0
                && matched & (1 << other) == 0
            {
                matched |= 1 << other;
                found = true;
                break;
            }
        }
        if !found {
            return Err(refused(
                "access entry differs from the private user/SYSTEM policy",
            ));
        }
    }
    Ok(())
}

fn ace(acl: *const c_void, index: u32) -> io::Result<(u8, u32, *const c_void)> {
    let mut pointer = null_mut();
    // SAFETY: GetAce bounds-checks index against this OS-provided ACL.
    check(unsafe { GetAce(acl, index, &mut pointer) })?;
    let header = unsafe { &*pointer.cast::<AceHeader>() };
    // ACCESS_ALLOWED_ACE: header, DWORD mask, then variable-length SID. Refuse other layouts.
    if header.kind != 0 || header.size < 16 {
        return Err(refused("expected a simple allow entry"));
    }
    let mask = unsafe { *pointer.cast::<u8>().add(4).cast::<u32>() };
    let sid = unsafe { pointer.cast::<u8>().add(8).cast::<c_void>() };
    if unsafe { IsValidSid(sid) } == 0 || unsafe { GetLengthSid(sid) } + 8 > u32::from(header.size)
    {
        return Err(refused("invalid access-entry SID"));
    }
    Ok((header.flags, mask, sid))
}

struct Security(LocalMemory);

impl Security {
    fn current(directory: bool) -> io::Result<Self> {
        let sid = user_sid()?;
        let inherit = if directory { "OICI" } else { "" };
        Self::from_sddl(&format!(
            "O:{sid}D:P(A;{inherit};FA;;;SY)(A;{inherit};FA;;;{sid})"
        ))
    }

    fn from_sddl(text: &str) -> io::Result<Self> {
        let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        // SAFETY: input is terminated, output is initialized, SDDL_REVISION_1 is supported.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        })?;
        Ok(Self(LocalMemory::new(descriptor)?))
    }

    fn attributes(&self) -> SecurityAttributes {
        SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: self.0.ptr(),
            inherit: 0,
        }
    }

    fn owner_and_acl(&self) -> io::Result<(*mut c_void, *mut c_void)> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut defaulted = 0;
        let mut present = 0;
        check(unsafe { GetSecurityDescriptorOwner(self.0.ptr(), &mut owner, &mut defaulted) })?;
        check(unsafe {
            GetSecurityDescriptorDacl(self.0.ptr(), &mut present, &mut acl, &mut defaulted)
        })?;
        if present == 0 || owner.is_null() || acl.is_null() {
            return Err(refused("private descriptor has no owner or DACL"));
        }
        Ok((owner, acl))
    }
}

fn user_sid() -> io::Result<String> {
    let mut token = null_mut();
    check(unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) })?;
    // SAFETY: successful OpenProcessToken returns an owned, non-null kernel handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut needed = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), 1, null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // TOKEN_USER starts with SID_AND_ATTRIBUTES. usize storage gives it pointer alignment.
    let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            1,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    let sid = buffer[0] as *const c_void;
    let mut text = null_mut();
    check(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let text = LocalMemory::new(text.cast())?;
    let pointer = text.ptr().cast::<u16>();
    let mut length = 0;
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(pointer, length)
    }))
}

struct LocalMemory(NonNull<c_void>);
impl LocalMemory {
    fn new(pointer: *mut c_void) -> io::Result<Self> {
        NonNull::new(pointer)
            .map(Self)
            .ok_or_else(|| io::Error::other("Win32 returned no security memory"))
    }
    fn ptr(&self) -> *mut c_void {
        self.0.as_ptr()
    }
}
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.ptr());
        }
    }
}

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private-object path must be absolute",
        ));
    }
    let mut text: Vec<u16> = path.as_os_str().encode_wide().collect();
    if text.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    text.push(0);
    Ok(text)
}
fn check(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn refused(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(test)]
mod tests;
