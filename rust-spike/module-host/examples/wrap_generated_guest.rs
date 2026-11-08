//! Build-time closure of a generated Rust guest; no native module driver or WASI service.
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    anyhow::ensure!(args.len() == 2, "Expected core.wasm output.wasm");
    let bytes = moss_module_host::guest_component::wrap_generated(&std::fs::read(&args[0])?)?;
    std::fs::write(&args[1], bytes)?;
    Ok(())
}
