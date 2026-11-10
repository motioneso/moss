//! One launch policy for staged Linux installs and unstaged development programs.
use std::path::Path;
use std::process::Command;

pub fn bundled_runtime(install: &Path) -> bool {
    cfg!(target_os = "linux") && install.join("runtime").exists()
}

/// A partial runtime install must fail to launch, never silently fall back to the host.
/// moss-run uses exec, preserving the child identity used by lifecycle ownership checks.
pub fn command(install: &Path, name: &str) -> Command {
    if bundled_runtime(install) {
        let mut command = Command::new(install.join("moss-run"));
        command.arg(name);
        command
    } else if name == "openssl" {
        Command::new(name)
    } else {
        Command::new(install.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn staged_commands_require_launcher_and_keep_arguments_separate() {
        let root = std::env::temp_dir().join(format!("moss launch {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        for name in ["moss-app", "moss-shell", "moss-db", "openssl"] {
            let mut cmd = command(&root, name);
            assert_eq!(cmd.get_program(), root.join("moss-run"));
            assert_eq!(cmd.get_args().collect::<Vec<_>>(), [name]);
            assert!(
                cmd.status().is_err(),
                "missing launcher must not use the host"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn development_uses_direct_programs_and_installed_openssl() {
        let root = Path::new("/unstaged moss");
        assert_eq!(command(root, "moss-db").get_program(), root.join("moss-db"));
        assert_eq!(command(root, "openssl").get_program(), "openssl");
    }
}
