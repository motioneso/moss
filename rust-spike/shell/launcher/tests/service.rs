//! Isolated native command failures: never touch the signed-in user's services.
#![cfg(unix)]
use moss_launcher::service;
use std::path::PathBuf;
use std::sync::Mutex;
static ENV: Mutex<()> = Mutex::new(());
struct Fixture {
    root: PathBuf,
    old: Vec<(&'static str, Option<std::ffi::OsString>)>,
}
impl Fixture {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("moss-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir(root.join("instance")).unwrap();
        std::fs::write(root.join("moss-launcher"), "fixture").unwrap();
        let old = ["PATH", "HOME", "XDG_CONFIG_HOME", "MOSS_TEST_ROOT"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        std::env::set_var(
            "PATH",
            format!("{}:/usr/bin:/bin", root.join("bin").display()),
        );
        std::env::set_var("HOME", &root);
        std::env::set_var("XDG_CONFIG_HOME", root.join("config"));
        std::env::set_var("MOSS_TEST_ROOT", &root);
        for manager in ["systemctl", "launchctl"] {
            let path = root.join("bin").join(manager);
            std::fs::write(&path, "#!/bin/sh\ncase \"$*\" in\n *reset-failed*) touch \"$MOSS_TEST_ROOT/reset\";;\n *show*) cat \"$MOSS_TEST_ROOT/state\" 2>/dev/null || echo LoadState=not-found; exit 0;;\n *disable*) [ ! -f \"$MOSS_TEST_ROOT/refuse\" ]; exit $?;;\n print*) [ -f \"$MOSS_TEST_ROOT/loaded\" ] && exit 0; exit 3;;\n bootstrap*) touch \"$MOSS_TEST_ROOT/loaded\";;\n bootout*) [ -f \"$MOSS_TEST_ROOT/loaded\" ] || exit 3; rm \"$MOSS_TEST_ROOT/loaded\";;\nesac\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self { root, old }
    }
    fn folder(&self) -> PathBuf {
        self.root.join("instance")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.old {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[cfg(target_os = "linux")]
#[test]
fn linux_registration_bounds_crash_restarts() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    service::start(&f.root, &f.folder()).unwrap();
    let unit = f
        .root
        .join("config/systemd/user")
        .join(format!("{}.service", service::name(&f.folder())));
    let text = std::fs::read_to_string(unit).unwrap();
    assert!(
        text.contains("StartLimitIntervalSec=infinity\n"),
        "restart window missing: {text}"
    );
    assert!(
        text.contains("StartLimitBurst=3\n"),
        "restart limit missing: {text}"
    );
}
#[test]
fn stop_reports_the_step_and_remedy() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    std::fs::create_dir(f.folder().join(service::STOPPED)).unwrap();
    let message = service::stop(&f.root, &f.folder()).unwrap_err();
    assert!(
        message.contains("save") && message.contains("folder") && message.contains("permission"),
        "{message}"
    );
    std::fs::remove_dir(f.folder().join(service::STOPPED)).unwrap();
    std::fs::create_dir(f.folder().join("service.lock")).unwrap();
    let message = service::stop(&f.root, &f.folder()).unwrap_err();
    assert!(
        message.contains("lock") && message.contains("permission"),
        "{message}"
    );
}
#[cfg(target_os = "linux")]
#[test]
fn stop_service_manager_failure_has_a_stop_remedy() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    std::fs::write(f.root.join("refuse"), "").unwrap();
    let message = service::stop(&f.root, &f.folder()).unwrap_err();
    assert!(
        message.contains("disable") && message.contains("sign-in") && message.contains("Stop"),
        "{message}"
    );
}
#[cfg(target_os = "macos")]
#[test]
fn macos_stop_twice_removes_the_login_plist() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    service::start(&f.root, &f.folder()).unwrap();
    let plist = f
        .root
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", service::name(&f.folder())));
    service::stop(&f.root, &f.folder()).unwrap();
    service::stop(&f.root, &f.folder()).unwrap();
    assert!(!plist.exists(), "Stop left a login plist behind");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_native_state_reports_starting_and_terminal_failure() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    for (native, expected) in [
        (
            "LoadState=not-found\nActiveState=inactive",
            service::State::Unregistered,
        ),
        (
            "LoadState=loaded\nActiveState=activating",
            service::State::Starting,
        ),
        (
            "LoadState=loaded\nActiveState=active",
            service::State::Starting,
        ),
        (
            "LoadState=loaded\nActiveState=failed",
            service::State::Failed,
        ),
    ] {
        std::fs::write(f.root.join("state"), native).unwrap();
        assert_eq!(service::state(&f.folder()).unwrap(), expected);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn explicit_start_resets_the_budget_after_clean_and_failed_starts() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    for active in ["inactive", "active", "failed"] {
        std::fs::write(
            f.root.join("state"),
            format!("LoadState=loaded\nActiveState={active}\n"),
        )
        .unwrap();
        service::reset_failure(&f.folder()).unwrap();
        assert!(
            f.root.join("reset").is_file(),
            "explicit Start did not reset {active}"
        );
        std::fs::remove_file(f.root.join("reset")).unwrap();
    }
    std::fs::write(
        f.root.join("state"),
        "LoadState=not-found\nActiveState=inactive\n",
    )
    .unwrap();
    service::reset_failure(&f.folder()).unwrap();
    assert!(
        !f.root.join("reset").exists(),
        "first install has no unit to reset"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn explicit_start_tolerates_an_inactive_unit_unloaded_before_reset() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    std::fs::write(f.root.join("bin/systemctl"), "#!/bin/sh\ncase \"$*\" in\n *reset-failed*) exit 1;;\n *show*) cat \"$MOSS_TEST_ROOT/state\";;\nesac\n").unwrap();
    for active in ["inactive", "failed", "active"] {
        std::fs::write(
            f.root.join("state"),
            format!("LoadState=loaded\nActiveState={active}\n"),
        )
        .unwrap();
        let result = service::reset_failure(&f.folder());
        assert_eq!(result.is_ok(), active == "inactive", "{active}: {result:?}");
    }
}
