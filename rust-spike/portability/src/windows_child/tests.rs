use super::*;
use std::io::Write;
use std::os::windows::ffi::OsStringExt;
use std::process::Command;
use std::time::Instant;

const HELPER: &str = "windows_child::tests::helper";

// The test binary is its own helper; no shell, script interpreter or Postgres is required.
#[test]
fn helper() {
    let args: Vec<OsString> = std::env::args_os().collect();
    let Some(index) = args.iter().position(|a| a == "moss-child-helper") else {
        return;
    };
    let mode = args[index + 1].to_str().unwrap();
    let path = Path::new(&args[index + 2]);
    match mode {
        "echo" => {
            let values: Vec<String> = args[index + 3..]
                .iter()
                .map(|a| a.to_str().unwrap().to_string())
                .collect();
            std::fs::write(path, serde_json::to_vec(&values).unwrap()).unwrap();
            println!("stdout proof");
            eprintln!("stderr proof");
            std::process::exit(37);
        }
        "leaf" => {
            std::fs::write(path, std::process::id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(90));
        }
        "tree" => {
            let leaf = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    HELPER,
                    "--nocapture",
                    "--",
                    "moss-child-helper",
                    "leaf",
                ])
                .arg(path)
                .spawn()
                .unwrap();
            // Intentionally leave the process alive. It must be contained by the parent's job.
            std::mem::forget(leaf);
            std::thread::sleep(Duration::from_secs(90));
        }
        "owner" => {
            let log = File::create(path.with_extension("log")).unwrap();
            let child = spawn_helper("tree", path, &[], &log, &log);
            std::fs::write(path.with_extension("root"), child.id().to_string()).unwrap();
            // A forced owner termination must release its job even without Rust destructors.
            std::mem::forget(child);
            std::thread::sleep(Duration::from_secs(90));
        }
        "environment-owner" => {
            #[link(name = "kernel32")]
            extern "system" {
                fn AllocConsole() -> i32;
            }
            // Give the parent a console if it has none, so removing CREATE_NO_WINDOW really
            // changes the child's attachment rather than inheriting an already-consoleless state.
            unsafe {
                AllocConsole();
            }
            // This helper owns its environment; the parallel test runner's environment is
            // never mutated. Windows variable names are case-insensitive.
            std::env::set_var("pGHOST", "must-not-reach-child");
            std::env::set_var("PGPASSWORD", "synthetic-test-marker");
            std::env::set_var("MOSSENV", "base");
            std::env::set_var("MOSSENV(X86)", "extension");
            let block = environment().unwrap();
            let entries: Vec<_> = block
                .split(|&unit| unit == 0)
                .map(String::from_utf16_lossy)
                .collect();
            let position = |prefix: &str| {
                entries
                    .iter()
                    .position(|entry| entry.starts_with(prefix))
                    .unwrap()
            };
            assert!(position("MOSSENV=") < position("MOSSENV(X86)="));
            let log = File::create(path.with_extension("log")).unwrap();
            let mut child = spawn_helper("environment", path, &[], &log, &log);
            assert!(child
                .wait_timeout(Duration::from_secs(15))
                .unwrap()
                .unwrap()
                .success());
        }
        "environment" => {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetConsoleProcessList(processes: *mut u32, count: u32) -> u32;
            }
            let pg: Vec<String> = std::env::vars_os()
                .filter(|(key, _)| key.to_string_lossy().to_ascii_uppercase().starts_with("PG"))
                .map(|(key, _)| key.to_string_lossy().to_string())
                .collect();
            std::fs::write(path, serde_json::to_vec(&pg).unwrap()).unwrap();
            let mut console_pid = 0;
            assert_eq!(
                unsafe { GetConsoleProcessList(&mut console_pid, 1) },
                0,
                "child must not be attached to a console"
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(6));
            std::process::exit(0);
        }
        "handle" => {
            #[link(name = "kernel32")]
            extern "system" {
                fn WriteFile(
                    handle: *mut c_void,
                    buffer: *const u8,
                    size: u32,
                    written: *mut u32,
                    overlapped: *mut c_void,
                ) -> i32;
            }
            let handle = args[index + 3].to_str().unwrap().parse::<usize>().unwrap() as *mut c_void;
            let mut written = 0;
            let succeeded =
                unsafe { WriteFile(handle, b"changed".as_ptr(), 7, &mut written, null_mut()) } != 0;
            std::fs::write(path, succeeded.to_string()).unwrap();
            std::process::exit(0);
        }
        _ => panic!("unknown helper mode"),
    }
}

