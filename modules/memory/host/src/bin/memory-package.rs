//! Build the unsigned archive; registry publishing supplies the real publisher signature.
fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let core = args.next().ok_or_else(|| {
        anyhow::anyhow!("Usage: memory-package <compiled-core.wasm> <output.mosspkg>")
    })?;
    let output = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("Output path required"))?;
    anyhow::ensure!(args.next().is_none(), "Unexpected arguments");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_memory_host::package::pack(&root, &std::fs::read(core)?)?;
    std::fs::write(output, &bytes)?;
    println!(
        "Memory archive: {} bytes, sha256 {}",
        bytes.len(),
        moss_module_host::trust::digest(&bytes)
    );
    Ok(())
}
