//! Build tool only; no native People implementation is linked into its output.
fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let input = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("Expected core.wasm output.wasm"))?;
    let output = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("Expected core.wasm output.wasm"))?;
    anyhow::ensure!(args.next().is_none(), "Expected exactly two paths");
    let bytes = moss_module_host::guest_component::wrap(&std::fs::read(input)?)?;
    std::fs::write(output, bytes)?;
    Ok(())
}
