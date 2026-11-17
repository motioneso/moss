//! Packs the built component and the legacy SQL into a .mosspkg file.
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "Usage: scratchpad-package <module.wasm> <out.mosspkg>");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_scratchpad_host::package::pack(&root, &std::fs::read(&args[1])?)?;
    std::fs::write(&args[2], bytes)?;
    Ok(())
}
