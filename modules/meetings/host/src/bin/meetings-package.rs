//! Packs the built component and the legacy SQL into a .mosspkg file. With --stand-in <id> it packs
//! an empty module of that id instead, for tests of modules that require it.
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 5 && args[1] == "--stand-in" {
        let (bytes, _) = moss_meetings_host::package::stand_in(&args[2], &std::fs::read(&args[3])?)?;
        std::fs::write(&args[4], bytes)?;
        return Ok(());
    }
    anyhow::ensure!(args.len() == 3, "Usage: meetings-package [--stand-in <id>] <module.wasm> <out.mosspkg>");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_meetings_host::package::pack_without_dependencies(&root, &std::fs::read(&args[1])?)?;
    std::fs::write(&args[2], bytes)?;
    Ok(())
}