#[test]
fn database_environment_is_removed_and_no_console_is_created() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("environment.json");
    let mut helper = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            HELPER,
            "--nocapture",
            "--",
            "moss-child-helper",
            "environment-owner",
        ])
        .arg(&path)
        .spawn()
        .unwrap();
    assert!(helper.wait().unwrap().success());
    let variables: Vec<String> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(variables.is_empty());
}

// Explicitly invoked by the elevated CI runner, not by the standard-account suite.
#[test]
#[ignore]
fn elevated_launch_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let log = File::create(temp.path().join("out.log")).unwrap();
    let result = spawn(
        &std::env::current_exe().unwrap(),
        &[],
        temp.path(),
        &log,
        &log,
    );
    assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::PermissionDenied));
}

fn spawn_helper(mode: &str, path: &Path, extra: &[OsString], out: &File, err: &File) -> Child {
    let args: Vec<OsString> = [
        "--exact",
        HELPER,
        "--nocapture",
        "--",
        "moss-child-helper",
        mode,
    ]
    .into_iter()
    .map(OsString::from)
    .chain(std::iter::once(path.as_os_str().to_owned()))
    .chain(extra.iter().cloned())
    .collect();
    spawn(
        &std::env::current_exe().unwrap(),
        &args,
        path.parent().unwrap(),
        out,
        err,
    )
    .unwrap()
}

fn wait_file(path: &Path) -> String {
    let start = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.is_empty() {
                return text;
            }
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "helper did not write {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct TrackedProcess(OwnedHandle);

impl AsRawHandle for TrackedProcess {
    fn as_raw_handle(&self) -> *mut c_void {
        self.0.as_raw_handle()
    }
}

impl Drop for TrackedProcess {
    fn drop(&mut self) {
        // Also clean up when a negative control deliberately removes job termination.
        if unsafe { WaitForSingleObject(self.as_raw_handle(), 0) } == WAIT_TIMEOUT {
            unsafe {
                TerminateProcess(self.as_raw_handle(), 1);
                WaitForSingleObject(self.as_raw_handle(), 15_000);
            }
        }
    }
}

fn process_handle(pid: u32) -> TrackedProcess {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    }
    // SYNCHRONIZE + TERMINATE; a held handle avoids PID-reuse ambiguity and cleans up on panic.
    TrackedProcess(owned(unsafe { OpenProcess(0x0010_0001, 0, pid) }).unwrap())
}

fn assert_exited(process: &TrackedProcess) {
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 15_000) },
        WAIT_OBJECT_0
    );
}

