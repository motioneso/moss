//! Usage: ui-bindgen <input.wasm> <out-dir> <out-name>
//! Writes <out-name>.js and <out-name>_bg.wasm for loading as a browser ES module.

use wasm_bindgen_cli_support::Bindgen;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: ui-bindgen <input.wasm> <out-dir> <out-name>".into());
    }
    Bindgen::new()
        .input_path(&args[1])
        .web(true)?
        .typescript(false)
        .out_name(&args[3])
        .generate(&args[2])?;
    Ok(())
}
