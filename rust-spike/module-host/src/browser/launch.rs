//! Starts the pinned Chromium in a network namespace with no route out.
//!
//! The browser runs under `bwrap` with its own user, network, process, IPC and host-name
//! namespaces. The network namespace holds only a loopback, so the browser cannot open a socket
//! that leaves it, whatever the page asks for. Chromium's own sandbox stays on. If the namespace
//! or the sandbox cannot be set up the browser does not start and the port reports
//! `unsupported`; there is no fallback to a browser with network access.
//!
//! The host talks to the browser over `--remote-debugging-pipe`: the child's standard input and
//! output are passed to it as descriptors 3 and 4 by a one-line shell wrapper, so no port opens.
use anyhow::{bail, ensure, Context, Result};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

/// The one browser build the port will run.
pub const PINNED_VERSION: &str = "157.0.8103.78";
/// SHA-256 of `chrome-linux64.zip` for that version, checked by the fetch script. Google does not
/// publish a checksum, so this is the hash of the file the maintainers downloaded, which also
/// matched the MD5 the storage server reported for the file.
pub const PINNED_SHA256: &str = "9223832977a13db3646201b1341c1f9cf08afa3ceae92540116d7b0c062364fb";
/// File the fetch script writes beside the browser once the checksum matched.
pub const PIN_MARKER: &str = ".moss-pin";

/// How the browser is isolated from the network. Production is always `Namespace`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    Namespace,
    /// Proof only. Starts the browser with the host's network so a test can see that probes
    /// reach a listener when the namespace is missing.
    #[cfg(feature = "browser-proof")]
    None,
}

#[derive(Clone, Debug)]
pub struct Launcher {
    chrome_dir: PathBuf,
    bwrap: PathBuf,
    isolation: Isolation,
    /// Proof only. Leaves Chromium's own sandbox off.
    #[cfg(feature = "browser-proof")]
    no_sandbox: bool,
    /// Proof only. Stops bubblewrap from allowing nested user namespaces, which Chromium's
    /// sandbox needs.
    #[cfg(feature = "browser-proof")]
    block_nested_namespaces: bool,
}

/// A running browser. Dropping it kills the process tree and removes the throwaway profile.
pub struct Process {
    child: Child,
    pub to_browser: Option<ChildStdin>,
    pub from_browser: Option<ChildStdout>,
    profile: PathBuf,
}

impl Launcher {
    /// `chrome_dir` holds the unpacked `chrome-linux64` folder and its pin marker.
    pub fn new(chrome_dir: impl Into<PathBuf>) -> Self {
        Self {
            chrome_dir: chrome_dir.into(),
            bwrap: PathBuf::from("/usr/bin/bwrap"),
            isolation: Isolation::Namespace,
            #[cfg(feature = "browser-proof")]
            no_sandbox: false,
            #[cfg(feature = "browser-proof")]
            block_nested_namespaces: false,
        }
    }
    #[cfg(feature = "browser-proof")]
    pub fn with_isolation(mut self, isolation: Isolation) -> Self {
        self.isolation = isolation;
        self
    }
    #[cfg(feature = "browser-proof")]
    pub fn without_chromium_sandbox(mut self) -> Self {
        self.no_sandbox = true;
        self
    }
    #[cfg(feature = "browser-proof")]
    pub fn blocking_nested_namespaces(mut self) -> Self {
        self.block_nested_namespaces = true;
        self
    }

    /// Fails when this machine cannot run the browser the safe way.
    pub fn check(&self) -> Result<()> {
        ensure!(cfg!(target_os = "linux"), "The browser port needs Linux");
        ensure!(
            self.bwrap.is_file(),
            "The network namespace tool is not installed"
        );
        let pin = fs::read_to_string(self.chrome_dir.join(PIN_MARKER))
            .context("The browser has not been fetched")?;
        ensure!(
            pin.trim() == format!("{PINNED_VERSION} {PINNED_SHA256}"),
            "The browser is not the pinned build"
        );
        ensure!(
            self.chrome_dir.join("chrome-linux64/chrome").is_file(),
            "The browser program is missing"
        );
        Ok(())
    }