#[test]
fn direct_launch_preserves_arguments_paths_output_and_exit_code() {
    require_standard_user().expect("native qualification must run unelevated");
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("Moss space café 日本語");
    std::fs::create_dir(&directory).unwrap();
    // Test an executable path containing spaces and non-ASCII, not only its working directory.
    let executable = directory.join("Moss helper 日本語.exe");
    std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    let path = directory.join("arguments.json");
    let out = File::create(directory.join("out.log")).unwrap();
    let err = File::create(directory.join("err.log")).unwrap();
    let extra: Vec<OsString> = [
        "",
        "with spaces",
        "café 日本語",
        r#"a\"b"#,
        r"C:\trailing space\",
        r#"two\\\"quotes"#,
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let mut args: Vec<OsString> = [
        "--exact",
        HELPER,
        "--nocapture",
        "--",
        "moss-child-helper",
        "echo",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(path.as_os_str().to_owned());
    args.extend(extra.iter().cloned());
    let mut child = spawn(&executable, &args, &directory, &out, &err).unwrap();
    let status = child
        .wait_timeout(Duration::from_secs(15))
        .unwrap()
        .expect("echo timed out");
    assert_eq!(status.code(), Some(37));
    assert_eq!(child.try_wait().unwrap(), Some(status));
    let actual: Vec<String> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        actual,
        extra
            .iter()
            .map(|x| x.to_str().unwrap())
            .collect::<Vec<_>>()
    );
    assert!(std::fs::read_to_string(directory.join("out.log"))
        .unwrap()
        .contains("stdout proof"));
    assert!(std::fs::read_to_string(directory.join("err.log"))
        .unwrap()
        .contains("stderr proof"));
}

#[test]
fn dropping_child_ends_root_and_descendant_but_leaves_other_jobs_alone() {
    let temp = tempfile::tempdir().unwrap();
    let log = File::create(temp.path().join("out.log")).unwrap();
    let leaf = temp.path().join("leaf.pid");
    let child = spawn_helper("tree", &leaf, &[], &log, &log);
    let root = process_handle(child.id());
    let descendant = process_handle(wait_file(&leaf).parse().unwrap());
    let independent_path = temp.path().join("independent.pid");
    let mut independent = spawn_helper("leaf", &independent_path, &[], &log, &log);
    let _cleanup = process_handle(independent.id());
    wait_file(&independent_path);
    assert_eq!(independent.try_wait().unwrap(), None);
    drop(child);
    assert_exited(&root);
    assert_exited(&descendant);
    assert_eq!(independent.try_wait().unwrap(), None);
    independent.kill().unwrap();
    assert!(independent
        .wait_timeout(Duration::from_secs(15))
        .unwrap()
        .is_some());
}

#[test]
fn explicit_kill_ends_the_entire_tree() {
    let temp = tempfile::tempdir().unwrap();
    let log = File::create(temp.path().join("out.log")).unwrap();
    let path = temp.path().join("kill-leaf.pid");
    let mut child = spawn_helper("tree", &path, &[], &log, &log);
    let root = process_handle(child.id());
    let descendant = process_handle(wait_file(&path).parse().unwrap());
    child.kill().unwrap();
    assert_exited(&root);
    assert_exited(&descendant);
    assert!(!child.wait().unwrap().success());
}

#[test]
fn owner_crash_closes_job_without_rust_drop_and_ends_descendants() {
    let temp = tempfile::tempdir().unwrap();
    let leaf = temp.path().join("crash.pid");
    let mut owner = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            HELPER,
            "--nocapture",
            "--",
            "moss-child-helper",
            "owner",
        ])
        .arg(&leaf)
        .spawn()
        .unwrap();
    let root = process_handle(wait_file(&leaf.with_extension("root")).parse().unwrap());
    let descendant = process_handle(wait_file(&leaf).parse().unwrap());
    owner.kill().unwrap();
    owner.wait().unwrap();
    assert_exited(&root);
    assert_exited(&descendant);
}

#[test]
fn invalid_launches_leave_no_running_child() {
    let temp = tempfile::tempdir().unwrap();
    let log = File::create(temp.path().join("out.log")).unwrap();
    assert!(spawn(Path::new("relative.exe"), &[], temp.path(), &log, &log).is_err());
    assert!(spawn(
        &temp.path().join("missing.exe"),
        &[],
        temp.path(),
        &log,
        &log
    )
    .is_err());
    let nul = OsString::from_wide(&[b'a' as u16, 0, b'b' as u16]);
    assert_eq!(
        command_line(OsStr::new("test.exe"), &[nul])
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn child_inherits_only_selected_standard_handles() {
    // A child trying an unrelated inheritable handle must receive ERROR_INVALID_HANDLE.
    // The independent file must remain unchanged after the child exits.
    let temp = tempfile::tempdir().unwrap();
    let private_path = temp.path().join("private.txt");
    let mut private = File::create(&private_path).unwrap();
    private.write_all(b"unchanged").unwrap();
    let inherited = inheritable(&private).unwrap();
    let log = File::create(temp.path().join("out.log")).unwrap();
    let path = temp.path().join("handle-result.json");
    // Inspect the child through a dedicated helper mode below.
    let extra = [OsString::from(
        (inherited.as_raw_handle() as usize).to_string(),
    )];
    let mut child = spawn_helper("handle", &path, &extra, &log, &log);
    assert!(child
        .wait_timeout(Duration::from_secs(15))
        .unwrap()
        .unwrap()
        .success());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "false");
    assert_eq!(std::fs::read(&private_path).unwrap(), b"unchanged");
}
