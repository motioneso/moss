use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};

use keystore::probe::Keychain;
use keystore::recovery::RecoveryKey;
use keystore::store::{
    recover, secure, set_up, status, CredentialKeys, Paths, RecoverError, State,
};

/// The only state in which setup may write the key file.
const NO_KEYCHAIN: Keychain = Keychain::NotInstalled;

struct Setup {
    _dir: tempfile::TempDir,
    paths: Paths,
    recovery: RecoveryKey,
    fingerprint: String,
}

fn new_setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    let recovery = RecoveryKey::generate();
    let keys = CredentialKeys::generate();
    let fingerprint = keys.fingerprint();
    set_up(&paths, &NO_KEYCHAIN, &recovery, &keys).unwrap();
    Setup {
        _dir: dir,
        paths,
        recovery,
        fingerprint,
    }
}

fn mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn unlocked_fingerprint(state: State) -> String {
    match state {
        State::Unlocked(unlocked) => unlocked.keys.fingerprint(),
        _ => panic!("expected unlocked, got {}", name(&state)),
    }
}

fn name(state: &State) -> &'static str {
    match state {
        State::NotSetUp => "NotSetUp",
        State::Unlocked(_) => "Unlocked",
        State::KeyFileMissing { .. } => "KeyFileMissing",
        State::KeyFileDamaged { .. } => "KeyFileDamaged",
        State::KeyFileExposed { .. } => "KeyFileExposed",
        State::KeyFileNotOurs { .. } => "KeyFileNotOurs",
        State::KeyFileForAnotherKey { .. } => "KeyFileForAnotherKey",
        State::BundleMissing => "BundleMissing",
        State::BundleDamaged(_) => "BundleDamaged",
        State::KeysDoNotMatch(_) => "KeysDoNotMatch",
    }
}

#[test]
fn setup_writes_private_files_and_unlocks_at_every_start() {
    let s = new_setup();
    assert_eq!(mode(&s.paths.key_folder), 0o700);
    assert_eq!(mode(&s.paths.key_file), 0o600);
    assert_eq!(mode(&s.paths.bundle), 0o600);
    assert!(!s
        .paths
        .key_file
        .starts_with(s.paths.bundle.parent().unwrap().parent().unwrap()));
    // Each call reads from disk, as a restart would.
    assert_eq!(unlocked_fingerprint(status(&s.paths)), s.fingerprint);
    assert_eq!(unlocked_fingerprint(status(&s.paths)), s.fingerprint);
    assert!(set_up(
        &s.paths,
        &NO_KEYCHAIN,
        &RecoveryKey::generate(),
        &CredentialKeys::generate()
    )
    .is_err());
}

#[test]
fn lost_key_file_comes_back_from_the_words() {
    let s = new_setup();
    fs::remove_file(&s.paths.key_file).unwrap();
    let State::KeyFileMissing { needs } = status(&s.paths) else {
        panic!()
    };
    assert_eq!(needs, s.recovery.id());

    let typed = RecoveryKey::from_bytes(*s.recovery.bytes());
    let unlocked = recover(&s.paths, &typed).ok().unwrap();
    assert_eq!(unlocked.keys.fingerprint(), s.fingerprint);
    assert_eq!(mode(&s.paths.key_file), 0o600);
    assert_eq!(unlocked_fingerprint(status(&s.paths)), s.fingerprint);
}

#[test]
fn words_for_another_setup_are_refused_and_change_nothing() {
    let s = new_setup();
    fs::remove_file(&s.paths.key_file).unwrap();
    let other = RecoveryKey::generate();
    match recover(&s.paths, &other) {
        Err(RecoverError::NotThisSetup { typed, needs }) => {
            assert_eq!((typed, needs), (other.id(), s.recovery.id()));
        }
        _ => panic!("expected a refusal"),
    }
    assert!(!s.paths.key_file.exists());
}

#[test]
fn damaged_key_file_is_refused_then_replaced_by_recovery() {
    let s = new_setup();
    fs::write(&s.paths.key_file, b"\x00garbage").unwrap();
    assert!(matches!(status(&s.paths), State::KeyFileDamaged { .. }));

    let unlocked = recover(&s.paths, &RecoveryKey::from_bytes(*s.recovery.bytes()))
        .ok()
        .unwrap();
    assert_eq!(unlocked.keys.fingerprint(), s.fingerprint);
    let kept: Vec<_> = fs::read_dir(&s.paths.key_folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with("recovery-store.replaced-"))
        .collect();
    assert_eq!(kept.len(), 1, "the damaged file is kept aside");
    assert_eq!(mode(&s.paths.key_folder.join(&kept[0])), 0o600);
}

