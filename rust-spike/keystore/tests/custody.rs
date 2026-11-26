use std::fs;

use keystore::custody::{
    find_plaintext, migrate, read_key_file, restore_with_words, setup_route, start_gate,
    unwrap_with_recovery, write_key_file, CustodyError, FakeMode, MasterKey, MemoryStore,
    OsKeyStore, SetupRoute,
};
use keystore::recovery::RecoveryKey;

const CREDS: &[u8] = br#"{"app_url":"postgres://app:test-app-secret-1234@127.0.0.1/db","auth_secret":"test-auth-secret-5678-abcd","connector_key":"test-connector-key-9012"}"#;

#[test]
fn locked_store_refuses_to_start_with_locked_code() {
    let store = MemoryStore::new(FakeMode::Locked);
    let error = start_gate(&store, "svc").err().expect("locked must refuse");
    assert_eq!(error.code(), "app_keystore_locked");
    assert!(error.reason().contains("Unlock your key store"));
}

#[test]
fn recovery_words_restore_and_wrong_words_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    let migration = migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    assert!(!dir.path().join("credentials.json").exists());
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let words: Vec<String> = migration
        .recovery
        .words()
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(words.len(), 24);
    let restored = restore_with_words(&bundle, &words).unwrap();
    assert_eq!(restored, CREDS);
    let wrong: Vec<String> = RecoveryKey::generate()
        .words()
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert!(restore_with_words(&bundle, &wrong).is_err());
    let _ = unwrap_with_recovery(&bundle, &migration.recovery).unwrap();
}

#[test]
fn migration_leaves_no_plaintext_under_instance_root() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("nested")).unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    let secrets = vec![
        b"test-auth-secret-5678-abcd".to_vec(),
        b"test-connector-key-9012".to_vec(),
    ];
    assert!(find_plaintext(dir.path(), &secrets).is_empty());
}

#[test]
fn plaintext_leak_is_found_by_the_search() {
    // Negative control at unit level. The runner control uses the same search.
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    let result = migrate(dir.path(), &mut store, "svc", true);
    assert!(
        result.is_err(),
        "a leaked plaintext copy must fail migration checks"
    );
}

#[test]
fn desktop_missing_or_broken_store_stops_with_no_key_file_route() {
    for mode in [FakeMode::Missing, FakeMode::Broken] {
        let store = MemoryStore::new(mode);
        match setup_route(true, store.probe()) {
            SetupRoute::Stop(_) => {}
            other => panic!("desktop must stop, got {other:?}"),
        }
    }
    let locked = MemoryStore::new(FakeMode::Locked);
    assert_eq!(
        setup_route(true, locked.probe()),
        SetupRoute::Stop(CustodyError::Locked)
    );
    // Headless with no keychain session may choose a key file.
    let missing = MemoryStore::new(FakeMode::Missing);
    assert_eq!(
        setup_route(false, missing.probe()),
        SetupRoute::KeyFileChoice
    );
    // Headless with a broken store may not. Broken stops everywhere.
    let broken = MemoryStore::new(FakeMode::Broken);
    assert!(matches!(
        setup_route(false, broken.probe()),
        SetupRoute::Stop(_)
    ));
}

#[test]
fn headless_key_file_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("master.key");
    let master = MasterKey::generate();
    write_key_file(&path, &master).unwrap();
    assert_eq!(read_key_file(&path).unwrap().bytes(), master.bytes());
}

#[test]
fn master_key_restores_bundle_after_migration() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    assert_eq!(
        keystore::custody::unwrap_with_master(&bundle, &master).unwrap(),
        CREDS
    );
}

#[test]
fn migration_strips_module_settings_secrets_and_catches_nested_copies() {
    let dir = tempfile::tempdir().unwrap();
    let nested: &[u8] = br#"{"app_url":"postgres://app:x@127.0.0.1/db","auth_secret":"test-auth-secret-5678-abcd","connector_key":"test-connector-key-9012","extra":{"inner":"nested-secret-value-3456"}}"#;
    fs::write(dir.path().join("credentials.json"), nested).unwrap();
    fs::write(
        dir.path().join("modules.json"),
        br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-ai-key-7890","migrations_url":"postgres://m:x@127.0.0.1/db"}"#,
    )
    .unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(!modules.contains("test-connector-key-9012"), "{modules}");
    assert!(!modules.contains("test-ai-key-7890"), "{modules}");
    assert!(
        !modules.contains("postgres://m:x@127.0.0.1/db"),
        "database addresses move into the bundle: {modules}"
    );
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let words: Vec<String> = {
        // The nested value is inside the wrapped bundle, not on disk.
        let master = start_gate(&store, "svc").unwrap();
        let plain = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
        assert!(String::from_utf8(plain)
            .unwrap()
            .contains("nested-secret-value-3456"));
        Vec::new()
    };
    let _ = words;
    assert!(find_plaintext(dir.path(), &[b"nested-secret-value-3456".to_vec()]).is_empty());
}

