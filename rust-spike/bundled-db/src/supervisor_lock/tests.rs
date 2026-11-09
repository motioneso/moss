use super::*;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ROOT: &str = "MOSS_SUPERVISOR_LOCK_TEST_ROOT";
const MODE: &str = "MOSS_SUPERVISOR_LOCK_TEST_MODE";

fn child(root: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "supervisor_lock::tests::subprocess",
            "--nocapture",
        ])
        .env(ROOT, root)
        .env(MODE, mode)
        .stdin(Stdio::null());
    command
}

#[test]
fn subprocess() {
    let Some(root) = std::env::var_os(ROOT) else {
        return;
    };
    let layout = Layout::open(Path::new(&root)).unwrap();
    match std::env::var(MODE).unwrap().as_str() {
        "busy" => assert!(
            lock(&layout).is_err(),
            "second process must see the held lock"
        ),
        "free" => {
            let _guard = lock(&layout).unwrap();
        }
        "hold" => {
            let _guard = lock(&layout).unwrap();
            println!("SUPERVISOR_LOCK_HELD");
            std::io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_secs(30));
        }
        _ => panic!("unknown child mode"),
    }
}

fn check(root: &Path, mode: &str) {
    let output = child(root, mode).output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed; 0 failed"),
        "{mode}: {} {}",
        stdout,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn canonical_lock_serializes_handles_and_processes_without_truncating_pid() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    let guard = lock(&layout).unwrap();
    assert_eq!(
        std::fs::read_to_string(&layout.lock).unwrap(),
        std::process::id().to_string()
    );
    assert!(
        lock(&layout).is_err(),
        "second handle must see the held lock"
    );
    check(&layout.root, "busy");
    assert_eq!(
        std::fs::read_to_string(&layout.lock).unwrap(),
        std::process::id().to_string()
    );
    let second = Layout::create(&temp.path().join("second")).unwrap();
    let independent = lock(&second).unwrap();
    drop(guard);
    check(&layout.root, "free");
    drop((independent, second, layout));
}

#[test]
fn canonical_lock_is_released_after_supervisor_process_death() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    let mut owner = child(&layout.root, "hold")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // Bound the handshake so a child failure cannot leave the gate waiting indefinitely.
    let (send, receive) = std::sync::mpsc::channel();
    let stdout = owner.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let held = BufReader::new(stdout)
            .lines()
            .any(|line| line.is_ok_and(|s| s == "SUPERVISOR_LOCK_HELD"));
        let _ = send.send(held);
    });
    let ready = receive
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or(false);
    if !ready {
        let _ = owner.kill();
        let _ = owner.wait();
        reader.join().unwrap();
        panic!("child did not acquire the supervisor lock");
    }
    assert!(lock(&layout).is_err());
    owner.kill().unwrap();
    owner.wait().unwrap();
    reader.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let guard = loop {
        match lock(&layout) {
            Ok(guard) => break guard,
            Err(error) if Instant::now() >= deadline => {
                panic!("lock stayed held after process death: {error}")
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    drop((guard, layout));
}

#[cfg(windows)]
#[test]
fn windows_guard_retains_pins_and_serializes_private_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("install");
    let layout = Layout::create(&path).unwrap();
    let guard = lock(&layout).unwrap();
    drop(layout);
    assert!(
        std::fs::rename(&path, temp.path().join("moved")).is_err(),
        "guard must retain directory pins"
    );
    guard.write_state(b"committed").unwrap();
    let reopened = Layout::open(&path).unwrap();
    assert_eq!(reopened.read_state().unwrap(), "committed");
    assert!(lock(&reopened).is_err());
    drop(reopened);
    drop(guard);
    std::fs::rename(&path, temp.path().join("moved")).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_lock_rejects_planted_nonprivate_file_without_modifying_it() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    std::fs::write(&layout.lock, b"planted").unwrap();
    assert!(lock(&layout).is_err(), "unvalidated lock must be refused");
    assert_eq!(std::fs::read(&layout.lock).unwrap(), b"planted");
    drop(layout);
}

#[cfg(windows)]
#[test]
fn windows_lock_rejects_redirected_public_path() {
    let temp = tempfile::tempdir().unwrap();
    let mut layout = Layout::create(&temp.path().join("install")).unwrap();
    layout.lock = temp.path().join("redirected");
    assert!(
        lock(&layout).is_err(),
        "redirected lock path must be refused"
    );
    assert!(!layout.lock.exists());
    drop(layout);
}

#[cfg(windows)]
#[test]
fn windows_lock_handle_cannot_be_deleted_or_replaced_while_held() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::create(&temp.path().join("install")).unwrap();
    let guard = lock(&layout).unwrap();
    assert!(
        std::fs::remove_file(&layout.lock).is_err(),
        "held lock must deny deletion"
    );
    assert!(std::fs::rename(&layout.lock, layout.lock.with_extension("moved")).is_err());
    drop(guard);
    std::fs::remove_file(&layout.lock).unwrap();
    drop(layout);
}
