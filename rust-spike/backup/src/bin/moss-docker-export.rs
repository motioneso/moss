//! Linux Docker-host exporter. Recovery words go to the controlling terminal once, never JSON.
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

fn run() -> Result<Value, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 2 && args[0] == "check-fence" {
        let receipt = std::fs::read(&args[1]).map_err(|_| "Cannot read the fence receipt")?;
        let receipt =
            serde_json::from_slice(&receipt).map_err(|_| "Cannot parse the fence receipt")?;
        moss_backup::docker::check_fence(&receipt)?;
        return Ok(json!({"fenced":true}));
    }
    let mut config = None;
    let mut output = None;
    let mut recovery_fd = None;
    let mut pairs = args.chunks_exact(2);
    for pair in &mut pairs {
        match pair[0].as_str() {
            "--config" => config = Some(pair[1].as_str()),
            "--output" => output = Some(pair[1].as_str()),
            "--recovery-fd" => {
                recovery_fd = Some(
                    pair[1]
                        .parse::<u32>()
                        .map_err(|_| "Recovery fd must be an inherited private pipe")?,
                )
            }
            _ => return Err("Unknown exporter option".into()),
        }
    }
    if !pairs.remainder().is_empty() {
        return Err("Each exporter option needs a value".into());
    }
    let config = config.ok_or("usage: moss-docker-export --config plan.json --output move.mossbak [--recovery-fd FD] | check-fence receipt.json")?;
    let output = output.ok_or("--output is required")?;
    let data = std::fs::read(config).map_err(|_| "Cannot read the export plan")?;
    let plan = serde_json::from_slice(&data).map_err(|_| "Cannot parse the export plan")?;
    // Open the delivery channel before any source mutation. Automated callers inherit a private
    // pipe; the normal operator sees the words once on /dev/tty. No words enter stdout/stderr.
    let path = match recovery_fd {
        Some(fd) if fd > 2 => format!("/proc/self/fd/{fd}"),
        Some(_) => return Err("Use an inherited private recovery pipe above fd 2".into()),
        None => "/dev/tty".into(),
    };
    let mut delivery = OpenOptions::new().write(true).open(path).map_err(|_| "Cannot show the recovery words. Run from a terminal or supply an inherited private recovery pipe.")?;
    #[cfg(unix)]
    if recovery_fd.is_some() {
        use std::os::unix::fs::FileTypeExt;
        if !delivery
            .metadata()
            .map_err(|_| "Cannot inspect recovery pipe")?
            .file_type()
            .is_fifo()
        {
            return Err("Recovery fd must be a private pipe, not a log or regular file".into());
        }
    }
    moss_backup::docker::export(&plan, Path::new(output), |recovery| {
        writeln!(delivery, "{}", recovery.words().join(" "))
            .and_then(|_| delivery.flush())
            .map_err(|_| "Cannot deliver the recovery words; the source remains fenced".into())
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(mut report) => {
            report["ok"] = json!(true);
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!(
                "{}",
                json!({"ok":false,"code":"docker_export_refused","error":error})
            );
            ExitCode::FAILURE
        }
    }
}
