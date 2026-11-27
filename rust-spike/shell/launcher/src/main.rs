//! Small stable entrypoint: no window, server implementation or private data in this program.
#![cfg_attr(windows, windows_subsystem = "windows")]
use std::path::PathBuf;
fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let action = args
        .next()
        .ok_or("Choose a Moss program or service action")?;
    let root = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Missing launcher folder")?
        .to_owned();
    let install = if root.join("current").is_file() {
        moss_launcher::current(&root)?
    } else {
        root
    };
    if action == "moss-app" || action == "moss-server" {
        let name = action.to_str().ok_or("Invalid program")?;
        let status = moss_launcher::runtime::command(&install, name)
            .args(args)
            .status()
            .map_err(|e| e.to_string())?;
        std::process::exit(status.code().unwrap_or(1));
    }
    let folder = PathBuf::from(args.next().ok_or("A service needs an instance folder")?);
    if args.next().is_some() {
        return Err("Unexpected service arguments".into());
    }
    match action.to_str() {
        Some("service-start") => {
            moss_launcher::service::reset_failure(&folder)?;
            moss_launcher::service::start(&install, &folder)
        }
        Some("service-stop") => moss_launcher::service::stop(&install, &folder),
        Some("service-run") => moss_launcher::service::run(&install, &folder),
        Some("service-remove") => moss_launcher::service::remove(&install, &folder),
        _ => Err("Unknown Moss launcher action".into()),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Moss service: {error}");
        std::process::exit(1);
    }
}
