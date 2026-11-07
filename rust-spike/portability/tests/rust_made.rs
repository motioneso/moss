//! The reverse direction: Rust makes password hashes and envelopes, and
//! `fixtures-gen/check-rust-made.ts` checks them with the app's own code.

mod common;

use common::{fixture, label};
use portability::password::hash_password;
use portability::secrets::{
    family_keyring_from_setting, resolve_keyring, seal_family_setting, Env, JsonSecretCipher,
    Keyring,
};
use serde_json::{json, Value};

fn keyring_for(fixtures: &Value, name: &str) -> Keyring {
    let keyring = &fixtures["keyrings"][name];
    let names: Vec<&str> =
        keyring["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    let env: Env = keyring["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_string()))
        .collect();
    resolve_keyring(names[0], names[1], names[2], "unused-dev-default", &env).unwrap()
}

fn seal(cipher: &JsonSecretCipher, payload: Value) -> Value {
    json!({ "envelope": cipher.encrypt_json(payload.as_object().unwrap()), "payload": payload })
}

#[test]
fn write_rust_made_values_for_the_app_to_check() {
    // The same passwords the app hashed, so the app now checks Rust's hashes of them.
    let passwords: Vec<Value> = fixture("passwords.json")["hashes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let password = common::text(&case["password"]);
            json!({ "label": label(case), "password": case["password"], "hash": hash_password(&password) })
        })
        .collect();

    let secrets = fixture("secrets.json");
    let ai = JsonSecretCipher::new(keyring_for(&secrets, "ai"), "AI secret");
    let connector = JsonSecretCipher::new(keyring_for(&secrets, "connector"), "connector secret");
    let envelopes = json!([
        { "cipher": "ai", "sealed": seal(&ai, json!({
            "apiKey": "fixture-only-rust-made-ai",
            "nested": { "list": [1, 2.5, null, true, "\u{fc}\u{1f600}"] }
        })) },
        { "cipher": "connector", "sealed": seal(&connector, json!({
            "accessToken": "fixture-only-rust-made-connector",
            "expiresAt": 1_767_225_600_000_u64
        })) }
    ]);

    // Family keys: one credential under the store the app wrote, then a store Rust writes
    // itself with a new current key and the app's keys kept as retired ones.
    let family = &secrets["family"];
    let master = JsonSecretCipher::new(
        keyring_for(&secrets, "ai"),
        family["masterCipherLabel"].as_str().unwrap(),
    );
    let family_label = family["familyCipherLabel"].as_str().unwrap();
    let app_store = family_keyring_from_setting(&family["storedSetting"], &master).unwrap();
    let under_app_store = seal(
        &JsonSecretCipher::new(app_store.clone(), family_label),
        json!({ "token": "fixture-only-rust-made-under-app-store" }),
    );
    let new_key: [u8; 32] = rand::random();
    let rust_setting = seal_family_setting("r1", &new_key, &app_store.keys, &master);
    let rust_store = family_keyring_from_setting(&rust_setting, &master).unwrap();
    let under_rust_store = seal(
        &JsonSecretCipher::new(rust_store, family_label),
        json!({ "token": "fixture-only-rust-made-under-rust-store" }),
    );

    let out = json!({
        "passwords": passwords,
        "envelopes": envelopes,
        "family": {
            "underAppStore": under_app_store,
            "rustSetting": rust_setting,
            "rustCurrentKeyId": "r1",
            "underRustStore": under_rust_store
        }
    });
    let path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("rust-made.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("rust-made values written to {}", path.display());
}
