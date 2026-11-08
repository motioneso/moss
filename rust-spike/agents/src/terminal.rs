//! Terminals: a real pseudo-terminal per session, for agent sign-in and the terminal screen.
//!
//! The launch environment is built from nothing, like an agent's, and the same confinement
//! applies, so a terminal opened for one account cannot reach another account's files.

use std::io::{Read, Write};
use std::path::PathBuf;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::confine::Confinement;

pub struct TerminalSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub confinement: Option<Confinement>,
    pub rows: u16,
    pub cols: u16,
}

pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Output bytes as they arrive. Closes when the program exits.
    pub output: mpsc::Receiver<Vec<u8>>,
}

impl Terminal {
    pub fn spawn(spec: &TerminalSpec) -> std::io::Result<Self> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other)?;
        let (program, args) = match &spec.confinement {
            Some(c) => c.wrap(&spec.program, &spec.args),
            None => (spec.program.clone(), spec.args.clone()),
        };
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(&spec.cwd);
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let child = pty.slave.spawn_command(cmd).map_err(other)?;
        drop(pty.slave);

        let mut reader = pty.master.try_clone_reader().map_err(other)?;
        let writer = pty.master.take_writer().map_err(other)?;
        let (tx, rx) = mpsc::channel(64);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.blocking_send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            master: pty.master,
            writer,
            child,
            output: rx,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    pub fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other)
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.kill();
    }
}

fn other(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn read_until(t: &mut Terminal, needle: &str) -> String {
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !seen.contains(needle) {
            match tokio::time::timeout_at(deadline, t.output.recv()).await {
                Ok(Some(b)) => seen.push_str(&String::from_utf8_lossy(&b)),
                _ => panic!("never saw {needle:?}; got {seen:?}"),
            }
        }
        seen
    }

    #[tokio::test]
    async fn runs_a_shell_echoes_input_and_resizes() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Terminal::spawn(&TerminalSpec {
            program: "/bin/sh".into(),
            args: vec![],
            cwd: dir.path().into(),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            confinement: None,
            rows: 24,
            cols: 80,
        })
        .unwrap();
        t.write(b"echo moss-$((40+2)); stty size\n").unwrap();
        let out = read_until(&mut t, "24 80").await;
        assert!(out.contains("moss-42"), "{out}");

        t.resize(40, 120).unwrap();
        t.write(b"stty size; echo ${DATABASE_URL:-no}-db-$((1+1))\n").unwrap();
        let out = read_until(&mut t, "no-db-2").await;
        assert!(out.contains("40 120"), "{out}");
        t.kill();
    }
}
