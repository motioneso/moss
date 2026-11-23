//! Stable crate disambiguators for the locked first-party cross-platform builds.
//! Cargo's local dependency source IDs contain checkout paths even with remapped source spans.
use std::{env, process::Command};

fn normalize(args: &mut [String], package: &str, version: &str) {
    let mut identity = vec![package.to_owned(), version.to_owned()];
    for pair in args.windows(2) {
        if matches!(
            pair[0].as_str(),
            "--crate-name" | "--crate-type" | "--target" | "--cfg"
        ) {
            identity.push(format!("{}={}", pair[0], pair[1]));
        }
    }
    identity.sort();
    // Explicit FNV-1a rather than a platform-dependent or randomly seeded hasher.
    let mut hash = 0xcbf29ce484222325u64;
    for value in identity {
        for byte in value.bytes().chain(std::iter::once(0)) {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
    }
    for i in 0..args.len() {
        if i > 0 && args[i - 1] == "-C" && args[i].starts_with("metadata=") {
            args[i] = format!("metadata=moss{hash:016x}");
        } else if args[i].starts_with("-Cmetadata=") {
            args[i] = format!("-Cmetadata=moss{hash:016x}");
        }
    }
}

// wasm_split_helpers 0.2.3 exports a version marker whose proc macro hashes
// CARGO_MANIFEST_PATH rather than a remappable source span. Give only this
// locked Wasm dependency a stable virtual manifest identity; other crates keep
// their real manifest paths for macros that read files relative to them.
fn manifest_override(package: &str, version: &str, args: &[String]) -> Option<String> {
    let wasm = args
        .windows(2)
        .any(|pair| pair[0] == "--target" && pair[1].starts_with("wasm32-"));
    (package == "wasm_split_helpers" && wasm)
        .then(|| format!("/moss/cargo/{package}-{version}/Cargo.toml"))
}

fn main() {
    let mut args: Vec<_> = env::args().skip(1).collect();
    let compiler = args.remove(0);
    let package = env::var("CARGO_PKG_NAME").unwrap_or_default();
    let version = env::var("CARGO_PKG_VERSION").unwrap_or_default();
    normalize(&mut args, &package, &version);
    let mut command = Command::new(compiler);
    if let Some(manifest) = manifest_override(&package, &version, &args) {
        command.env("CARGO_MANIFEST_PATH", manifest);
    }
    let status = command.args(args).status().expect("start rustc");
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation(metadata: &str, feature: &str) -> Vec<String> {
        [
            "--crate-name",
            "sdk",
            "--crate-type",
            "rlib",
            "--target",
            "wasm32-unknown-unknown",
            "--cfg",
            feature,
            "-C",
            metadata,
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    #[test]
    fn cargo_path_metadata_cannot_change_the_crate_identity() {
        let mut linux = invocation("metadata=linux-checkout", "feature=\"component\"");
        let mut macos = invocation("metadata=macos-checkout", "feature=\"component\"");
        normalize(&mut linux, "sdk", "0.1.0");
        normalize(&mut macos, "sdk", "0.1.0");
        assert_eq!(linux, macos);
    }

    #[test]
    fn preserves_other_arguments_and_accepts_joined_codegen_options() {
        let mut args = vec![
            "--cfg".into(),
            "metadata=keep".into(),
            "-Cmetadata=old".into(),
        ];
        normalize(&mut args, "sdk", "0.1.0");
        assert_eq!(args[0], "--cfg");
        assert_eq!(args[1], "metadata=keep");
        assert!(args[2].starts_with("-Cmetadata=moss"));
        assert_ne!(args[2], "-Cmetadata=old");
    }

    #[test]
    fn split_marker_manifest_identity_is_stable_and_scoped() {
        let wasm = invocation("metadata=cargo", "feature=\"component\"");
        assert_eq!(
            manifest_override("wasm_split_helpers", "0.2.3", &wasm).as_deref(),
            Some("/moss/cargo/wasm_split_helpers-0.2.3/Cargo.toml")
        );
        assert_ne!(
            manifest_override("wasm_split_helpers", "0.2.3", &wasm),
            manifest_override("wasm_split_helpers", "0.2.4", &wasm)
        );
        assert_eq!(manifest_override("other", "0.2.3", &wasm), None);
        let mut native = wasm.clone();
        native[5] = "x86_64-unknown-linux-gnu".into();
        assert_eq!(
            manifest_override("wasm_split_helpers", "0.2.3", &native),
            None
        );
    }

    #[test]
    fn versions_features_and_targets_remain_distinct() {
        let original = invocation("metadata=original", "feature=\"component\"");
        let mut baseline = original.clone();
        normalize(&mut baseline, "sdk", "0.1.0");
        let mut version = original.clone();
        normalize(&mut version, "sdk", "0.2.0");
        assert_ne!(baseline.last(), version.last());
        let mut feature = invocation("metadata=original", "feature=\"other\"");
        normalize(&mut feature, "sdk", "0.1.0");
        assert_ne!(baseline.last(), feature.last());
        let mut target = original;
        target[5] = "wasm32-wasip2".into();
        normalize(&mut target, "sdk", "0.1.0");
        assert_ne!(baseline.last(), target.last());
    }
}
