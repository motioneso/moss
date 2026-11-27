//! Same-directory atomic replacement without reopening a pinned parent for writing.
use std::{
    fs::OpenOptions,
    io,
    mem::{align_of, offset_of, size_of},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
    },
    Win32::{
        Foundation::RtlNtStatusToDosError,
        Storage::FileSystem::{DELETE, FILE_FLAG_OPEN_REPARSE_POINT},
        System::IO::IO_STATUS_BLOCK,
    },
};

pub(crate) fn rename_sibling(source: &Path, target: &Path) -> io::Result<()> {
    let leaf = target
        .file_name()
        .filter(|_| source.parent() == target.parent())
        .ok_or_else(|| io::Error::other("private replacement requires sibling files"))?;
    let name: Vec<u16> = leaf.encode_wide().collect();
    if name.is_empty() || name.iter().any(|unit| matches!(*unit, 0 | 47 | 58 | 92)) {
        return Err(io::Error::other("private replacement requires a file name"));
    }
    let file = OpenOptions::new()
        .access_mode(DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(source)?;
    let length = offset_of!(FILE_RENAME_INFORMATION, FileName) + name.len() * 2;
    let length = u32::try_from(length)
        .map_err(|_| io::Error::other("private replacement name is too long"))?;
    // Word storage supplies the native structure's pointer alignment and has
    // no invalid bit patterns when the trailing filename overwrites its words.
    const { assert!(align_of::<usize>() >= align_of::<FILE_RENAME_INFORMATION>()) };
    let allocation = (length as usize).max(size_of::<FILE_RENAME_INFORMATION>());
    let mut storage = vec![0usize; allocation.div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: the aligned allocation covers the header and UTF-16 name; all
    // pointers and the synchronous source handle remain live through the call.
    let result = unsafe {
        (*info).Anonymous.ReplaceIfExists = true;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        // A bare leaf with NULL RootDirectory renames within the source's
        // directory. Unlike MoveFileExW's full destination path, it does not
        // reopen the parent for add-file access that conflicts with its pin.
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            info.cast(),
            length,
            FileRenameInformation,
        )
    };
    if result < 0 {
        // SAFETY: this pure conversion accepts any returned NTSTATUS.
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ))
    } else {
        Ok(())
    }
}