    /// The arguments for bubblewrap and Chromium. Pure, so a test can read them.
    pub fn arguments(&self, profile: &Path) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec![];
        let mut push = |items: &[&str]| args.extend(items.iter().map(OsString::from));
        if self.isolation == Isolation::Namespace {
            push(&[
                "--unshare-user",
                "--unshare-net",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-cgroup-try",
            ]);
        } else {
            push(&["--unshare-user", "--unshare-pid"]);
        }
        push(&["--die-with-parent", "--new-session"]);
        #[cfg(feature = "browser-proof")]
        if self.block_nested_namespaces {
            push(&["--disable-userns"]);
        }
        push(&[
            "--ro-bind",
            "/usr",
            "/usr",
            "--symlink",
            "usr/lib",
            "/lib",
            "--symlink",
            "usr/lib64",
            "/lib64",
            "--symlink",
            "usr/bin",
            "/bin",
            "--tmpfs",
            "/etc",
            "--ro-bind-try",
            "/etc/fonts",
            "/etc/fonts",
            "--ro-bind-try",
            "/etc/ld.so.cache",
            "/etc/ld.so.cache",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
        ]);
        args.push(self.chrome_dir.join("chrome-linux64").into());
        args.push("/opt/chrome".into());
        args.extend(["--bind".into(), profile.into(), "/profile".into()]);
        args.extend(["--chdir".into(), "/profile".into(), "--".into()]);
        args.push("/opt/chrome/chrome".into());
        let mut flags = vec![
            "--headless=new",
            "--remote-debugging-pipe",
            "--user-data-dir=/profile",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-sync",
            "--no-pings",
            "--disable-breakpad",
            "--disable-extensions",
            "--mute-audio",
            "--hide-scrollbars",
        ];
        #[cfg(feature = "browser-proof")]
        if self.no_sandbox {
            flags.push("--no-sandbox");
        }
        flags.push("about:blank");
        args.extend(flags.into_iter().map(OsString::from));
        args
    }

    /// Starts the browser. The returned process holds the two pipe ends.
    pub fn start(&self) -> Result<Process> {
        self.check()?;
        let profile = std::env::temp_dir().join(format!("moss-browser-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&profile).context("No room for a browser profile")?;
        // A failed start must not leave a profile behind.
        let mut process = Process {
            child: {
                let mut command = Command::new("sh");
                // Descriptors 3 and 4 carry the debugging pipe. Standard output and error are
                // discarded so nothing the browser prints can reach a log.
                command
                    .arg("-c")
                    .arg(r#"exec "$@" 3<&0 4>&1 0</dev/null 1>/dev/null 2>/dev/null"#)
                    .arg("sh")
                    .arg(&self.bwrap)
                    .args(self.arguments(&profile))
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .env_clear()
                    .env("PATH", "/usr/bin:/bin");
                match command.spawn() {
                    Ok(child) => child,
                    Err(_) => {
                        let _ = fs::remove_dir_all(&profile);
                        bail!("The browser could not be started");
                    }
                }
            },
            to_browser: None,
            from_browser: None,
            profile,
        };
        process.to_browser = process.child.stdin.take();
        process.from_browser = process.child.stdout.take();
        ensure!(
            process.to_browser.is_some() && process.from_browser.is_some(),
            "The browser pipe did not open"
        );
        Ok(process)
    }
}

/// Kills process `pid` at `at` unless the returned sender is dropped first. Ending a browser this
/// way needs no pipe write, so a browser that stops reading cannot outlive its render.
pub fn watchdog(pid: u32, at: std::time::Instant) -> std::sync::mpsc::Sender<()> {
    let (stop, wait) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let wait_for = at.saturating_duration_since(std::time::Instant::now());
        if matches!(
            wait.recv_timeout(wait_for),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            let _ = Command::new("/bin/kill").args(["-9", &pid.to_string()]).status();
        }
    });
    stop
}

impl Process {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
    /// True once the browser process has exited.
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // Killing the wrapper ends its process namespace, which ends the browser with it.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.profile);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn the_browser_always_gets_its_own_network_namespace_and_keeps_its_sandbox() {
        let args = text(&Launcher::new("/x").arguments(Path::new("/p")));
        for needed in ["--unshare-net", "--unshare-user", "--unshare-pid", "--die-with-parent"] {
            assert!(args.iter().any(|a| a == needed), "{needed}");
        }
        assert!(!args.iter().any(|a| a == "--no-sandbox"));
        assert!(args.iter().any(|a| a == "--remote-debugging-pipe"));
        // No port-based debugging, and the page cannot see the host's folders.
        assert!(!args.iter().any(|a| a.starts_with("--remote-debugging-port")));
        assert!(!args.iter().any(|a| a == "/home" || a == "/root"));
    }

    #[test]
    fn the_watchdog_kills_a_process_at_its_deadline_and_spares_one_that_finished() {
        use std::time::{Duration, Instant};
        let mut late = Command::new("sleep").arg("30").spawn().unwrap();
        let _held = watchdog(late.id(), Instant::now() + Duration::from_millis(300));
        let started = Instant::now();
        assert!(!late.wait().unwrap().success());
        assert!(started.elapsed() < Duration::from_secs(10));
        let mut early = Command::new("sleep").arg("1").spawn().unwrap();
        drop(watchdog(early.id(), Instant::now() + Duration::from_millis(300)));
        assert!(early.wait().unwrap().success());
    }

    #[test]
    fn an_unpinned_or_missing_browser_is_refused() {
        let dir = std::env::temp_dir().join(format!("moss-pin-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let launcher = Launcher::new(&dir);
        assert!(launcher.check().is_err());
        fs::write(dir.join(PIN_MARKER), "1.0.0 deadbeef").unwrap();
        assert!(launcher.check().is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
