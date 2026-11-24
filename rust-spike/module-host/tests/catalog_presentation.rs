//! A label or screenshot changed outside the signed bytes must fail the existing signature path.
mod common;
use moss_module_host::{
    registry::{Catalog, SeenRegistry, Source},
    trust,
};
use serde_json::json;
use std::fs;
#[test]
fn presentation_is_signed_and_bounded() {
    let root = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(root.path(), "1.0.0", 1, vec![]);
    let path = root.path().join("index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index["modules"][0]["presentation"] = json!({"name":"Counter","description":"A counter","publisher":"Sample","category":"Home","screenshots":[{"file":format!("{}.png",trust::digest(b"image")),"caption":"Overview"}]});
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(&path, &bytes).unwrap();
    let read = || {
        Catalog::fetch(
            Source::Folder(root.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.publisher),
            &mut SeenRegistry::default(),
        )
    };
    assert!(
        read().is_err(),
        "unsigned category/screenshot changes refused"
    );
    fs::write(
        root.path().join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    assert!(read().is_ok());
    index["modules"][0]["presentation"]["category"] = json!("Tampered");
    fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert!(read().is_err());
    index["modules"][0]["presentation"]["screenshots"] =
        json!([{"file":"../../private.png","caption":"Bad"}]);
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::write(
        root.path().join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    assert!(
        read().is_err(),
        "even signed unsafe media references refused"
    );
    index["modules"][0]["presentation"]["screenshots"] = json!((0..5)
        .map(|_| json!({"file":format!("{}.png",trust::digest(b"image")),"caption":"Overview"}))
        .collect::<Vec<_>>());
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::write(
        root.path().join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    assert!(read().is_err(), "at most four screenshots");
}
