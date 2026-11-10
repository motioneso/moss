//! The keychain probe against a real, private D-Bus session bus for each test.

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use keystore::fake::{hold_secret_service, Behaviour};
use keystore::probe::{probe_address, probe_session, runtime_dir, Keychain};

struct Bus {
    daemon: Child,
    address: String,
    /// Holds the bus socket as `bus`, like a session's runtime folder.
    dir: tempfile::TempDir,
}

impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

/// Runs a probe on its own thread, so a probe with no time limit fails the test instead of
/// hanging it.
fn probe_within(limit: Duration, probe: impl FnOnce() -> Keychain + Send + 'static) -> Keychain {
    let (send, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || send.send(probe()));
    answer
        .recv_timeout(limit)
        .unwrap_or_else(|_| panic!("no result within {limit:?}"))
}

/// A session bus with no service folders, or with one holding a single service file.
fn start_bus(service_file: Option<&str>) -> Bus {
    let dir = tempfile::tempdir().unwrap();
    let service_dir = match service_file {
        Some(contents) => {
            let folder = dir.path().join("services");
            std::fs::create_dir(&folder).unwrap();
            std::fs::write(folder.join("org.freedesktop.secrets.service"), contents).unwrap();
            format!("<servicedir>{}</servicedir>", folder.display())
        }
        None => String::new(),
    };
    let config = dir.path().join("session.conf");
    std::fs::write(
        &config,
        format!(
            r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path={}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
  {service_dir}
</busconfig>"#,
            dir.path().join("bus").display()
        ),
    )
    .unwrap();
    let mut daemon = Command::new("dbus-daemon")
        .arg(format!("--config-file={}", config.display()))
        .args(["--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("dbus-daemon is installed");
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    Bus {
        daemon,
        address: address.trim().to_string(),
        dir,
    }
}

#[test]
fn no_session_bus_allows_the_key_file() {
    let runtime = tempfile::tempdir().unwrap();
    let result = probe_session(None, runtime.path());
    assert!(matches!(result, Keychain::NoSessionBus(_)), "{result:?}");
    assert!(result.allows_key_file());
}

#[test]
fn an_empty_or_relative_runtime_folder_falls_back_to_the_login_folder() {
    let login = PathBuf::from("/run/user/1000");
    assert_eq!(runtime_dir(None, 1000), login);
    assert_eq!(runtime_dir(Some("".into()), 1000), login);
    assert_eq!(runtime_dir(Some("run".into()), 1000), login);
    assert_eq!(
        runtime_dir(Some("/tmp/session".into()), 1000),
        PathBuf::from("/tmp/session")
    );
}

#[test]
fn with_no_address_the_runtime_folder_bus_is_asked() {
    let bus = start_bus(None);
    assert_eq!(probe_session(None, bus.dir.path()), Keychain::NotInstalled);
}

#[test]
fn a_set_address_that_cannot_be_reached_is_broken_not_absent() {
    let runtime = tempfile::tempdir().unwrap();
    let dead = format!("unix:path={}", runtime.path().join("gone").display());
    let result = probe_session(Some(&dead), runtime.path());
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
    assert!(!result.allows_key_file());

    // The set address is the session's bus, even when the runtime folder holds a working one.
    let bus = start_bus(None);
    let result = probe_session(Some(&dead), bus.dir.path());
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
}

#[test]
fn a_stale_bus_socket_is_broken_not_absent() {
    let runtime = tempfile::tempdir().unwrap();
    drop(UnixListener::bind(runtime.path().join("bus")).unwrap());
    let result = probe_session(None, runtime.path());
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
    assert!(!result.allows_key_file());
}

#[test]
fn a_bus_that_never_answers_the_handshake_is_broken_within_seconds() {
    let runtime = tempfile::tempdir().unwrap();
    let _silent = UnixListener::bind(runtime.path().join("bus")).unwrap();
    let folder = runtime.path().to_path_buf();
    let result = probe_within(Duration::from_secs(6), move || probe_session(None, &folder));
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
}

#[test]
fn a_bus_without_a_keychain_allows_the_key_file() {
    let bus = start_bus(None);
    assert_eq!(probe_address(&bus.address), Keychain::NotInstalled);
    assert!(Keychain::NotInstalled.allows_key_file());
}

#[test]
fn a_working_keychain_is_used_and_the_key_file_is_not_offered() {
    let bus = start_bus(None);
    let _held = hold_secret_service(Some(&bus.address), Behaviour::Working).unwrap();
    let result = probe_address(&bus.address);
    assert_eq!(
        result,
        Keychain::Working {
            already_running: true
        }
    );
    assert!(!result.allows_key_file());
}

#[test]
fn a_keychain_that_holds_the_name_but_fails_is_broken_not_absent() {
    let bus = start_bus(None);
    let _held = hold_secret_service(Some(&bus.address), Behaviour::Broken).unwrap();
    let result = probe_address(&bus.address);
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
    assert!(!result.allows_key_file());
}

#[test]
fn a_keychain_that_never_answers_is_broken_within_seconds() {
    let bus = start_bus(None);
    let _held = hold_secret_service(Some(&bus.address), Behaviour::Hangs).unwrap();
    let address = bus.address.clone();
    let result = probe_within(Duration::from_secs(10), move || probe_address(&address));
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
}

#[test]
fn a_keychain_that_fails_to_start_is_broken() {
    let bus = start_bus(Some(
        "[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/bin/false\n",
    ));
    let result = probe_address(&bus.address);
    assert!(matches!(result, Keychain::Broken(_)), "{result:?}");
    assert!(!result.allows_key_file());
}

#[test]
fn a_keychain_started_on_demand_is_used() {
    let fake = env!("CARGO_BIN_EXE_fake-secret-service");
    assert!(Path::new(fake).exists());
    let bus = start_bus(Some(&format!(
        "[D-BUS Service]\nName=org.freedesktop.secrets\nExec={fake} --working\n"
    )));
    assert_eq!(
        probe_address(&bus.address),
        Keychain::Working {
            already_running: false
        }
    );
}
