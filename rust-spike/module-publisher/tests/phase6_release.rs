mod support;
use serde_json::Value;
use std::{fs, process::Command};
use support::Fixture;

#[test]
fn release_builds_signed_bundle_with_compiled_digests_and_optional_finance_meals() {
    let f = Fixture::new();
    f.first_party_bundle();
    let input = input_packages(&f);
    let output = f.dir.path().join("release");
    let result = Command::new(env!("CARGO_BIN_EXE_moss"))
        .args([
            "release",
            input.to_str().unwrap(),
            output.to_str().unwrap(),
            "--dry-run",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let bundle: Value =
        serde_json::from_slice(&fs::read(output.join("registry/bundle.json")).unwrap()).unwrap();
    assert_eq!(bundle["default"][0]["id"], "tasks");
    assert_eq!(bundle["optional"].as_array().unwrap().len(), 2);
    let source = fs::read_to_string(output.join("compiled_bundle.rs")).unwrap();
    for a in bundle["default"]
        .as_array()
        .unwrap()
        .iter()
        .chain(bundle["optional"].as_array().unwrap())
    {
        assert!(source.contains(a["digest"].as_str().unwrap()));
        assert!(source.contains(a["signature"].as_str().unwrap()));
    }
}

#[test]
fn production_release_refuses_missing_named_secrets() {
    let scratch = tempfile::tempdir().unwrap();
    for missing in [
        "MOSS_RUST_REGISTRY_SIGNING_KEY_ID",
        "MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY",
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_moss"));
        command
            .args([
                "release",
                scratch.path().to_str().unwrap(),
                scratch.path().join("output").to_str().unwrap(),
            ])
            .env_remove("MOSS_RUST_REGISTRY_SIGNING_KEY_ID")
            .env_remove("MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY");
        if missing == "MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY" {
            command.env("MOSS_RUST_REGISTRY_SIGNING_KEY_ID", "generated-test");
        }
        let result = command.output().unwrap();
        assert!(
            !result.status.success(),
            "Expected refusal: missing signing secret"
        );
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(missing),
            "Expected refusal: missing {missing}"
        );
        assert!(!scratch.path().join("output").exists());
    }
}

fn input_packages(f: &Fixture) -> std::path::PathBuf {
    let input = f.dir.path().join("input");
    fs::create_dir(&input).unwrap();
    let index: Value =
        serde_json::from_slice(&fs::read(f.dir.path().join("registry/index.json")).unwrap())
            .unwrap();
    for a in index["modules"].as_array().unwrap() {
        let bytes = fs::read(f.dir.path().join(format!(
            "registry/packages/{}.mosspkg",
            a["digest"].as_str().unwrap()
        )))
        .unwrap();
        let package = moss_module_host::archive::Package::read_for_review(
            &bytes,
            a["digest"].as_str().unwrap(),
        )
        .unwrap();
        let mut files = package.files.clone();
        let mut manifest: Value = serde_json::from_slice(&files["moss.module.json"]).unwrap();
        manifest["lifecycle"] = serde_json::json!({"required":a["id"]=="tasks", "bundled":true, "removable":a["id"]!="tasks"});
        files.insert(
            "moss.module.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        fs::write(
            input.join(format!("{}.mosspkg", a["id"].as_str().unwrap())),
            moss_module_host::archive::pack(&files).unwrap(),
        )
        .unwrap();
    }
    input
}

fn copy_tree(source: &std::path::Path, destination: &std::path::Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let path = entry.unwrap().path();
        let dest = destination.join(path.file_name().unwrap());
        if path.is_dir() {
            copy_tree(&path, &dest)
        } else {
            fs::copy(&path, dest).unwrap();
        }
    }
}

