use super::*;
use std::io::{Read, Write};

#[test]
fn private_tree_round_trip_and_child_keeps_ancestors_pinned() {
    let temp = tempfile::tempdir().unwrap();
    let ancestor = temp.path().join("shared ancestor");
    std::fs::create_dir(&ancestor).unwrap();
    let root_path = ancestor.join("Moss café 東京");
    let root = PrivateDirectory::create(&root_path).unwrap();
    let run = root.create_directory(OsStr::new("run")).unwrap();
    let mut file = run.create_file(OsStr::new("state.json")).unwrap();
    file.write_all(b"state").unwrap();
    drop(file);
    drop(root);
    let mut bytes = String::new();
    run.open_file(OsStr::new("state.json"))
        .unwrap()
        .read_to_string(&mut bytes)
        .unwrap();
    assert_eq!(bytes, "state");
    assert!(std::fs::rename(&ancestor, temp.path().join("moved")).is_err());
    assert!(std::fs::rename(&root_path, ancestor.join("moved")).is_err());
    drop(run);
    let reopened = PrivateDirectory::open(&root_path).unwrap();
    assert!(reopened.open_directory(OsStr::new("run")).is_ok());
    drop(reopened);
    std::fs::rename(&ancestor, temp.path().join("moved")).unwrap();
}

#[test]
fn refuses_existing_or_nonprivate_roots_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    assert!(PrivateDirectory::open(temp.path()).is_err());
    let path = temp.path().join("private");
    let root = PrivateDirectory::create(&path).unwrap();
    assert!(PrivateDirectory::create(&path).is_err());
    assert!(root.open_directory(OsStr::new("missing")).is_err());
    assert!(!path.join("missing").exists());
}

#[test]
fn refuses_aliases_and_child_path_escapes() {
    for path in [
        "relative",
        "C:relative",
        "\\\\host\\share\\dir",
        "\\\\?\\C:\\dir",
        "C:\\",
        "C:\\a\\..\\b",
        "C:\\a\\.\\b",
        "C:\\a.\\b",
        "C:\\a\\\\b",
        "C:/dir",
        "C:\\a/b",
        "C:\\NUL.txt",
        "C:\\a:stream",
    ] {
        assert!(local_path(Path::new(path)).is_err(), "accepted {path}");
    }
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::create(&temp.path().join("private")).unwrap();
    for name in [
        "",
        ".",
        "..",
        "../other",
        "a\\b",
        "C:\\escape",
        "state:stream",
        "trailing.",
        "trailing ",
        "NUL",
        "COM1.txt",
        "LPT¹",
        "bad\0name",
    ] {
        assert!(
            root.create_file(OsStr::new(name)).is_err(),
            "accepted {name}"
        );
        assert!(
            root.create_directory(OsStr::new(name)).is_err(),
            "accepted {name}"
        );
    }
    assert!(root.create_file(OsStr::new("café 東京.json")).is_ok());
}

#[test]
fn refuses_junction_at_each_depth_without_touching_target() {
    let temp = tempfile::tempdir().unwrap();
    let real = temp.path().join("real");
    let root = PrivateDirectory::create(&real).unwrap();
    let child = root.create_directory(OsStr::new("child")).unwrap();
    let link = temp.path().join("junction");
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&real)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(PrivateDirectory::open(&link).is_err());
    assert!(PrivateDirectory::open(&link.join("child")).is_err());
    assert!(PrivateDirectory::create(&link.join("new")).is_err());
    assert!(!real.join("new").exists());
    drop(child);
    drop(root);
    std::fs::remove_dir(&link).unwrap();
}

#[test]
fn state_replacement_preserves_old_state_on_failure_and_rejects_nonprivate_target() {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::create(&temp.path().join("private")).unwrap();
    let name = OsStr::new("state.json");
    root.replace_file(name, b"old").unwrap();
    let mut reader = root.open_file(name).unwrap();
    assert!(root.replace_file(name, b"new").is_err());
    let mut old = String::new();
    reader.read_to_string(&mut old).unwrap();
    assert_eq!(old, "old");
    drop(reader);
    root.replace_file(name, b"new").unwrap();
    assert_eq!(std::fs::read(root.path().join(name)).unwrap(), b"new");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    std::fs::write(root.path().join("ordinary"), b"keep").unwrap();
    assert!(root.replace_file(OsStr::new("ordinary"), b"bad").is_err());
    assert_eq!(
        std::fs::read(root.path().join("ordinary")).unwrap(),
        b"keep"
    );
}

#[test]
fn stale_temporary_is_never_adopted_as_state() {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::create(&temp.path().join("private")).unwrap();
    root.create_file(OsStr::new(".moss-state-stale.tmp"))
        .unwrap()
        .write_all(b"unfinished")
        .unwrap();
    assert!(root.open_file(OsStr::new("state.json")).is_err());
    root.replace_file(OsStr::new("state.json"), b"committed")
        .unwrap();
    assert_eq!(
        std::fs::read(root.path().join("state.json")).unwrap(),
        b"committed"
    );
    assert_eq!(
        std::fs::read(root.path().join(".moss-state-stale.tmp")).unwrap(),
        b"unfinished"
    );
}

#[test]
fn ancestor_with_existing_write_handle_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let ancestor = temp.path().join("ancestor");
    std::fs::create_dir(&ancestor).unwrap();
    let _writer = OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&ancestor)
        .unwrap();
    assert!(PrivateDirectory::create(&ancestor.join("private")).is_err());
    assert!(!ancestor.join("private").exists());
}
