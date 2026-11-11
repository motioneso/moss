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
        match windows_openssl(install) {
            Some(bundled) if cfg!(windows) => bundled_openssl_command(&bundled),
            _ => Command::new(name),
        }
    } else {
        Command::new(install.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
    }
}

/// The OpenSSL a Windows install ships in its `openssl` folder, when that folder holds one.
pub fn windows_openssl(install: &Path) -> Option<std::path::PathBuf> {
    let exe = install.join("openssl").join("openssl.exe");
    exe.is_file().then_some(exe)
}

/// Runs the shipped OpenSSL with its own config file, so the host's config and any OpenSSL
/// found on the search path play no part. Its libraries sit beside it, where Windows looks first.
fn bundled_openssl_command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    if let Some(folder) = exe.parent() {
        command.env("OPENSSL_CONF", folder.join("openssl.cnf"));
        command.env("OPENSSL_MODULES", folder);
    }
    command
}

#[cfg(test)]
mod windows_tests {
    use super::*;

    #[test]
    fn shipped_openssl_is_found_only_when_present() {
        let root = std::env::temp_dir().join(format!("moss win openssl {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("openssl")).unwrap();
        assert_eq!(windows_openssl(&root), None);
        std::fs::write(root.join("openssl").join("openssl.exe"), b"x").unwrap();
        assert_eq!(windows_openssl(&root), Some(root.join("openssl").join("openssl.exe")));
        let command = bundled_openssl_command(&root.join("openssl").join("openssl.exe"));
        let conf = command.get_envs().find(|(k, _)| *k == "OPENSSL_CONF").and_then(|(_, v)| v).unwrap();
        assert_eq!(Path::new(conf), root.join("openssl").join("openssl.cnf"));
        std::fs::remove_dir_all(root).unwrap();
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