#[test]
fn production_release_requires_the_exact_human_review_report() {
    use base64::Engine;
    let f = Fixture::new();
    f.first_party_bundle();
    let input = input_packages(&f);
    let output = f.dir.path().join("production");
    let key =
        ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(key.as_ref());
    let run = |approval: Option<&str>| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moss"));
        cmd.args(["release", input.to_str().unwrap(), output.to_str().unwrap()])
            .env("MOSS_RUST_REGISTRY_SIGNING_KEY_ID", "generated-test")
            .env("MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY", &encoded)
            .env_remove("MOSS_RUST_REGISTRY_APPROVED_REPORT");
        if let Some(approval) = approval {
            cmd.env("MOSS_RUST_REGISTRY_APPROVED_REPORT", approval);
        }
        cmd.output().unwrap()
    };
    let preview = run(None);
    assert!(
        !preview.status.success(),
        "Expected refusal: human approval is missing"
    );
    assert!(!output.exists());
    let message = String::from_utf8(preview.stderr).unwrap();
    let digest = message.rsplit("report digest: ").next().unwrap().trim();
    assert!(moss_module_host::trust::valid_digest(digest), "{message}");
    let wrong = run(Some(&"0".repeat(64)));
    assert!(
        !wrong.status.success(),
        "Expected refusal: human approval does not match bytes and diff"
    );
    let accepted = run(Some(digest));
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    if let Some(destination) = std::env::var_os("MOSS_RELEASE_FIXTURE_OUTPUT") {
        // Executable proof starts with an authentically signed, expired index.
        expire_registry(&output.join("registry"), key.as_ref());
        copy_tree(&output, std::path::Path::new(&destination));
    }
}

#[test]
fn release_retains_previous_history_renews_expiry_and_refuses_dropped_modules() {
    use base64::Engine;
    let f = Fixture::new();
    f.first_party_bundle();
    let input = input_packages(&f);
    let first = f.dir.path().join("first");
    let key =
        ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(key.as_ref());
    let run =
        |output: &std::path::Path, previous: Option<&std::path::Path>, approval: Option<&str>| {
            let mut command = Command::new(env!("CARGO_BIN_EXE_moss"));
            command
                .args(["release", input.to_str().unwrap(), output.to_str().unwrap()])
                .env("MOSS_RUST_REGISTRY_SIGNING_KEY_ID", "generated-test")
                .env("MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY", &encoded)
                .env_remove("MOSS_RUST_REGISTRY_APPROVED_REPORT");
            if let Some(previous) = previous {
                command.arg(previous);
            }
            if let Some(approval) = approval {
                command.env("MOSS_RUST_REGISTRY_APPROVED_REPORT", approval);
            }
            command.output().unwrap()
        };
    let preview = run(&first, None, None);
    let report = String::from_utf8(preview.stderr).unwrap();
    let digest = report.rsplit("report digest: ").next().unwrap().trim();
    let initial = run(&first, None, Some(digest));
    assert!(
        initial.status.success(),
        "{}",
        String::from_utf8_lossy(&initial.stderr)
    );
    expire_registry(&first.join("registry"), key.as_ref());
    let old: Value =
        serde_json::from_slice(&fs::read(first.join("registry/index.json")).unwrap()).unwrap();
    let second = f.dir.path().join("second");
    let result = run(&second, Some(&first.join("registry")), None);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let new: Value =
        serde_json::from_slice(&fs::read(second.join("registry/index.json")).unwrap()).unwrap();
    assert_eq!(
        new["modules"], old["modules"],
        "Prior immutable history must survive renewal"
    );
    assert!(new["serial"].as_u64().unwrap() > old["serial"].as_u64().unwrap());
    assert!(
        new["expires"]
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<chrono::Utc>>()
            .unwrap()
            > chrono::Utc::now()
    );
    fs::remove_file(input.join("finance.mosspkg")).unwrap();
    let dropped = run(
        &f.dir.path().join("dropped"),
        Some(&second.join("registry")),
        None,
    );
    assert!(
        !dropped.status.success(),
        "Expected refusal: missing previously published module"
    );
    assert!(String::from_utf8_lossy(&dropped.stderr).contains("previously published module"));
}

fn expire_registry(folder: &std::path::Path, generated_key: &[u8]) {
    use base64::Engine;
    let key = ring::signature::Ed25519KeyPair::from_pkcs8(generated_key).unwrap();
    let mut index: Value =
        serde_json::from_slice(&fs::read(folder.join("index.json")).unwrap()).unwrap();
    index["expires"] = serde_json::json!(chrono::Utc::now() - chrono::Duration::days(1));
    let index_bytes = serde_json::to_vec(&index).unwrap();
    let mut bundle: Value =
        serde_json::from_slice(&fs::read(folder.join("bundle.json")).unwrap()).unwrap();
    bundle["indexDigest"] = serde_json::json!(moss_module_host::trust::digest(&index_bytes));
    for (name, bytes) in [
        ("index.json", index_bytes),
        ("bundle.json", serde_json::to_vec(&bundle).unwrap()),
    ] {
        fs::write(folder.join(name), &bytes).unwrap();
        fs::write(
            folder.join(format!("{name}.sig")),
            base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).as_ref()),
        )
        .unwrap();
    }
}
