use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=MOSS_COMPILED_BUNDLE");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("compiled_bundle.rs");
    let source = if let Some(path) = env::var_os("MOSS_COMPILED_BUNDLE") {
        let path = fs::canonicalize(path)
            .expect("MOSS_COMPILED_BUNDLE must name the release-generated Rust source");
        println!("cargo:rerun-if-changed={}", path.display());
        format!(
            "include!({:?});",
            path.to_str().expect("Bundle path must be UTF-8")
        )
    } else {
        "pub fn release() -> moss_module_host::bundle::Bundle<'static> { moss_module_host::bundle::Bundle { registry: \"moss\", first_party_key: \"\", packages: &[] } }".into()
    };
    fs::write(output, source).unwrap();
}
