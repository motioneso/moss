//! Fact 1: Rust verifies password hashes made by the app (better-auth 1.6.14 on Node).

mod common;

use common::{fixture, label, text, Outcome};
use portability::password::{nfkc, verify_password};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[test]
fn rust_verifies_app_made_password_hashes() {
    let fixtures = fixture("passwords.json");
    let mut failures = Vec::new();
    let mut total = 0;
    for group in ["hashes", "checks", "malformed"] {
        for case in fixtures[group].as_array().unwrap() {
            total += 1;
            let password = text(case.get("password").or_else(|| case.get("input")).unwrap());
            let got = match verify_password(case["hash"].as_str().unwrap(), &password) {
                Ok(matched) => Outcome::Ok(Value::Bool(matched)),
                Err(error) => Outcome::Error(error.to_string()),
            };
            let want = Outcome::expected(&case["expect"]);
            if got != want {
                failures.push(format!("{group}/{}: rust {got:?}, node {want:?}", label(case)));
            }
        }
    }
    println!("passwords: {}/{total} cases agree with Node", total - failures.len());
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Code points the fixture's Node has not assigned, from its `"378-379,380-383,..."` list.
fn node_unassigned(table: &serde_json::Value) -> Vec<(u32, u32)> {
    let hex = |text: &str| u32::from_str_radix(text, 16).unwrap();
    table["unassigned"]
        .as_str()
        .unwrap()
        .split(',')
        .map(|range| {
            let (low, high) = range.split_once('-').unwrap();
            (hex(low), hex(high))
        })
        .collect()
}

#[test]
fn nfkc_agrees_with_node_for_every_code_point() {
    let fixtures = fixture("passwords.json");
    let table = &fixtures["nfkcTable"];
    let block = table["blockSize"].as_u64().unwrap() as u32;
    let digests = table["digests"].as_array().unwrap();
    let unassigned = node_unassigned(table);
    let is_unassigned = |code_point: u32| {
        let at = unassigned.partition_point(|&(_, high)| high < code_point);
        unassigned.get(at).is_some_and(|&(low, _)| low <= code_point)
    };

    // Node leaves a code point its Unicode version has not assigned unchanged. The Rust table
    // may be from a later version that maps some of them, and those are counted separately.
    let mut differing = Vec::new();
    let mut mapped_only_by_rust = Vec::new();
    for (index, want) in digests.iter().enumerate() {
        let start = index as u32 * block;
        let mut hash = Sha256::new();
        for code_point in start..start + block {
            // Surrogates are not chars; the generator skips them too.
            let Some(c) = char::from_u32(code_point) else { continue };
            let text = c.to_string();
            let mut normalized = nfkc(&text);
            if is_unassigned(code_point) && normalized != text {
                mapped_only_by_rust.push(format!("U+{code_point:04X}"));
                normalized = text;
            }
            hash.update(format!("{code_point:x}={normalized}\n"));
        }
        if hex::encode(hash.finalize())[..16] != *want.as_str().unwrap() {
            differing.push(format!("U+{start:04X}..U+{:04X}", start + block - 1));
        }
    }
    let (major, minor, update) = unicode_normalization::UNICODE_VERSION;
    println!(
        "NFKC: {}/{} blocks of {block} code points agree with Node (Node Unicode {}, Rust crate \
         Unicode {major}.{minor}.{update})",
        digests.len() - differing.len(),
        digests.len(),
        fixtures["provenance"]["unicode"].as_str().unwrap()
    );
    println!(
        "NFKC: {} code points are unassigned in Node's Unicode but mapped by the Rust crate: {}",
        mapped_only_by_rust.len(),
        mapped_only_by_rust.join(" ")
    );
    assert!(differing.is_empty(), "blocks that differ: {differing:?}");
}
