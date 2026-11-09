use super::*;
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
};

const CHILD_PATH: &str = "MOSS_FILE_LOCK_TEST_PATH";
const CHILD_MODE: &str = "MOSS_FILE_LOCK_TEST_MODE";

fn open(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap()
}

fn child(path: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "file_lock::tests::subprocess", "--nocapture"])
        .env(CHILD_PATH, path)
        .env(CHILD_MODE, mode)
        .stdin(Stdio::null());
    command
}

#[test]
fn subprocess() {
    let Some(path) = std::env::var_os(CHILD_PATH) else {
        return;
    };
    let file = open(Path::new(&path));
    match std::env::var(CHILD_MODE).unwrap().as_str() {
        "exclusive-busy" => assert!(!try_exclusive(&file).unwrap()),
        "shared-busy" => assert!(!try_shared(&file).unwrap()),
        "exclusive-free" => assert!(try_exclusive(&file).unwrap()),
        "shared-free" => assert!(try_shared(&file).unwrap()),
        "hold" | "wait" => {
            if std::env::var(CHILD_MODE).unwrap() == "wait" {
                assert!(
                    !try_exclusive(&file).unwrap(),
                    "waiter must see a held lock"
                );
                println!("WAITING_FOR_LOCK");
                std::io::stdout().flush().unwrap();
            }
            exclusive(&file).unwrap();
            println!("LOCK_ACQUIRED");
            std::io::stdout().flush().unwrap();
            if std::env::var(CHILD_MODE).unwrap() == "hold" {
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        }
        _ => panic!("unknown child mode"),
    }
}

fn check(path: &Path, mode: &str) {
    let output = child(path, mode).output().unwrap();
    assert!(
        output.status.success(),
        "{mode}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn independent_handles_and_processes_obey_exclusive_and_shared_lifetimes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("supervisor.lock");
    let mut owner = open(&path);
    exclusive(&owner).unwrap();
    owner.write_all(b"1234").unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "1234",
        "pid stays readable while locked"
    );
    assert!(!try_exclusive(&open(&path)).unwrap());
    check(&path, "exclusive-busy");
    check(&path, "shared-busy");
    drop(owner);
    check(&path, "exclusive-free");
    let reader = open(&path);
    assert!(try_shared(&reader).unwrap());
    check(&path, "shared-free");
    check(&path, "exclusive-busy");
    drop(reader);
    check(&path, "exclusive-free");
}

#[test]
fn process_death_releases_lock_and_wakes_waiter() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("setup.lock");
    let mut owner = child(&path, "hold").stdout(Stdio::piped()).spawn().unwrap();
    let mut lines = BufReader::new(owner.stdout.take().unwrap()).lines();
    assert!(lines.any(|line| line.unwrap() == "LOCK_ACQUIRED"));
    check(&path, "exclusive-busy");
    let mut waiter = child(&path, "wait").stdout(Stdio::piped()).spawn().unwrap();
    let mut waiting = BufReader::new(waiter.stdout.take().unwrap()).lines();
    assert!(waiting.any(|line| line.unwrap() == "WAITING_FOR_LOCK"));
    assert!(
        waiter.try_wait().unwrap().is_none(),
        "waiter exited while owner still holds the lock"
    );
    owner.kill().unwrap();
    owner.wait().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = waiter.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            waiter.kill().unwrap();
            waiter.wait().unwrap();
            panic!("waiter stayed blocked after the lock owner died");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    check(&path, "exclusive-free");
}
