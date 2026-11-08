//! Keeps one account's agent out of every other account's files when all accounts share one
//! OS user.
//!
//! Linux: `moss-confine` applies a Landlock rule set to itself and then becomes the agent, so
//! the agent and everything it starts can only reach the folders listed here. The rule set is
//! an allow list, so anything not named (other accounts, the database folder, the key store)
//! is refused by the kernel.
//!
//! macOS and Windows: no confinement yet. `status()` says so, and the shared-install notice
//! must not claim more (Phase 3 kill gate).

use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct Confinement {
    /// Read and run only.
    pub read: Vec<PathBuf>,
    /// Read, write, create and delete.
    pub write: Vec<PathBuf>,
    /// The `moss-confine` program.
    pub launcher: PathBuf,
}

/// System folders every agent needs to start: libraries, certificates, time zones, devices.
/// Home folders, the Moss data root and other accounts are deliberately absent.
pub const SYSTEM_READ: &[&str] = &[
    "/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc", "/opt", "/proc", "/sys", "/snap",
    "/nix",
];
/// The shared temporary folder is left out on purpose: every account's agent could read what
/// another left there. Each agent gets a private one through TMPDIR instead.
/// Only the device nodes agents need. All of `/dev` would include `/dev/shm`, which every
/// account could share files through.
pub const SYSTEM_WRITE: &[&str] = &[
    "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/ptmx",
    "/dev/pts",
];

impl Confinement {
    /// Rewrites a launch so the launcher confines itself first, then runs the agent.
    pub fn wrap(&self, program: &std::path::Path, args: &[String]) -> (PathBuf, Vec<String>) {
        let mut out = Vec::new();
        for p in &self.read {
            out.push("--read".into());
            out.push(p.to_string_lossy().into_owned());
        }
        for p in &self.write {
            out.push("--write".into());
            out.push(p.to_string_lossy().into_owned());
        }
        out.push("--".into());
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        (self.launcher.clone(), out)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfinementStatus {
    pub os: &'static str,
    /// True only where this build can confine an agent and the kernel accepted it.
    pub enforced: bool,
    pub detail: String,
}

/// What this OS gives. On Linux it asks the kernel, so an old kernel reports false.
pub fn status() -> ConfinementStatus {
    #[cfg(target_os = "linux")]
    {
        match linux::probe() {
            Ok(abi) => ConfinementStatus {
                os: "linux",
                enforced: true,
                detail: format!("Landlock ABI {abi}: file access limited to each account's own folders; the session bus and process list are not"),
            },
            Err(e) => ConfinementStatus {
                os: "linux",
                enforced: false,
                detail: format!("Landlock unavailable: {e}"),
            },
        }
    }
    #[cfg(target_os = "macos")]
    {
        ConfinementStatus {
            os: "macos",
            enforced: false,
            detail: "not built yet; the planned route is the system sandbox profile".into(),
        }
    }
    #[cfg(windows)]
    {
        ConfinementStatus {
            os: "windows",
            enforced: false,
            detail: "not built yet; the planned route is an AppContainer or a restricted token".into(),
        }
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    use std::path::Path;

    use landlock::{
        Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, ABI,
    };

    const ABI_TARGET: ABI = ABI::V3;

    /// Asks the kernel which Landlock version it runs, without restricting anything.
    pub fn probe() -> Result<i32, String> {
        // landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
        let v = unsafe { libc_syscall_version() };
        if v < 1 {
            return Err("kernel has no Landlock, or it is switched off".into());
        }
        Ok(v)
    }

    unsafe fn libc_syscall_version() -> i32 {
        extern "C" {
            fn syscall(num: i64, ...) -> i64;
        }
        const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
        const VERSION_FLAG: u32 = 1;
        syscall(SYS_LANDLOCK_CREATE_RULESET, std::ptr::null::<u8>(), 0usize, VERSION_FLAG) as i32
    }

    /// Confines the calling process for good. Missing folders are skipped, not fatal.
    pub fn restrict_self(read: &[&Path], write: &[&Path]) -> Result<(), String> {
        let all = AccessFs::from_all(ABI_TARGET);
        let read_access = AccessFs::from_read(ABI_TARGET);
        let mut ruleset = Ruleset::default()
            .handle_access(all)
            .map_err(|e| e.to_string())?
            .create()
            .map_err(|e| e.to_string())?;
        for p in read {
            let access = if p.is_dir() { read_access } else { read_access & AccessFs::from_file(ABI_TARGET) };
            if let Ok(fd) = PathFd::new(p) {
                ruleset = ruleset
                    .add_rule(PathBeneath::new(fd, access))
                    .map_err(|e| e.to_string())?;
            }
        }
        for p in write {
            // A rule on a file or device may carry only file rights.
            let access = if p.is_dir() { all } else { all & AccessFs::from_file(ABI_TARGET) };
            if let Ok(fd) = PathFd::new(p) {
                ruleset = ruleset
                    .add_rule(PathBeneath::new(fd, access))
                    .map_err(|e| e.to_string())?;
            }
        }
        let status = ruleset.restrict_self().map_err(|e| e.to_string())?;
        match status.ruleset {
            RulesetStatus::FullyEnforced | RulesetStatus::PartiallyEnforced => Ok(()),
            RulesetStatus::NotEnforced => Err("the kernel did not enforce the rules".into()),
        }
    }
}
