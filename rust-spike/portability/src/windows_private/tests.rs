use super::*;
use std::io::{Read, Seek, SeekFrom, Write};

#[test]
fn private_directory_and_file_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("Moss private café 東京");
    let directory = create_directory(&dir).unwrap();
    let path = dir.join("state.json");
    let mut file = create_file(&path).unwrap();
    file.write_all(b"private state").unwrap();
    file.sync_all().unwrap();
    drop(file);
    let mut reopened = open_file(&path).unwrap();
    let mut contents = String::new();
    reopened.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "private state");
    validate(&directory, true).unwrap();
    // The object cannot be renamed out from under an active consumer.
    assert!(std::fs::rename(&dir, temp.path().join("moved")).is_err());
    drop(reopened);
    drop(directory);
    std::fs::rename(&dir, temp.path().join("moved")).unwrap();
}

#[test]
fn existing_objects_are_refused_without_repair_or_truncation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("ordinary");
    std::fs::write(&path, b"keep").unwrap();
    assert!(create_file(&path).is_err());
    assert!(open_file(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"keep");
    assert!(create_directory(temp.path()).is_err());
    assert!(open_directory(temp.path()).is_err());
    // A private file also cannot be overwritten by another create.
    let path = temp.path().join("private");
    let mut file = create_file(&path).unwrap();
    file.write_all(b"keep private").unwrap();
    assert!(create_file(&path).is_err());
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"keep private");
}

#[test]
fn rejects_broader_missing_duplicate_and_inherited_acl_entries() {
    let temp = tempfile::tempdir().unwrap();
    let sid = user_sid().unwrap();
    for (index, dacl) in [
        format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)(A;;FR;;;WD)"),
        format!("D:P(A;;FA;;;{sid})"),
        format!("D:P(A;;FA;;;{sid})(A;;FA;;;{sid})"),
        format!("D:(A;;FA;;;{sid})(A;;FA;;;SY)"),
        format!("D:P(A;;FA;;;{sid})(A;;FR;;;SY)"),
        format!("D:P(A;;FA;;;{sid})(A;OI;FA;;;SY)"),
        "D:NO_ACCESS_CONTROL".to_owned(),
    ]
    .iter()
    .enumerate()
    {
        let path = temp.path().join(format!("bad-{index}"));
        let descriptor = Security::from_sddl(&format!("O:{sid}{dacl}")).unwrap();
        let path_wide = wide(&path).unwrap();
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &descriptor.attributes(),
                CREATE_NEW,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        assert_ne!(handle as isize, -1, "{}", io::Error::last_os_error());
        let file = unsafe { File::from_raw_handle(handle) };
        assert!(validate(&file, false).is_err(), "accepted {dacl}");
    }
}

#[test]
fn rejects_hard_links_and_wrong_object_types() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("private");
    let directory = create_directory(&dir).unwrap();
    let path = dir.join("file");
    let file = create_file(&path).unwrap();
    assert!(validate(&directory, false).is_err());
    assert!(validate(&file, true).is_err());
    assert!(open_directory(&path).is_err());
    assert!(open_file(&dir).is_err());
    std::fs::hard_link(&path, dir.join("alias")).unwrap();
    assert!(open_file(&path).is_err());
    assert!(open_file(&dir.join("alias")).is_err());
}

#[test]
fn rejects_final_component_junction_without_touching_target() {
    let temp = tempfile::tempdir().unwrap();
    let real = temp.path().join("real");
    let directory = create_directory(&real).unwrap();
    let link = temp.path().join("junction");
    let result = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&real)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(open_directory(&link).is_err());
    assert!(create_directory(&link).is_err());
    validate(&directory, true).unwrap();
    // Remove only the junction; the target is still held and must survive.
    std::fs::remove_dir(&link).unwrap();
    assert!(real.is_dir());
}

#[test]
fn rejects_relative_and_nul_paths() {
    for path in [Path::new("relative"), Path::new("C:\\bad\0name")] {
        assert_eq!(
            create_file(path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            create_directory(path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            open_file(path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}

// These two tests are driven by windows-private.ps1 as different standard local users. They
// exercise real filesystem denial, independently of this module's ACL validation.
#[test]
#[ignore = "requires the disposable Windows CI two-account harness"]
fn owner_creates_cross_account_fixture() {
    let base = std::env::var_os("MOSS_PRIVATE_PROOF").expect("two-account proof folder");
    let dir = Path::new(&base).join("private");
    drop(create_directory(&dir).unwrap());
    let mut file = create_file(&dir.join("secret")).unwrap();
    file.write_all(b"fixture, not a credential").unwrap();
    // Also protect a file directly in the shared parent: directory traversal denial must not
    // hide a missing file DACL.
    drop(create_file(&Path::new(&base).join("private-file")).unwrap());
}

#[test]
#[ignore = "requires the disposable Windows CI two-account harness"]
fn other_account_is_denied_by_windows() {
    let base = std::env::var_os("MOSS_PRIVATE_PROOF").expect("two-account proof folder");
    for path in [
        Path::new(&base).join("private/secret"),
        Path::new(&base).join("private-file"),
    ] {
        assert_eq!(
            std::fs::read(&path).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    assert_eq!(
        std::fs::read_dir(Path::new(&base).join("private"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
}

#[test]
#[ignore = "requires the disposable Windows CI two-account harness"]
fn owner_removes_cross_account_fixture() {
    let base = std::env::var_os("MOSS_PRIVATE_PROOF").expect("two-account proof folder");
    let dir = Path::new(&base).join("private");
    if dir.exists() {
        std::fs::remove_dir_all(dir).unwrap();
    }
    let file = Path::new(&base).join("private-file");
    if file.exists() {
        std::fs::remove_file(file).unwrap();
    }
}
