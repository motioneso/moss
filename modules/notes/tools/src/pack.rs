//! Local unsigned archive builder. Registry signing belongs to the publisher.
use anyhow::{Context, Result};
use moss_module_host::{
    archive::{pack, Package},
    runtime::{Host, Limits},
    trust,
};
use std::{path::Path, sync::Arc};

fn main() -> Result<()> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    anyhow::ensure!(
        arguments.len() == 2,
        "Usage: notes-pack <component.wasm> <output.mosspkg>"
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let wasm = std::fs::read(&arguments[0]).context("Read the built Notes component")?;
    let host = Host::new(Limits::default())?;
    host.validate(&wasm, &Arc::new(moss_notes_checks::manifest()?))?;
    let files = moss_notes_checks::package_files(&root, wasm)?;
    let bytes = pack(&files)?;
    let digest = trust::digest(&bytes);
    Package::read(&bytes, &digest, &"0.1.0".parse()?)?;
    std::fs::write(&arguments[1], &bytes)?;
    println!(
        "Unsigned Notes archive: {} bytes, sha256 {digest}",
        bytes.len()
    );
    Ok(())
}
