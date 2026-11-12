//! Compares vectors from this crate with vectors the old app made for the same texts.
//! Needs the model files. Set MOSS_ON_DEVICE_MODEL_DIR to a folder holding model.onnx and
//! tokenizer.json; the test is skipped (and says so) when it is not set.
use moss_on_device::Engine;
use std::path::PathBuf;

fn cosine(a: &[f32], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| f64::from(*x) * y).sum()
}

#[test]
fn vectors_match_the_old_app() {
    let Ok(dir) = std::env::var("MOSS_ON_DEVICE_MODEL_DIR") else {
        eprintln!("skipped: MOSS_ON_DEVICE_MODEL_DIR is not set");
        return;
    };
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let texts: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(fixtures.join("sentences.json")).unwrap()).unwrap();
    let old: Vec<Vec<f64>> =
        serde_json::from_slice(&std::fs::read(fixtures.join("old-vectors.json")).unwrap()).unwrap();
    assert_eq!(texts.len(), old.len());
    let mut engine = Engine::load(&PathBuf::from(dir)).unwrap();
    let mut worst = 1.0_f64;
    for (item, expected) in texts.iter().zip(&old) {
        let prefix = if item["kind"] == "query" { "search_query: " } else { "search_document: " };
        let text = format!("{prefix}{}", item["text"].as_str().unwrap());
        let got = engine.embed(&text).unwrap();
        assert_eq!(got.len(), 768);
        let c = cosine(&got, expected);
        eprintln!("cosine {c:.7} for {} characters", text.len());
        worst = worst.min(c);
    }
    assert!(worst > 0.9999, "worst cosine was {worst}");
}