#[test]
fn a_changed_key_with_its_old_name_is_damage() {
    let s = new_setup();
    let text = fs::read_to_string(&s.paths.key_file).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["recoveryKey"] = base64_of(&[9; 32]).into();
    fs::write(&s.paths.key_file, serde_json::to_vec(&value).unwrap()).unwrap();
    let State::KeyFileDamaged { detail, .. } = status(&s.paths) else {
        panic!()
    };
    assert_eq!(detail, "the key does not match its name");
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn readable_by_others_is_refused_until_secured() {
    for target in ["file", "folder"] {
        let s = new_setup();
        let (path, loose) = match target {
            "file" => (&s.paths.key_file, 0o644),
            _ => (&s.paths.key_folder, 0o755),
        };
        fs::set_permissions(path, fs::Permissions::from_mode(loose)).unwrap();
        assert!(
            matches!(status(&s.paths), State::KeyFileExposed { .. }),
            "{target}"
        );
        secure(&s.paths).unwrap();
        assert_eq!(
            unlocked_fingerprint(status(&s.paths)),
            s.fingerprint,
            "{target}"
        );
    }
}

#[test]
fn a_linked_key_file_is_not_followed() {
    let s = new_setup();
    let real = s.paths.key_folder.join("elsewhere");
    fs::rename(&s.paths.key_file, &real).unwrap();
    symlink(&real, &s.paths.key_file).unwrap();
    assert!(matches!(status(&s.paths), State::KeyFileNotOurs { .. }));
    assert!(secure(&s.paths).is_err());
}

#[test]
fn key_file_from_another_setup_is_named_as_such() {
    let a = new_setup();
    let b = new_setup();
    fs::copy(&b.paths.key_file, &a.paths.key_file).unwrap();
    let State::KeyFileForAnotherKey { has, needs } = status(&a.paths) else {
        panic!()
    };
    assert_eq!((has, needs), (b.recovery.id(), a.recovery.id()));
}

#[test]
fn bundle_changes_are_caught() {
    let s = new_setup();
    let text = fs::read_to_string(&s.paths.bundle).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let header = value["header"]
        .as_str()
        .unwrap()
        .replace("\"key-file\"", "\"keychain\"");
    value["header"] = header.into();
    fs::write(&s.paths.bundle, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(matches!(status(&s.paths), State::BundleDamaged(_)));
    assert!(matches!(
        recover(&s.paths, &RecoveryKey::from_bytes(*s.recovery.bytes())),
        Err(RecoverError::Unrecoverable(State::BundleDamaged(_)))
    ));

    // Swapping the two sealed parts fails too, because they use different keys.
    let mut swapped: serde_json::Value = serde_json::from_str(&text).unwrap();
    let data_key = swapped["dataKey"].clone();
    swapped["dataKey"] = swapped["payload"].clone();
    swapped["payload"] = data_key;
    fs::write(&s.paths.bundle, serde_json::to_vec(&swapped).unwrap()).unwrap();
    assert!(matches!(status(&s.paths), State::BundleDamaged(_)));

    fs::remove_file(&s.paths.bundle).unwrap();
    assert!(matches!(status(&s.paths), State::BundleMissing));
}

#[test]
fn a_test_credential_from_another_setup_means_mixed_files() {
    let a = new_setup();
    let b = new_setup();
    fs::copy(&b.paths.test_credential, &a.paths.test_credential).unwrap();
    assert!(matches!(status(&a.paths), State::KeysDoNotMatch(_)));
}

#[test]
fn a_failed_setup_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    // A plain file where the key folder belongs makes the last write fail.
    fs::create_dir_all(paths.key_folder.parent().unwrap()).unwrap();
    fs::write(&paths.key_folder, b"in the way").unwrap();
    let recovery = RecoveryKey::generate();
    assert!(set_up(&paths, &NO_KEYCHAIN, &recovery, &CredentialKeys::generate()).is_err());
    let data_folder = paths.bundle.parent().unwrap();
    let left: Vec<_> = fs::read_dir(data_folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
    assert!(matches!(status(&paths), State::NotSetUp));

    fs::remove_file(&paths.key_folder).unwrap();
    let keys = CredentialKeys::generate();
    set_up(&paths, &NO_KEYCHAIN, &recovery, &keys).unwrap();
    assert_eq!(unlocked_fingerprint(status(&paths)), keys.fingerprint());
}

#[test]
fn setup_never_replaces_a_key_file_whose_bundle_is_missing() {
    let s = new_setup();
    fs::remove_file(&s.paths.bundle).unwrap();
    let before = fs::read(&s.paths.key_file).unwrap();
    assert!(set_up(
        &s.paths,
        &NO_KEYCHAIN,
        &RecoveryKey::generate(),
        &CredentialKeys::generate()
    )
    .is_err());
    assert_eq!(fs::read(&s.paths.key_file).unwrap(), before);
    assert!(matches!(status(&s.paths), State::BundleMissing));
}

#[test]
fn a_write_that_fails_late_leaves_no_staging_file() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    // A folder where the test credential belongs lets the staging file be written, then
    // makes the step that moves it into place fail.
    fs::create_dir_all(&paths.test_credential).unwrap();
    assert!(set_up(
        &paths,
        &NO_KEYCHAIN,
        &RecoveryKey::generate(),
        &CredentialKeys::generate()
    )
    .is_err());
    let data_folder = paths.bundle.parent().unwrap();
    let left: Vec<_> = fs::read_dir(data_folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["test-credential.json"]);
}

#[test]
fn setup_refuses_the_key_file_while_a_keychain_is_there() {
    let present = [
        Keychain::Working {
            already_running: true,
        },
        Keychain::Broken("no answer".into()),
    ];
    for keychain in present {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
        let result = set_up(
            &paths,
            &keychain,
            &RecoveryKey::generate(),
            &CredentialKeys::generate(),
        );
        assert!(result.is_err(), "{keychain:?}");
        assert!(matches!(status(&paths), State::NotSetUp));
        assert!(!dir.path().join("config").exists() && !dir.path().join("data").exists());
    }
}

#[test]
fn setup_makes_an_existing_key_folder_private() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    fs::create_dir_all(&paths.key_folder).unwrap();
    fs::set_permissions(&paths.key_folder, fs::Permissions::from_mode(0o755)).unwrap();
    let keys = CredentialKeys::generate();
    set_up(&paths, &NO_KEYCHAIN, &RecoveryKey::generate(), &keys).unwrap();
    assert_eq!(mode(&paths.key_folder), 0o700);
    assert_eq!(unlocked_fingerprint(status(&paths)), keys.fingerprint());
}

