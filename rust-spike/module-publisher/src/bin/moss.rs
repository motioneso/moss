use anyhow::{bail, Result};
use moss_module_publisher::{artifacts, registry_artifacts};
use std::path::Path;
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("release") {
        if args.len() < 3 {
            bail!("Usage: moss release PACKAGES OUTPUT [PREVIOUS_FOLDER] [--dry-run]");
        }
        let dry_run = args.last().map(String::as_str) == Some("--dry-run");
        let count = args.len() - usize::from(dry_run);
        if !(3..=4).contains(&count) {
            bail!("Usage: moss release PACKAGES OUTPUT [PREVIOUS_FOLDER] [--dry-run]");
        }
        let previous = if count == 4 {
            Some(Path::new(&args[3]))
        } else {
            None
        };
        let result = moss_module_publisher::release::build(
            Path::new(&args[1]),
            Path::new(&args[2]),
            previous,
            dry_run,
        )?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    if args.first().map(String::as_str) == Some("registry") {
        let result = match args.get(1).map(String::as_str) {
            Some("assemble") if args.len() == 6 => registry_artifacts::assemble(Path::new(&args[2]), Path::new(&args[3]), Path::new(&args[4]), Path::new(&args[5]))?,
            Some("mirror") if args.len() >= 4 => registry_artifacts::mirror(Path::new(&args[2]), Path::new(&args[3]), &args[4..])?,
            Some("verify") if args.len() >= 3 => registry_artifacts::verify(Path::new(&args[2]), &args[3..])?,
            _ => bail!("Usage: moss registry assemble CONFIG SELECTION INDEX_PKCS8 OUTPUT | mirror CONFIG OUTPUT [OTHER_CONFIG...] | verify CONFIG [OTHER_CONFIG...]"),
        };
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["pack", input, output] => artifacts::pack(Path::new(input), Path::new(output))?,
        ["verify", config, submission] => {
            artifacts::verify(Path::new(config), Path::new(submission))?
        }
        ["inspect", input] => artifacts::inspect(Path::new(input))?,
        _ => bail!("Usage: moss pack DIRECTORY OUTPUT | inspect PACKAGE | verify CONFIG SUBMISSION | registry ..."),
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
