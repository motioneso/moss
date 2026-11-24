use anyhow::{bail, Result};
use moss_module_publisher::{read_bounded, Configuration, Prepared, Submission};
use std::path::Path;

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let valid = match args.first().map(String::as_str) {
        Some("review") => args.len() == 3,
        Some("publish") => matches!(args.len(), 4 | 5),
        _ => false,
    };
    if !valid {
        bail!("Usage: moss-module-publisher review CONFIG SUBMISSION | publish CONFIG SUBMISSION INDEX_PKCS8 [APPROVAL]");
    }
    let config: Configuration =
        serde_json::from_slice(&read_bounded(Path::new(&args[1]), 1024 * 1024)?)?;
    let submission: Submission =
        serde_json::from_slice(&read_bounded(Path::new(&args[2]), 1024 * 1024)?)?;
    let prepared = Prepared::open(&config, &submission)?;
    // Compute the entire response before writing any publication bytes.
    let response = if args[0] == "review" {
        serde_json::to_string(prepared.request())?
    } else {
        let approval = args
            .get(4)
            .map(|path| -> Result<_> {
                Ok(serde_json::from_slice(&read_bounded(
                    Path::new(path),
                    1024 * 1024,
                )?)?)
            })
            .transpose()?;
        let key = read_bounded(Path::new(&args[3]), 4096)?;
        serde_json::to_string(&prepared.publish(approval, &key)?)?
    };
    println!("{response}");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
