#[allow(dead_code)]
mod support;
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use support::Fixture;

fn run(args: &[&Path]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_moss"))
        .args(args)
        .output()
        .unwrap()
}
fn ok(args: &[&Path]) -> Value {
    let out = run(args);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn pack_is_deterministic_and_inspect_preserves_manifest() {
    let f = Fixture::new();
    let input = f.dir.path().join("input");
    for (name, bytes) in f.files.borrow().iter().rev() {
        let path = input.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let a = f.dir.path().join("a.mosspkg");
    let b = f.dir.path().join("b.mosspkg");
    ok(&[Path::new("pack"), &input, &a]);
    // Input timestamps and permissions do not contribute to archive bytes.
    let license = input.join("LICENSE");
    fs::File::options()
        .write(true)
        .open(&license)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(3600)),
        )
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&license, fs::Permissions::from_mode(0o755)).unwrap();
    }
    ok(&[Path::new("pack"), &input, &b]);
    assert_eq!(fs::read(&a).unwrap(), fs::read(&b).unwrap());
    assert_eq!(
        fs::read(&a).unwrap(),
        fs::read(f.dir.path().join("candidate.mosspkg")).unwrap()
    );
    let inspected = ok(&[Path::new("inspect"), &a]);
    let expected: Value = serde_json::from_slice(&f.files.borrow()["moss.module.json"]).unwrap();
    assert_eq!(inspected["manifest"], expected);
}

