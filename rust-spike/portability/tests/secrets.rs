//! Fact 2: Rust decrypts credential envelopes made by the app, with the same keys and format.

mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::{fixture, label, text, Outcome};
use portability::js;
use portability::secrets::{
    family_keyring_from_setting, fingerprints, resolve_keyring, Env, JsonSecretCipher, Keyring,
};
use serde_json::Value;

/// Envelopes the app never writes. Node accepts them; the port refuses them on purpose.
const STRICTER_THAN_NODE: [&str; 2] = ["hand-made-16-byte-iv", "hand-made-12-byte-tag"];

fn env_of(value: &Value) -> Env {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_string()))
        .collect()
}

fn keyring_for(fixtures: &Value, name: &str) -> Keyring {
    let keyring = &fixtures["keyrings"][name];
    let names: Vec<&str> = keyring["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    resolve_keyring(
        names[0],
        names[1],
        names[2],
        "unused-dev-default",
        &env_of(&keyring["env"]),
    )
    .unwrap()
}

fn envelope_json(case: &Value) -> Value {
    match case.get("envelopeText") {
        Some(text) => js::parse_json(text.as_str().unwrap()).unwrap().0,
        None => case["envelope"].clone(),
    }
}

fn decrypt(cipher: &JsonSecretCipher, envelope: &Value) -> Outcome {
    match cipher
        .parse_envelope(envelope)
        .and_then(|e| cipher.decrypt_json(&e))
    {
        Ok(decrypted) => Outcome::Ok(Value::String(STANDARD.encode(&decrypted.plaintext))),
        Err(error) => Outcome::Error(error),
    }
}

#[test]
fn rust_decrypts_app_made_envelopes() {
    let fixtures = fixture("secrets.json");
    let ai = JsonSecretCipher::new(keyring_for(&fixtures, "ai"), "AI secret");
    let connector = JsonSecretCipher::new(keyring_for(&fixtures, "connector"), "connector secret");
    let mut failures = Vec::new();
    let cases = fixtures["cases"].as_array().unwrap();
    for case in cases {
        let cipher = if case["keyring"] == "ai" {
            &ai
        } else {
            &connector
        };
        assert_eq!(case["cipherLabel"].as_str().unwrap(), cipher.label);
        let got = decrypt(cipher, &envelope_json(case));
        let want = Outcome::expected(&case["expect"]);
        if STRICTER_THAN_NODE.contains(&label(case)) {
            assert!(
                matches!(want, Outcome::Ok(_)),
                "{} should be accepted by Node",
                label(case)
            );
            if !matches!(got, Outcome::Error(_)) {
                failures.push(format!("{}: rust should refuse, got {got:?}", label(case)));
            }
        } else if got != want {
            failures.push(format!("{}: rust {got:?}, node {want:?}", label(case)));
        }
    }
    println!(
        "envelopes: {}/{} agree with Node, {} of them refused on purpose (never written by the app)",
        cases.len() - failures.len(),
        cases.len(),
        STRICTER_THAN_NODE.len()
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn lone_surrogate_payload_is_reported() {
    let fixtures = fixture("secrets.json");
    let ai = JsonSecretCipher::new(keyring_for(&fixtures, "ai"), "AI secret");
    let case = fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| label(case) == "lone-surrogate-payload")
        .unwrap();
    let decrypted = ai
        .decrypt_json(&ai.parse_envelope(&case["envelope"]).unwrap())
        .unwrap();
    assert!(decrypted.replaced_lone_surrogates);
    assert_eq!(decrypted.value["value"], "a\u{fffd}b");
}

#[test]
fn legacy_candidates_are_tried_in_node_order() {
    let fixtures = fixture("secrets.json");
    let want: Vec<String> = fixtures["keyrings"]["ai"]["legacyCandidateFingerprints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_string())
        .collect();
    assert_eq!(fingerprints(&keyring_for(&fixtures, "ai")), want);
}

#[test]
fn keyring_errors_match() {
    let fixtures = fixture("secrets.json");
    let mut failures = Vec::new();
    for case in fixtures["keyringErrors"].as_array().unwrap() {
        let got = match resolve_keyring(
            "JARVIS_AI_SECRET_KEY",
            "JARVIS_AI_SECRET_KEY_ID",
            "JARVIS_AI_SECRET_KEYS",
            "unused-dev-default",
            &env_of(&case["env"]),
        ) {
            Ok(keyring) => Outcome::Ok(serde_json::json!(fingerprints(&keyring))),
            Err(error) => Outcome::Error(error),
        };
        let want = Outcome::expected(&case["expect"]);
        // The JSON parser's own wording differs; only the refusal has to match.
        let agrees = if label(case) == "keys-bad-json" {
            matches!((&got, &want), (Outcome::Error(_), Outcome::Error(_)))
        } else {
            got == want
        };
        if !agrees {
            failures.push(format!("{}: rust {got:?}, node {want:?}", label(case)));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn family_keys_nested_in_the_master_store() {
    let fixtures = fixture("secrets.json");
    let family = &fixtures["family"];
    let master = JsonSecretCipher::new(
        keyring_for(&fixtures, "ai"),
        family["masterCipherLabel"].as_str().unwrap(),
    );
    let keyring = family_keyring_from_setting(&family["storedSetting"], &master).unwrap();
    assert_eq!(
        keyring.current_key_id,
        family["currentKeyId"].as_str().unwrap()
    );
    let want: Vec<String> = family["legacyCandidateFingerprints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_string())
        .collect();
    assert_eq!(fingerprints(&keyring), want);

    let cipher = JsonSecretCipher::new(keyring, family["familyCipherLabel"].as_str().unwrap());
    let mut failures = Vec::new();
    let cases = family["cases"].as_array().unwrap();
    for case in cases {
        let got = decrypt(&cipher, &case["envelope"]);
        let want = Outcome::expected(&case["expect"]);
        if got != want {
            failures.push(format!("{}: rust {got:?}, node {want:?}", label(case)));
        }
    }
    println!(
        "family keys: {}/{} envelopes agree with Node",
        cases.len() - failures.len(),
        cases.len()
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn node_decoders_match() {
    let fixtures = fixture("secrets.json");
    for (kind, decode) in [
        ("base64", js::base64_decode as fn(&str) -> Vec<u8>),
        ("hex", js::hex_decode as fn(&str) -> Vec<u8>),
    ] {
        for sample in fixtures["nodeDecoding"][kind].as_array().unwrap() {
            let input = text(&sample["input"]);
            assert_eq!(
                hex::encode(decode(&input)),
                sample["hex"].as_str().unwrap(),
                "{kind} {input:?}"
            );
        }
    }
}
