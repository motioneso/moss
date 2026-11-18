//! Wrap the generated canonical ABI metadata without adding WASI adapters.
use anyhow::Result;
fn main() -> Result<()> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    anyhow::ensure!(
        arguments.len() == 2,
        "Usage: scratchpad-component <core.wasm> <component.wasm>"
    );
    let core = std::fs::read(&arguments[0])?;
    let component = wit_component::ComponentEncoder::default()
        .module(&core)?
        .validate(true)
        .encode()?;
    std::fs::write(&arguments[1], component)?;
    Ok(())
}
