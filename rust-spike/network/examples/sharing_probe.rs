//! A small server for the `phase7_sharing_firewall` runner. It uses the production listener
//! switch, firewall rule code and turn-on order, with a plain page in place of the app.
//!
//! Commands arrive on standard input, one per line: `on`, `off`, `listener-on`,
//! `listener-off`, `answer approve|decline` and `quit`. Each reply is one line on standard
//! output. With `PROBE_STAND_IN` set, the program instead answers the system prompt in place
//! of a person: `decline` exits 126, `approve` runs the helper command with the rights the
//! runner already has.

use axum::{routing::get, Router};
use moss_network::{
    firewall::{self, Firewall},
    policy::Policy,
    sharing::Control,
    tls::{self, Listening},
};
use std::{io::BufRead, path::PathBuf, process::Command};

fn stand_in(args: &[String]) -> i32 {
    let mode = std::env::var("PROBE_STAND_IN").unwrap_or_default();
    // `approve-add-only` says yes to a removal and does not run it, as a broken helper would.
    if mode == "approve-add-only" && args.iter().any(|a| a == "remove") {
        return 0;
    }
    if !mode.starts_with("approve") {
        return 126;
    }
    let mut command;
    if cfg!(unix) && !is_root() {
        command = Command::new("sudo");
        command.arg("-n").args(args);
    } else {
        command = Command::new(&args[0]);
        command.args(&args[1..]);
    }
    command.status().ok().and_then(|s| s.code()).unwrap_or(1)
}

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
}

fn value(args: &[String], flag: &str) -> String {
    let at = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} needed"));
    args[at + 1].clone()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var_os("PROBE_STAND_IN").is_some() && std::env::var_os(firewall::STAND_IN_ENV).is_some() {
        // Called as `<stand-in> <program> firewall-rule ...`.
        if args.first().is_some_and(|a| PathBuf::from(a).is_absolute()) {
            std::process::exit(stand_in(&args));
        }
    }
    if matches!(args.first().map(String::as_str), Some("firewall-rule" | "firewall-close")) {
        std::process::exit(firewall::command(&args));
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(serve(args));
}

async fn serve(args: Vec<String>) {
    let folder = PathBuf::from(value(&args, "--folder"));
    let listen = value(&args, "--listen").parse().unwrap();
    let acceptor = tls::acceptor(
        &PathBuf::from(value(&args, "--cert")),
        &PathBuf::from(value(&args, "--key")),
    )
    .unwrap();
    let (listening, switch) = Listening::bind(listen, false).await.unwrap();
    let port = listening.port();
    println!("ready {port}");
    let policy = Policy::new(&[&format!("https://localhost:{port}")], false).unwrap();
    let control = Control {
        switch,
        firewall: Firewall::new(&folder, std::env::current_exe().unwrap()),
        port,
    };
    let app = Router::new().route("/", get(|| async { "moss-probe" }));
    let server = tokio::spawn(tls::serve_switched(listening, acceptor, app, None));
    let mut sharing = false;
    // Read commands one at a time so replies stay in order.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = rx.recv().await {
        let reply = match line.trim() {
            "on" => {
                let result = control.apply(true, sharing, &policy, |_| Ok(())).await;
                sharing = result.is_ok() || sharing;
                format!("{result:?}")
            }
            "off" => {
                let result = control.apply(false, sharing, &policy, |_| Ok(())).await;
                sharing = false;
                format!("{result:?}")
            }
            "listener-on" => format!("{:?}", control.switch.set(true).await),
            "listener-off" => format!("{:?}", control.switch.set(false).await),
            other if other.starts_with("answer ") => {
                std::env::set_var("PROBE_STAND_IN", &other["answer ".len()..]);
                "Ok".into()
            }
            "quit" => break,
            other => format!("unknown {other}"),
        };
        println!("{reply}");
    }
    server.abort();
}