#[test]
fn migration_with_real_setup_shape_strips_all_plain_secrets() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    // Real provision repeats the app address as the module producer address.
    fs::write(
        dir.path().join("modules.json"),
        br#"{"data":"/tmp/data","producer_url":"postgres://app:test-app-secret-1234@127.0.0.1/db","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456","migrations_url":"postgres://m:x@127.0.0.1/db"}"#,
    )
    .unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    assert!(find_plaintext(
        dir.path(),
        &[
            b"test-app-secret-1234".to_vec(),
            b"test-module-ai-key-3456".to_vec()
        ]
    )
    .is_empty());
    // The AI key survives inside the bundle, not in the settings file.
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-module-ai-key-3456"));
}

#[test]
fn failed_migration_keeps_everything_recoverable() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456"}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    // A leaked copy makes migration fail after the bundle is verified.
    let result = migrate(dir.path(), &mut store, "svc", true)
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"));
    assert!(result.is_err());
    // The settings still hold their secrets, so a clean retry loses nothing.
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(modules.contains("test-module-ai-key-3456"), "{modules}");
    assert!(dir.path().join("credentials.json").exists());
    // The owner removes the stray plain copy, then the retry loses nothing.
    fs::remove_file(dir.path().join("credentials-plaintext-copy.json")).unwrap();
    let clean = migrate(dir.path(), &mut store, "svc", false)
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"));
    assert!(clean.is_ok());
}

#[test]
fn interrupted_migration_resumes_and_shows_fresh_words() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456"}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    // Killed after the bundle was written, before the old file was deleted.
    let prepared = keystore::custody::prepare_instance(dir.path(), &mut store, "svc").unwrap();
    let first_words: Vec<String> = prepared.words().iter().map(|s| s.to_string()).collect();
    drop(prepared);
    assert!(dir.path().join("credentials.json").exists());
    assert!(dir.path().join("key-bundle.json").exists());
    // Relaunch resumes, shows words, and loses nothing.
    let prepared = keystore::custody::prepare_instance(dir.path(), &mut store, "svc").unwrap();
    assert_eq!(prepared.words().len(), 24);
    let second_words: Vec<String> = prepared.words().iter().map(|s| s.to_string()).collect();
    assert_ne!(first_words, second_words);
    prepared.commit_with(&mut store, "svc").unwrap();
    assert!(!dir.path().join("credentials.json").exists());
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-module-ai-key-3456"));
}

#[test]
fn failed_bundle_write_on_retry_keeps_the_old_bundle_opening() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456"}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    keystore::custody::prepare_instance(dir.path(), &mut store, "svc").unwrap();
    // The staging file cannot be created, so the retry bundle write fails.
    fs::create_dir(dir.path().join("key-bundle.staging")).unwrap();
    assert!(keystore::custody::prepare_instance(dir.path(), &mut store, "svc").is_err());
    // The old bundle still opens with its AI key.
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-module-ai-key-3456"));
    fs::remove_dir(dir.path().join("key-bundle.staging")).unwrap();
    keystore::custody::prepare_instance(dir.path(), &mut store, "svc")
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
}

#[test]
fn retry_through_a_different_store_keeps_the_module_ai_key() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456"}"#).unwrap();
    let mut first = MemoryStore::new(FakeMode::Working);
    keystore::custody::prepare_instance(dir.path(), &mut first, "svc").unwrap();
    // Settings were left whole by preparation, so a new store still finds them.
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(modules.contains("test-module-ai-key-3456"), "{modules}");
    let mut second = MemoryStore::new(FakeMode::Working);
    let prepared = keystore::custody::prepare_instance(dir.path(), &mut second, "svc").unwrap();
    prepared.commit_with(&mut second, "svc").unwrap();
    let master = start_gate(&second, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-module-ai-key-3456"));
}

#[test]
fn headless_key_file_inside_the_instance_root_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = MemoryStore::new(FakeMode::Missing);
    let inside = dir.path().join("master.key");
    assert!(keystore::custody::set_up_headless(dir.path(), CREDS, &inside, &mut session).is_err());
    let outside = dir.path().parent().unwrap().join("outside-master.key");
    let root = dir.path().join("instance");
    fs::create_dir(&root).unwrap();
    keystore::custody::set_up_headless(&root, CREDS, &outside, &mut session)
        .unwrap()
        .commit()
        .unwrap();
    assert!(keystore::custody::recorded_key_file(&root).is_some());
    let _ = fs::remove_file(outside);
}

