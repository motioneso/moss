use super::*;

/// A store whose folders exist and are private, whatever the shell's umask is.
fn store_in(dir: &Path) -> Store {
    let store = Store::new(dir.join("data"));
    private_dir(&store.data).unwrap();
    private_dir(&store.servers_dir()).unwrap();
    store
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("moss-provision-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn bad_names_are_refused_before_anything_is_made() {
    let dir = scratch();
    let store = Store::new(dir.join("data"));
    for name in ["", "../x", "a b", "a/b"] {
        assert_eq!(create_instance(&store, &dir, name), Err(Failure::BadName));
    }
    assert!(!dir.join("data").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn a_copy_without_the_database_program_says_so_and_makes_nothing() {
    let dir = scratch();
    let store = Store::new(dir.join("data"));
    assert_eq!(
        create_instance(&store, &dir, "work"),
        Err(Failure::NoDatabaseProgram)
    );
    assert!(!store.instance_folder("work").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn an_existing_instance_is_never_overwritten() {
    let dir = scratch();
    std::fs::write(dir.join("moss-db"), "").unwrap();
    std::fs::create_dir(dir.join("postgres")).unwrap();
    let store = store_in(&dir);
    std::fs::create_dir_all(store.instance_folder("work")).unwrap();
    std::fs::write(store.instance_folder("work").join(NETWORK_FILE), "x").unwrap();
    assert_eq!(create_instance(&store, &dir, "work"), Err(Failure::Exists));
    assert!(store.instance_folder("work").join(NETWORK_FILE).is_file());
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn an_interrupted_setup_is_cleared_and_retried() {
    let dir = scratch();
    std::fs::write(dir.join("moss-db"), "").unwrap();
    std::fs::create_dir(dir.join("postgres")).unwrap();
    let store = store_in(&dir);
    let half = store.instance_folder("work");
    std::fs::create_dir_all(&half).unwrap();
    std::fs::write(half.join("leftover"), "x").unwrap();
    // The retry gets past the Exists check, clears the leftovers, and fails later on the
    // missing OpenSSL or database, not with Exists.
    assert_ne!(create_instance(&store, &dir, "work"), Err(Failure::Exists));
    assert!(!half.join("leftover").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_hand_prepared_instance_without_a_database_folder_is_left_alone() {
    let dir = scratch();
    assert_eq!(ensure_database(&dir, &dir, false), Ok(()));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn ports_already_given_to_an_instance_are_skipped() {
    let dir = scratch();
    let store = Store::new(dir.join("data"));
    let one = store.instance_folder("one");
    std::fs::create_dir_all(&one).unwrap();
    Config {
        listen: std::net::SocketAddr::from(([0, 0, 0, 0], FIRST_PORT)),
        origins: vec![format!("https://localhost:{FIRST_PORT}")],
        sharing: false,
        certificate: PathBuf::new(),
        private_key: PathBuf::new(),
        credentials: PathBuf::new(),
    }
    .write(&one.join(NETWORK_FILE))
    .unwrap();
    let (port, _reservation) = free_port(&store).unwrap();
    assert!(port > FIRST_PORT);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn concurrent_setups_reserve_different_ports() {
    let dir = scratch();
    let store = store_in(&dir);
    let (first, _first_reservation) = free_port(&store).unwrap();
    let (second, _second_reservation) = free_port(&store).unwrap();
    assert_ne!(first, second, "unfinished setups must not share a port");
    let _ = std::fs::remove_dir_all(dir);
}
