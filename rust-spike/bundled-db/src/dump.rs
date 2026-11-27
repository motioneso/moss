//! Logical dump and restore of one database with the bundled `pg_dump` and `pg_restore`.
//!
//! Both tools run from the install's own Postgres bundle with a clean environment. The password
//! reaches them through a private password file that is deleted when the tool ends.

use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;

use crate::cluster::{clean_env, tool_path, Bundle, Endpoint};
use crate::layout::{Layout, PassFile};
use crate::secrets::Secret;

/// Who signs in to which running cluster.
pub struct Target<'a> {
    pub layout: &'a Layout,
    pub bundle: &'a Bundle,
    pub endpoint: &'a Endpoint,
    pub role: &'a str,
    pub password: &'a Secret,
}

impl Target<'_> {
    fn command(&self, tool: &str, database: &str) -> Result<(Command, PassFile), String> {
        let program = self.bundle.bin(tool);
        if !program.is_file() {
            return Err(format!("Postgres bundle has no bin/{tool}"));
        }
        let pass = self
            .layout
            .pass_file(self.role, self.password)
            .map_err(|e| format!("password file: {e}"))?;
        let mut command = Command::new(program);
        clean_env(&mut command);
        command
            .env("PGPASSFILE", tool_path(pass.path()))
            .env("PGCONNECT_TIMEOUT", "10")
            .arg("--no-password")
            .arg("--host")
            .arg(match &self.endpoint.socket_dir {
                Some(dir) => tool_path(dir).into_os_string(),
                None => "127.0.0.1".into(),
            })
            .arg("--port")
            .arg(self.endpoint.port.to_string())
            .arg("--username")
            .arg(self.role)
            .arg("--dbname")
            .arg(database);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(crate::cluster::CREATE_NO_WINDOW);
        }
        Ok((command, pass))
    }
}

/// Writes a custom-format dump of `database` to `out`, including the statements that create the
/// database itself. Returns the bytes written.
pub fn dump(target: &Target, database: &str, out: &mut dyn Write) -> Result<u64, String> {
    let (mut command, _pass) = target.command("pg_dump", database)?;
    command
        .args(["--format=custom", "--create", "--lock-wait-timeout=60000"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("start pg_dump: {e}"))?;
    let errors = drain(&mut child);
    let mut stdout = child.stdout.take().expect("piped stdout");
    let copied = io::copy(&mut stdout, out);
    finish(child, errors, "pg_dump", copied.map_err(|e| e.to_string()))
}

/// Restores a dump made by [`dump`] into a cluster that does not have its database yet. The
/// tool connects to `maintenance` (normally `postgres`), creates the database and stops at the
/// first error. Returns the bytes the tool read.
pub fn restore(target: &Target, maintenance: &str, input: &mut dyn Read) -> Result<u64, String> {
    let (mut command, _pass) = target.command("pg_restore", maintenance)?;
    command
        .args(["--create", "--exit-on-error"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("start pg_restore: {e}"))?;
    let errors = drain(&mut child);
    let mut stdin = child.stdin.take().expect("piped stdin");
    let copied = match io::copy(input, &mut stdin) {
        // The tool may stop reading once it has the whole dump. Its exit status decides.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(0),
        other => other,
    };
    drop(stdin);
    finish(
        child,
        errors,
        "pg_restore",
        copied.map_err(|e| e.to_string()),
    )
}

/// Reads the tool's error output on a thread, keeping the last few kilobytes.
fn drain(child: &mut Child) -> JoinHandle<String> {
    let mut stderr = child.stderr.take().expect("piped stderr");
    std::thread::spawn(move || {
        let mut tail = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut chunk) {
            if count == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..count]);
            if tail.len() > 8192 {
                tail.drain(..tail.len() - 8192);
            }
        }
        String::from_utf8_lossy(&tail).trim().to_string()
    })
}

fn finish(
    mut child: Child,
    errors: JoinHandle<String>,
    tool: &str,
    copied: Result<u64, String>,
) -> Result<u64, String> {
    let status = child.wait().map_err(|e| format!("wait for {tool}: {e}"))?;
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("{tool} failed ({status}): {errors}"));
    }
    copied.map_err(|e| format!("{tool} stream: {e}"))
}
