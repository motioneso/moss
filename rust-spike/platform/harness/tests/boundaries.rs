use std::{fs, process::Command};
use uuid::Uuid;
#[test]
fn provider_literal_is_rejected() {
    let root = std::env::temp_dir().join(format!("moss-boundary-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("feature/src")).unwrap();
    fs::write(
        root.join("feature/src/lib.rs"),
        "pub const HARDCODED: &str = concat!(r#\"openai-compatible\"#, \"\");",
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_check-literals"))
        .arg(&root)
        .output()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(
        !result.status.success(),
        "provider guard accepted a hardcoded provider in feature code"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("provider/model literal"));
}
#[test]
fn payload_shape_is_rejected() {
    let root = std::env::temp_dir().join(format!("moss-shape-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("contracts/src")).unwrap();
    fs::write(
        root.join("contracts/src/lib.rs"),
        "enum ParamSchema { Uuid, String { max: usize } }",
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_check-literals"))
        .arg(&root)
        .output()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(!result.status.success(), "payload guard accepted free text");
}
