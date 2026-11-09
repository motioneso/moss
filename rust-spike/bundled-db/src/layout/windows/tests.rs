use super::*;
use crate::secrets;
use std::io::Write;

#[test]
fn canonical_layout_round_trip_and_independent_instances() {
    let temp = tempfile::tempdir().unwrap();
    let first_path = temp.path().join("Moss café 東京");
    let first = Layout::create(&first_path).unwrap();
    let second = Layout::create(&temp.path().join("second")).unwrap();
    assert_eq!(first.run, first_path.join("run"));
    for path in [&first.data, &first.run, &first.logs, &first.secrets] {
        assert!(PrivateDirectory::open(path).is_ok());
    }
    first.write_state(b"first").unwrap();
    second.write_state(b"second").unwrap();
    assert_eq!(first.read_state().unwrap(), "first");
    assert_eq!(second.read_state().unwrap(), "second");
    assert_ne!(first.cluster_name(), second.cluster_name());
    let opened = Layout::open(&first_path).unwrap();
    assert_eq!(opened.read_state().unwrap(), "first");
    assert_eq!(Layout::create(&first_path).unwrap().data, first.data);
    // Drop every pin before tempfile cleanup (Windows refuses deleting pinned directories).
    drop((opened, first, second));
}

#[test]
fn opening_is_read_only_and_partial_creation_can_resume() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("install");
    assert!(Layout::open(&path).is_err());
    assert!(!path.exists());
    let root = PrivateDirectory::create(&path).unwrap();
    let data = root.create_directory(OsStr::new("db")).unwrap();
    assert!(Layout::open(&path).is_err());
    assert!(!path.join("run").exists());
    drop((data, root));
    drop(Layout::create(&path).unwrap());
    drop(Layout::open(&path).unwrap());
}

#[test]
fn missing_ancestors_and_nonprivate_children_are_not_repaired() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("missing");
    assert!(Layout::create(&missing.join("install")).is_err());
    assert!(!missing.exists());
    let path = temp.path().join("install");
    let root = PrivateDirectory::create(&path).unwrap();
    // Inherited ACLs are deliberately outside the exact private-object policy.
    std::fs::create_dir(path.join("run")).unwrap();
    assert!(Layout::create(&path).is_err());
    assert!(PrivateDirectory::open(&path.join("run")).is_err());
    drop(root);
}

#[test]
fn cloned_layout_keeps_root_and_all_children_pinned() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("install");
    let first = Layout::create(&path).unwrap();
    let cloned = first.clone();
    drop(first);
    for path in [
        &cloned.root,
        &cloned.data,
        &cloned.run,
        &cloned.secrets,
        &cloned.logs,
    ] {
        assert!(std::fs::rename(path, path.with_extension("moved")).is_err());
    }
    drop(cloned);
    std::fs::rename(&path, temp.path().join("moved")).unwrap();
}

#[test]
fn private_state_replacement_preserves_old_state_on_reader_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    layout.write_state(b"old").unwrap();
    let reader = layout
        .windows
        .run
        .open_file(OsStr::new("state.json"))
        .unwrap();
    assert!(layout.write_state(b"new").is_err());
    assert_eq!(layout.read_state().unwrap(), "old");
    drop(reader);
    layout.write_state(b"new").unwrap();
    assert_eq!(layout.read_state().unwrap(), "new");
    layout.write_state(&vec![b'x'; 65537]).unwrap();
    assert!(layout.read_state().is_err());
    drop(layout);
}

#[test]
fn planted_state_and_password_files_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    std::fs::write(layout.state_file(), "untrusted").unwrap();
    assert!(layout.read_state().is_err());
    assert!(layout.write_state(b"replacement").is_err());
    assert_eq!(std::fs::read(layout.state_file()).unwrap(), b"untrusted");
    std::fs::write(layout.secrets.join(crate::SUPERUSER), "untrusted").unwrap();
    assert!(secrets::password(&layout, crate::SUPERUSER).is_err());
    assert!(secrets::existing(&layout, crate::SUPERUSER).is_err());
    drop(layout);
}

#[test]
fn canonical_passwords_reopen_without_replacement_and_reject_escape() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    let password = secrets::password(&layout, crate::SUPERUSER).unwrap();
    assert_eq!(password.expose().len(), 64);
    assert!(
        portability::windows_private::open_file(&layout.secrets.join(crate::SUPERUSER)).is_ok()
    );
    assert!(
        password.expose()
            == secrets::existing(&layout, crate::SUPERUSER)
                .unwrap()
                .expose()
    );
    assert!(
        password.expose()
            == secrets::password(&layout, crate::SUPERUSER)
                .unwrap()
                .expose()
    );
    for name in ["session-signing-secret", "connector-key"] {
        assert_eq!(secrets::password(&layout, name).unwrap().expose().len(), 64);
    }
    for invalid in ["../escape", "C:\\escape", "moss_admin:stream", "unknown"] {
        assert!(secrets::password(&layout, invalid).is_err());
        assert!(secrets::existing(&layout, invalid).is_err());
    }
    let mut file = layout.create_secret(crate::RUNTIME_ROLES[0]).unwrap();
    file.write_all(&[b'x'; 257]).unwrap();
    drop(file);
    assert!(secrets::existing(&layout, crate::RUNTIME_ROLES[0]).is_err());
    drop(layout);
}

#[test]
fn junction_root_and_children_are_refused_without_canonicalizing() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    drop(Layout::create(&target).unwrap());
    let root_link = temp.path().join("linked");
    let junction = |link: &Path, target: &Path| {
        let result = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(result.status.success());
    };
    junction(&root_link, &target);
    assert!(Layout::open(&root_link).is_err());
    assert!(Layout::create(&root_link).is_err());
    std::fs::remove_dir(&root_link).unwrap();
    let path = temp.path().join("install");
    let root = PrivateDirectory::create(&path).unwrap();
    junction(&path.join("db"), &target.join("db"));
    assert!(Layout::create(&path).is_err());
    std::fs::remove_dir(path.join("db")).unwrap();
    drop(root);
}
