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
        let index_path = output.join("registry/index.json");
        let mut index: Value = serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        index["expires"] = serde_json::json!(chrono::Utc::now() - chrono::Duration::days(1));
        let bytes = serde_json::to_vec(&index).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
        fs::write(index_path, &bytes).unwrap();
        fs::write(
            output.join("registry/index.json.sig"),
            base64::engine::general_purpose::STANDARD.encode(pair.sign(&bytes).as_ref()),
        )
        .unwrap();
        copy_tree(&output, std::path::Path::new(&destination));
    }
}
