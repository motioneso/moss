//! Fixture loading shared by the parity tests. The fixtures are written by the TypeScript app's
//! own code (`rust-spike/fixtures-gen/generate.ts`).

#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::Value;

pub fn spike_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

pub fn repo_root() -> PathBuf {
    spike_dir().parent().unwrap().to_path_buf()
}

pub fn fixture(name: &str) -> Value {
    let path = spike_dir().join("fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// The generator's `text()` form: `{ text }`, or `{ utf16 }` when it holds a lone surrogate.
/// Rust strings cannot hold one, so it becomes U+FFFD, which is also what Node hashes.
pub fn text(value: &Value) -> String {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    let units: Vec<u16> = value["utf16"]
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit.as_u64().unwrap() as u16)
        .collect();
    String::from_utf16_lossy(&units)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Ok(Value),
    Error(String),
}

impl Outcome {
    pub fn expected(expect: &Value) -> Self {
        match expect.get("error") {
            Some(error) => Outcome::Error(error.as_str().unwrap().to_string()),
            None => Outcome::Ok(expect["value"].clone()),
        }
    }
}

pub fn label(case: &Value) -> &str {
    case["label"].as_str().unwrap()
}