#[test]
fn setup_refuses_a_key_folder_that_is_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    fs::create_dir_all(paths.key_folder.parent().unwrap()).unwrap();
    symlink(&elsewhere, &paths.key_folder).unwrap();
    assert!(set_up(
        &paths,
        &NO_KEYCHAIN,
        &RecoveryKey::generate(),
        &CredentialKeys::generate()
    )
    .is_err());
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    assert!(matches!(status(&paths), State::NotSetUp));
}

#[test]
fn each_damaged_key_file_is_kept_even_within_one_second() {
    let s = new_setup();
    for round in 1..=2 {
        fs::write(&s.paths.key_file, format!("damage {round}")).unwrap();
        recover(&s.paths, &RecoveryKey::from_bytes(*s.recovery.bytes()))
            .ok()
            .unwrap();
    }
    let mut kept: Vec<String> = fs::read_dir(&s.paths.key_folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with("recovery-store.replaced-"))
        .map(|name| fs::read_to_string(s.paths.key_folder.join(name)).unwrap())
        .collect();
    kept.sort();
    assert_eq!(kept, ["damage 1", "damage 2"]);
}

#[test]
fn recovery_makes_a_loose_key_folder_private_first() {
    let s = new_setup();
    fs::remove_file(&s.paths.key_file).unwrap();
    fs::set_permissions(&s.paths.key_folder, fs::Permissions::from_mode(0o755)).unwrap();
    recover(&s.paths, &RecoveryKey::from_bytes(*s.recovery.bytes()))
        .ok()
        .unwrap();
    assert_eq!(mode(&s.paths.key_folder), 0o700);
    assert_eq!(unlocked_fingerprint(status(&s.paths)), s.fingerprint);
}

#[test]
fn recovery_never_touches_a_linked_key_folder() {
    let s = new_setup();
    let elsewhere = s._dir.path().join("elsewhere");
    fs::rename(&s.paths.key_folder, &elsewhere).unwrap();
    fs::write(elsewhere.join("recovery-store"), b"damaged").unwrap();
    symlink(&elsewhere, &s.paths.key_folder).unwrap();
    assert!(recover(&s.paths, &RecoveryKey::from_bytes(*s.recovery.bytes())).is_err());

    // The damaged file is neither moved aside nor replaced.
    let left: Vec<_> = fs::read_dir(&elsewhere)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["recovery-store"]);
    assert_eq!(
        fs::read(elsewhere.join("recovery-store")).unwrap(),
        b"damaged"
    );
}

#[test]
fn securing_a_key_file_swapped_for_a_pipe_fails_instead_of_hanging() {
    use std::os::unix::ffi::OsStrExt;
    let s = new_setup();
    fs::remove_file(&s.paths.key_file).unwrap();
    let fifo = std::ffi::CString::new(s.paths.key_file.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let paths = Paths::under(&s._dir.path().join("config"), &s._dir.path().join("data"));
    let (send, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || send.send(secure(&paths).is_err()));
    assert_eq!(
        answer.recv_timeout(std::time::Duration::from_secs(5)),
        Ok(true)
    );
}
