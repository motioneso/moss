//! moss-confine --read <dir>... --write <dir>... -- <program> [args...]
//!
//! Confines itself with Landlock, then replaces itself with <program>. The rules pass to every
//! process the program starts. Fails closed: if the kernel refuses, the agent never starts.

fn main() {
    let mut read = Vec::new();
    let mut write = Vec::new();
    let mut args = std::env::args().skip(1);
    let mut rest: Vec<String> = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--read" => read.push(args.next().unwrap_or_else(|| die("--read needs a folder"))),
            "--write" => write.push(args.next().unwrap_or_else(|| die("--write needs a folder"))),
            "--" => {
                rest = args.collect();
                break;
            }
            other => die(&format!("unknown option {other}")),
        }
    }
    if rest.is_empty() {
        die("no program to run");
    }
    run(&read, &write, &rest);
}

#[cfg(target_os = "linux")]
fn run(read: &[String], write: &[String], rest: &[String]) {
    use std::os::unix::process::CommandExt;
    use std::path::Path;

    let read: Vec<&Path> = read.iter().map(Path::new).collect();
    let write: Vec<&Path> = write.iter().map(Path::new).collect();
    if let Err(e) = moss_agents::confine::linux::restrict_self(&read, &write) {
        die(&format!("could not confine the agent: {e}"));
    }
    let err = std::process::Command::new(&rest[0]).args(&rest[1..]).exec();
    die(&format!("could not start {}: {err}", rest[0]));
}

#[cfg(not(target_os = "linux"))]
fn run(_: &[String], _: &[String], _: &[String]) {
    die("confinement is not built for this system yet");
}

fn die(msg: &str) -> ! {
    eprintln!("moss-confine: {msg}");
    std::process::exit(126);
}
