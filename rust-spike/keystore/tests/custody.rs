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
    let migration = migrate(dir.path(), &mut store, "svc", false).unwrap();
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
    migrate(dir.path(), &mut store, "svc", false).unwrap();
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
            SetupRoute::Stop(CustodyError::Unavailable(_)) => {}
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
    migrate(dir.path(), &mut store, "svc", false).unwrap();
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
    migrate(dir.path(), &mut store, "svc", false).unwrap();
    let modules = fs::read_to_string(dir.path().join("modules.json")).unwrap();
    assert!(!modules.contains("test-connector-key-9012"), "{modules}");
    assert!(!modules.contains("test-ai-key-7890"), "{modules}");
    assert!(modules.contains("migrations_url"), "plain settings stay: {modules}");
    let bundle = keystore::custody::read_bundle(dir.path()).unwrap();
    let words: Vec<String> = {
        // The nested value is inside the wrapped bundle, not on disk.
        let master = start_gate(&store, "svc").unwrap();
        let plain = keystore::custody::unwrap_with_master(&bundle, &master).unwrap();
        assert!(String::from_utf8(plain).unwrap().contains("nested-secret-value-3456"));
        Vec::new()
    };
    let _ = words;
    assert!(find_plaintext(dir.path(), &[b"nested-secret-value-3456".to_vec()]).is_empty());
}
