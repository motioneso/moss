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
    // Directory insertion order and file mode do not contribute to archive bytes.
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