fn refused(args: &[&Path], reason: &str) {
    let out = run(args);
    assert!(!out.status.success(), "Expected refusal: {reason}");
    assert!(out.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains(reason),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn verify_authenticates_package_and_refuses_tampering() {
    let f = Fixture::new();
    let config = f.dir.path().join("config.json");
    let submission = f.dir.path().join("submission.json");
    ok(&[Path::new("verify"), &config, &submission]);
    f.files
        .borrow_mut()
        .insert("NOTICE".into(), b"Altered notice".to_vec());
    // Valid archive with the original detached signature: only signature checking catches this.
    fs::write(
        f.dir.path().join("candidate.mosspkg"),
        moss_module_host::archive::pack(&f.files.borrow()).unwrap(),
    )
    .unwrap();
    refused(
        &[Path::new("verify"), &config, &submission],
        "signature does not match",
    );
}
#[test]
fn verify_refuses_undeclared_imports() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["capabilities"] = serde_json::json!([]));
    refused(
        &[
            Path::new("verify"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("submission.json"),
        ],
        "import",
    );
}

#[test]
fn registry_assembly_and_mirror_preserve_signed_bytes() {
    let f = Fixture::new();
    f.artifact_layout();
    let config = f.dir.path().join("config.json");
    let assembled = f.dir.path().join("assembled");
    ok(&[
        Path::new("registry"),
        Path::new("assemble"),
        &config,
        &f.dir.path().join("selection.json"),
        &f.dir.path().join("index.pk8"),
        &assembled,
    ]);
    let bundle: Value =
        serde_json::from_slice(&fs::read(assembled.join("bundle.json")).unwrap()).unwrap();
    assert_eq!(bundle["default"][0]["id"], "sample.counter");
    assert_eq!(bundle["default"][0]["version"], "1.0.0");
    assert_eq!(bundle["optional"], serde_json::json!([]));
    assert_eq!(bundle["serial"], 1);
    assert_eq!(
        bundle["indexDigest"],
        moss_module_host::trust::digest(&fs::read(assembled.join("index.json")).unwrap())
    );
    let identity: Value =
        serde_json::from_slice(&fs::read(assembled.join("registry.json")).unwrap()).unwrap();
    moss_module_host::trust::verify(
        identity["indexKeys"]["online"].as_str().unwrap(),
        &fs::read(assembled.join("bundle.json")).unwrap(),
        &fs::read_to_string(assembled.join("bundle.json.sig")).unwrap(),
    )
    .unwrap();
    f.edit_config(|c| c["registryPath"] = serde_json::json!(assembled));
    let mirrored = f.dir.path().join("mirrored");
    ok(&[
        Path::new("registry"),
        Path::new("mirror"),
        &config,
        &mirrored,
    ]);
    fn compare(a: &Path, b: &Path) {
        for e in fs::read_dir(a).unwrap() {
            let path = e.unwrap().path();
            let other = b.join(path.file_name().unwrap());
            if path.is_dir() {
                compare(&path, &other);
            } else {
                assert_eq!(
                    fs::read(&path).unwrap(),
                    fs::read(&other).unwrap(),
                    "{}",
                    path.display()
                );
            }
        }
    }
    compare(&assembled, &mirrored);
    ok(&[Path::new("registry"), Path::new("verify"), &config]);
    // Never overwrite a previously written registry, even if only its blob was corrupted.
    let marker = mirrored.join("index.json");
    fs::write(&marker, b"existing snapshot").unwrap();
    refused(
        &[
            Path::new("registry"),
            Path::new("mirror"),
            &config,
            &mirrored,
        ],
        "Could not create output folder",
    );
    assert_eq!(fs::read(marker).unwrap(), b"existing snapshot");
}

#[test]
fn mirror_refuses_tampered_archive_without_creating_output() {
    let f = Fixture::new();
    f.artifact_layout();
    f.corrupt_prior();
    let output = f.dir.path().join("mirror");
    refused(
        &[
            Path::new("registry"),
            Path::new("mirror"),
            &f.dir.path().join("config.json"),
            &output,
        ],
        "hash does not match",
    );
    assert!(!output.exists());
}
#[test]
fn registry_refuses_tampered_index_signature() {
    let f = Fixture::new();
    f.artifact_layout();
    let path = f.dir.path().join("registry/index.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' '); // Still valid JSON, but no longer the bytes signed by the index key.
    fs::write(path, bytes).unwrap();
    refused(
        &[
            Path::new("registry"),
            Path::new("verify"),
            &f.dir.path().join("config.json"),
        ],
        "signature does not match",
    );
}
#[test]
fn registry_refuses_tampered_identity_signature() {
    let f = Fixture::new();
    f.artifact_layout();
    let path = f.dir.path().join("registry/registry.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' ');
    fs::write(path, bytes).unwrap();
    refused(
        &[
            Path::new("registry"),
            Path::new("verify"),
            &f.dir.path().join("config.json"),
        ],
        "signature does not match",
    );
}
#[test]
fn mirror_refuses_cross_registry_publisher_conflicts() {
    let f = Fixture::new();
    let other = Fixture::new(); // Independently generated publisher, same module id.
    f.artifact_layout();
    other.artifact_layout();
    let output = f.dir.path().join("mirror");
    refused(
        &[
            Path::new("registry"),
            Path::new("mirror"),
            &f.dir.path().join("config.json"),
            &output,
            &other.dir.path().join("config.json"),
        ],
        "Registries disagree",
    );
    assert!(!output.exists());
}
#[test]
fn registry_refuses_tampered_detached_package_signature() {
    let f = Fixture::new();
    f.artifact_layout();
    let index: Value =
        serde_json::from_slice(&fs::read(f.dir.path().join("registry/index.json")).unwrap())
            .unwrap();
    let path = f.dir.path().join(format!(
        "registry/packages/{}.mosspkg.sig",
        index["modules"][0]["digest"].as_str().unwrap()
    ));
    fs::write(path, support::sign(&support::key(), b"forged")).unwrap();
    refused(
        &[
            Path::new("registry"),
            Path::new("verify"),
            &f.dir.path().join("config.json"),
        ],
        "signature does not match",
    );
}
#[test]
fn bundle_tampering_is_refused() {
    let f = Fixture::new();
    f.artifact_layout();
    let output = f.dir.path().join("assembled");
    ok(&[
        Path::new("registry"),
        Path::new("assemble"),
        &f.dir.path().join("config.json"),
        &f.dir.path().join("selection.json"),
        &f.dir.path().join("index.pk8"),
        &output,
    ]);
    f.edit_config(|c| c["registryPath"] = serde_json::json!(output));
    let path = output.join("bundle.json");
    let mut bundle: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // Move a default module into optional; entries remain internally consistent.
    bundle["optional"] = bundle["default"].clone();
    bundle["default"] = serde_json::json!([]);
    fs::write(path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    refused(
        &[
            Path::new("registry"),
            Path::new("verify"),
            &f.dir.path().join("config.json"),
        ],
        "signature does not match",
    );
}
#[test]
fn expiry_stops_assembly_but_mirror_preserves_snapshot() {
    let f = Fixture::new();
    f.artifact_layout();
    f.edit_index(|i| i["expires"] = serde_json::json!("2000-01-01T00:00:00Z"));
    let config = f.dir.path().join("config.json");
    refused(
        &[Path::new("registry"), Path::new("verify"), &config],
        "expired",
    );
    refused(
        &[
            Path::new("registry"),
            Path::new("assemble"),
            &config,
            &f.dir.path().join("selection.json"),
            &f.dir.path().join("index.pk8"),
            &f.dir.path().join("assembled"),
        ],
        "expired",
    );
    ok(&[
        Path::new("registry"),
        Path::new("mirror"),
        &config,
        &f.dir.path().join("mirror"),
    ]);
}
#[test]
fn selection_rejects_missing_duplicate_and_wrong_registry() {
    let f = Fixture::new();
    f.artifact_layout();
    for selection in [
        serde_json::json!({"default":{"modules":[{"id":"sample.missing","registry":"moss"}]},"optional":{"modules":[]}}),
        serde_json::json!({"default":{"modules":[{"id":"sample.counter","registry":"elsewhere"}]},"optional":{"modules":[]}}),
        serde_json::json!({"default":{"modules":[{"id":"sample.counter","registry":"moss"}]},"optional":{"modules":[{"id":"sample.counter","registry":"moss"}]}}),
    ] {
        fs::write(
            f.dir.path().join("selection.json"),
            serde_json::to_vec(&selection).unwrap(),
        )
        .unwrap();
        let out = run(&[
            Path::new("registry"),
            Path::new("assemble"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("selection.json"),
            &f.dir.path().join("index.pk8"),
            &f.dir.path().join("assembled"),
        ]);
        assert!(!out.status.success());
        assert!(!f.dir.path().join("assembled").exists());
    }
}
#[cfg(unix)]
#[test]
fn pack_refuses_links() {
    let f = Fixture::new();
    let input = f.dir.path().join("input");
    fs::create_dir(&input).unwrap();
    std::os::unix::fs::symlink(
        f.dir.path().join("candidate.mosspkg"),
        input.join("external"),
    )
    .unwrap();
    refused(
        &[Path::new("pack"), &input, &f.dir.path().join("out.mosspkg")],
        "links are refused",
    );
}

#[test]
fn verify_refuses_unsafe_sql_and_wrong_publisher_name() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["database"] = serde_json::json!({"migrations":["sql/001_create.sql"]}));
    f.files.borrow_mut().insert(
        "sql/001_create.sql".into(),
        b"DROP TABLE app.other;".to_vec(),
    );
    f.write_package();
    refused(
        &[
            Path::new("verify"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("submission.json"),
        ],
        "not part of the module package subset",
    );
    f.edit_manifest(|m| m["id"] = serde_json::json!("other.counter"));
    refused(
        &[
            Path::new("verify"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("submission.json"),
        ],
        "cannot sign this module name",
    );
}

#[test]
fn assembly_refuses_wrong_signing_key() {
    let f = Fixture::new();
    let other = Fixture::new();
    f.artifact_layout();
    refused(
        &[
            Path::new("registry"),
            Path::new("assemble"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("selection.json"),
            &other.dir.path().join("index.pk8"),
            &f.dir.path().join("assembled"),
        ],
        "Wrong index signing key",
    );
    assert!(!f.dir.path().join("assembled").exists());
}

#[test]
fn bundle_keeps_finance_and_meals_optional_and_copies_media() {
    let f = Fixture::new();
    f.first_party_bundle();
    let media = b"<svg>Fixture media</svg>";
    let name = format!("media/{}.svg", moss_module_host::trust::digest(media));
    fs::create_dir(f.dir.path().join("registry/media")).unwrap();
    fs::write(f.dir.path().join("registry").join(&name), media).unwrap();
    let output = f.dir.path().join("bundle");
    ok(&[
        Path::new("registry"),
        Path::new("assemble"),
        &f.dir.path().join("config.json"),
        &f.dir.path().join("selection.json"),
        &f.dir.path().join("index.pk8"),
        &output,
    ]);
    let bundle: Value =
        serde_json::from_slice(&fs::read(output.join("bundle.json")).unwrap()).unwrap();
    assert_eq!(
        bundle["default"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["tasks"]
    );
    assert_eq!(
        bundle["optional"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["finance", "meals"]
    );
    assert_eq!(fs::read(output.join(name)).unwrap(), media);
    for entry in bundle["default"]
        .as_array()
        .unwrap()
        .iter()
        .chain(bundle["optional"].as_array().unwrap())
    {
        assert!(output
            .join(format!(
                "packages/{}.mosspkg",
                entry["digest"].as_str().unwrap()
            ))
            .exists());
    }
}

fn assembly_refuses_blocked(publisher: bool) {
    let f = Fixture::new();
    f.artifact_layout();
    f.edit_index(|i| {
        let target = if publisher {
            "sample".to_owned()
        } else {
            i["modules"][0]["digest"].as_str().unwrap().to_owned()
        };
        i["revoked"] =
            serde_json::json!([{"target":target,"reason":"Fixture block","level":"block"}]);
    });
    let output = f.dir.path().join("assembled");
    refused(
        &[
            Path::new("registry"),
            Path::new("assemble"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("selection.json"),
            &f.dir.path().join("index.pk8"),
            &output,
        ],
        "Selected module is blocked",
    );
    assert!(!output.exists());
}
#[test]
fn assembly_refuses_blocked_digest() {
    assembly_refuses_blocked(false);
}
#[test]
fn assembly_refuses_blocked_publisher() {
    assembly_refuses_blocked(true);
}
#[test]
fn verify_refuses_blocked_candidate() {
    let f = Fixture::new();
    f.edit_index(|i| {
        i["revoked"] =
            serde_json::json!([{"target":f.digest(),"reason":"Fixture block","level":"block"}])
    });
    refused(
        &[
            Path::new("verify"),
            &f.dir.path().join("config.json"),
            &f.dir.path().join("submission.json"),
        ],
        "Package or publisher is blocked",
    );
}
#[test]
fn mirror_refuses_corrupt_media() {
    let f = Fixture::new();
    f.artifact_layout();
    fs::create_dir(f.dir.path().join("registry/media")).unwrap();
    let name = format!(
        "registry/media/{}.svg",
        moss_module_host::trust::digest(b"original")
    );
    fs::write(f.dir.path().join(name), b"corrupt").unwrap();
    let output = f.dir.path().join("mirror");
    refused(
        &[
            Path::new("registry"),
            Path::new("mirror"),
            &f.dir.path().join("config.json"),
            &output,
        ],
        "Media digest does not match",
    );
    assert!(!output.exists());
}
#[test]
fn assembly_refuses_to_replace_a_signed_bundle() {
    let f = Fixture::new();
    f.artifact_layout();
    let output = f.dir.path().join("assembled");
    let config = f.dir.path().join("config.json");
    ok(&[
        Path::new("registry"),
        Path::new("assemble"),
        &config,
        &f.dir.path().join("selection.json"),
        &f.dir.path().join("index.pk8"),
        &output,
    ]);
    f.edit_config(|c| c["registryPath"] = serde_json::json!(output));
    refused(
        &[
            Path::new("registry"),
            Path::new("assemble"),
            &config,
            &f.dir.path().join("selection.json"),
            &f.dir.path().join("index.pk8"),
            &f.dir.path().join("replacement"),
        ],
        "already contains a signed bundle",
    );
}
