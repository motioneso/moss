//! Stable crate disambiguators for the locked first-party cross-platform builds.
//! Cargo's local dependency source IDs contain checkout paths even with remapped source spans.
use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
    time::{SystemTime, UNIX_EPOCH},
};

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
// their original manifest environment.
fn manifest_override(package: &str, version: &str, args: &[String]) -> Option<String> {
    let wasm = args
        .windows(2)
        .any(|pair| pair[0] == "--target" && pair[1].starts_with("wasm32-"));
    (package == "wasm_split_helpers" && wasm)
        .then(|| format!("/moss/cargo/{package}-{version}/Cargo.toml"))
}

// Prefix remapping leaves a Windows path's remaining separators untouched.
// Map complete source filenames so file!()/panic locations use the same spelling.
fn source_remaps(args: &[String], directories: &[PathBuf], cwd: &Path) -> io::Result<Vec<String>> {
    let roots: Vec<_> = args
        .iter()
        .filter_map(|arg| {
            let (from, to) = arg.strip_prefix("--remap-path-prefix=")?.rsplit_once('=')?;
            Some((PathBuf::from(from), to))
        })
        .collect();
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    fn files(directory: &Path, found: &mut Vec<PathBuf>) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_file() {
                found.push(entry.path());
            } else if kind.is_dir()
                && !matches!(entry.file_name().to_str(), Some("target" | ".git"))
            {
                files(&entry.path(), found)?;
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    for directory in directories {
        files(directory, &mut found)?;
    }
    found.sort();
    found.dedup();
    let mut maps = Vec::new();
    for file in found {
        // rustc applies the last matching prefix; preserve that precedence.
        if let Some((to, suffix)) = roots
            .iter()
            .rev()
            .find_map(|(from, to)| file.strip_prefix(from).ok().map(|suffix| (to, suffix)))
        {
            maps.push(format!(
                "--remap-path-prefix={}={}/{}",
                file.display(),
                to,
                suffix.to_string_lossy().replace('\\', "/")
            ));
        }
        if let Ok(relative) = file.strip_prefix(cwd) {
            maps.push(format!(
                "--remap-path-prefix={}={}",
                relative.display(),
                relative.to_string_lossy().replace('\\', "/")
            ));
        }
    }
    Ok(maps)
}

// Match rustc's one-level, one-literal-argument-per-line expansion. Cargo can
// already use an argument file before this wrapper adds its source mappings.
fn expand_args(args: Vec<String>) -> io::Result<Vec<String>> {
    let mut expanded = Vec::new();
    for arg in args {
        if let Some(path) = arg.strip_prefix('@') {
            expanded.extend(fs::read_to_string(path)?.lines().map(String::from));
        } else {
            expanded.push(arg);
        }
    }
    Ok(expanded)
}

// Exact mappings can exceed Windows' command-line limit. rustc response files
// accept one literal argument per line, including spaces and backslashes.
fn run_compiler(command: &mut Command, args: &[String]) -> io::Result<ExitStatus> {
    if args.iter().any(|arg| arg.contains(['\n', '\r'])) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "newline in rustc argument",
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let response = env::temp_dir().join(format!("moss-rustc-{}-{nonce}.args", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&response)?;
    let result = (|| {
        for arg in args {
            writeln!(file, "{arg}")?;
        }
        file.flush()?;
        command.arg(format!("@{}", response.display())).status()
    })();
    drop(file);
    fs::remove_file(response)?;
    result
}

fn main() {
    let mut args: Vec<_> = env::args().skip(1).collect();
    let compiler = args.remove(0);
    let mut args = expand_args(args).expect("expand Cargo rustc argument files");
    let package = env::var("CARGO_PKG_NAME").unwrap_or_default();
    let version = env::var("CARGO_PKG_VERSION").unwrap_or_default();
    normalize(&mut args, &package, &version);
    let directories: Vec<_> = ["CARGO_MANIFEST_DIR", "OUT_DIR"]
        .iter()
        .filter_map(env::var_os)
        .map(PathBuf::from)
        .collect();
    let maps = source_remaps(
        &args,
        &directories,
        &env::current_dir().expect("compiler cwd"),
    )
    .expect("enumerate source path remaps");
    args.extend(maps);
    let mut command = Command::new(compiler);
    if let Some(manifest) = manifest_override(&package, &version, &args) {
        command.env("CARGO_MANIFEST_PATH", manifest);
    }
    let status = run_compiler(&mut command, &args).expect("start rustc with source path remaps");
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
    fn full_file_remaps_normalize_suffixes_and_generated_paths() {
        let root = env::temp_dir().join(format!("moss-remap-test-{}", std::process::id()));
        let source = root.join("crate with spaces");
        let generated = root.join("target/out");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir_all(&generated).unwrap();
        fs::write(source.join("nested/lib.rs"), "").unwrap();
        fs::write(generated.join("generated.rs"), "").unwrap();
        let args = vec![
            format!("--remap-path-prefix={}=/moss/source", root.display()),
            format!(
                "--remap-path-prefix={}=/moss/target",
                root.join("target").display()
            ),
        ];
        let maps = source_remaps(&args, &[source.clone(), generated.clone()], &source).unwrap();
        assert!(maps.contains(&format!(
            "--remap-path-prefix={}=/moss/source/crate with spaces/nested/lib.rs",
            source.join("nested/lib.rs").display()
        )));
        assert!(maps.contains(&format!(
            "--remap-path-prefix={}=/moss/target/out/generated.rs",
            generated.join("generated.rs").display()
        )));
        assert!(maps.contains(&format!(
            "--remap-path-prefix={}=nested/lib.rs",
            Path::new("nested/lib.rs").display()
        )));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cargo_argument_files_preserve_literals_order_and_single_level_expansion() {
        let path = env::temp_dir().join(format!("moss-cargo-args-{}.txt", std::process::id()));
        fs::write(
            &path,
            "--cfg\nfeature=\"space value\"\n@not-a-recursive-include\n",
        )
        .unwrap();
        let expanded = expand_args(vec![
            "before".into(),
            format!("@{}", path.display()),
            "after".into(),
        ])
        .unwrap();
        assert_eq!(
            expanded,
            [
                "before",
                "--cfg",
                "feature=\"space value\"",
                "@not-a-recursive-include",
                "after"
            ]
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn response_arguments_cannot_inject_an_extra_line() {
        let error = run_compiler(
            &mut Command::new("moss-no-such-compiler"),
            &["--cfg\ninjected".into()],
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
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