#[test]
fn migration_moves_the_nested_embeddings_key_into_the_bundle() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","embeddings":{"url":"https://example.invalid/v1","model":"test-model","api_key":"test-embeddings-key-1357"}}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(!modules.contains("test-embeddings-key-1357"), "{modules}");
    assert!(
        modules.contains("test-model"),
        "plain model settings stay: {modules}"
    );
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-embeddings-key-1357"));
    assert!(find_plaintext(dir.path(), &[b"test-embeddings-key-1357".to_vec()]).is_empty());
}

#[test]
fn migration_with_database_folder_and_split_passwords() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("database/secrets")).unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    // The database program's own secret files are its own store, outside the claim.
    fs::write(
        dir.path().join("database/secrets/session-signing-secret"),
        "test-auth-secret-5678-abcd",
    )
    .unwrap();
    fs::write(
        dir.path().join("database/secrets/jarvis_app_runtime"),
        "test-app-secret-1234",
    )
    .unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    // The same role password copied outside the database folder is caught.
    let stray = tempfile::tempdir().unwrap();
    fs::write(stray.path().join("credentials.json"), CREDS).unwrap();
    fs::write(
        stray.path().join("password-copy.txt"),
        "test-app-secret-1234",
    )
    .unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    assert!(migrate(stray.path(), &mut store, "svc", false)
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"))
        .is_err());
}

#[test]
fn differing_module_values_ride_in_the_bundle() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","producer_url":"postgres://app:other-producer-9999@127.0.0.1/db","connector_key":"module-connector-key-7777"}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    migrate(dir.path(), &mut store, "svc", false)
        .unwrap()
        .commit_with(&mut store, "svc")
        .unwrap();
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload =
        String::from_utf8(keystore::custody::unwrap_with_master(&bundle, &master).unwrap())
            .unwrap();
    assert!(payload.contains("other-producer-9999"), "{payload}");
    assert!(payload.contains("module-connector-key-7777"), "{payload}");
    assert!(find_plaintext(
        dir.path(),
        &[
            b"other-producer-9999".to_vec(),
            b"module-connector-key-7777".to_vec()
        ]
    )
    .is_empty());
}

#[test]
fn bare_module_passwords_in_a_stray_file_fail_migration() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","migrations_url":"postgres://m:module-only-pass-9999@127.0.0.1/db","worker_url":"postgres://w:worker-only-pass-8888@127.0.0.1/db"}"#).unwrap();
    fs::write(
        dir.path().join("stray.txt"),
        "module-only-pass-9999 and worker-only-pass-8888",
    )
    .unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    let result = migrate(dir.path(), &mut store, "svc", false)
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"));
    assert!(
        result.is_err(),
        "bare module passwords outside the settings file must fail"
    );
    assert!(
        dir.path().join("credentials.json").exists(),
        "nothing was deleted"
    );
}

#[test]
fn kill_after_strip_then_failed_retry_keeps_the_ai_key() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    fs::write(dir.path().join("modules.json"), br#"{"data":"/tmp/data","connector_key":"test-connector-key-9012","ai_key":"test-module-ai-key-3456"}"#).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    // Kill after the finish stripped the settings, before the legacy delete:
    // commit's strip is simulated by preparing and committing, then putting
    // the plain file back beside the finished bundle and stripped settings.
    let prepared = keystore::custody::prepare_instance(dir.path(), &mut store, "svc").unwrap();
    prepared.commit_with(&mut store, "svc").unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(
        !modules.contains("test-module-ai-key-3456"),
        "settings really are stripped: {modules}"
    );
    // A retry that fails on a stray copy must not destroy the AI key's home.
    fs::write(dir.path().join("stray.txt"), "test-auth-secret-5678-abcd").unwrap();
    let failed = keystore::custody::prepare_instance(dir.path(), &mut store, "svc")
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"));
    assert!(failed.is_err());
    fs::remove_file(dir.path().join("stray.txt")).unwrap();
    // The clean retry succeeds and the AI key still opens from the bundle.
    let prepared = keystore::custody::prepare_instance(dir.path(), &mut store, "svc").unwrap();
    prepared.commit_with(&mut store, "svc").unwrap();
    let master = start_gate(&store, "svc").unwrap();
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let payload = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
    assert!(String::from_utf8(payload)
        .unwrap()
        .contains("test-module-ai-key-3456"));
}

#[test]
fn an_unreadable_folder_cannot_hide_a_secret_copy() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("credentials.json"), CREDS).unwrap();
    let hidden = dir.path().join("hidden");
    fs::create_dir(&hidden).unwrap();
    fs::write(hidden.join("copy.txt"), "test-auth-secret-5678-abcd").unwrap();
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();
    let mut store = MemoryStore::new(FakeMode::Working);
    let result = migrate(dir.path(), &mut store, "svc", false)
        .and_then(|prepared| prepared.commit_with(&mut store, "svc"));
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err(), "an unreadable folder must count as a hit");
    assert!(dir.path().join("credentials.json").exists());
}
