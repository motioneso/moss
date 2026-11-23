use anyhow::{bail, Result};
use moss_module_publisher::artifacts;
use std::path::Path;
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
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
        _ => bail!("Usage: moss pack DIRECTORY OUTPUT | inspect PACKAGE"),
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
