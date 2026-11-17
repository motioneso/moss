mod common;
use common::*;
use moss_scratchpad_module::route;
use serde_json::json;

#[test]
fn an_empty_pad_reads_with_the_old_defaults_and_the_limit() {
    let r = route(&Fake::default(), request("GET", "/note", json!(null)));
    assert_eq!(r.status, 200);
    assert_eq!(r.body["maxChars"], 64000);
    assert_eq!(r.body["revision"], 0);
    assert_eq!(r.body["shortcut"], "mod+shift+s");
    assert_eq!(r.body["updatedAt"], json!(null));
}

#[test]
fn save_needs_a_string_body_and_a_whole_revision() {
    let host = Fake::default();
    for (body, message) in [
        (json!({"body": 1, "revision": 0}), "body must be a string"),
        (json!({"revision": 0}), "body must be a string"),
        (json!({"body": "x", "revision": -1}), "revision must be a non-negative integer"),
        (json!({"body": "x", "revision": 1.5}), "revision must be a non-negative integer"),
        (json!({"body": "x", "revision": "0"}), "revision must be a non-negative integer"),
        (json!([]), "Request body must be an object"),
        (json!(null), "Request body must be an object"),
    ] {
        let r = route(&host, request("PUT", "/note", body));
        assert_eq!((r.status, r.body["error"].as_str()), (400, Some(message)));
    }
    assert!(host.ops().is_empty());
}

#[test]
fn save_refuses_a_note_over_the_limit_before_touching_the_store() {
    let host = Fake::default();
    let r = route(&host, request("PUT", "/note", json!({"body": "x".repeat(64001), "revision": 0})));
    assert_eq!((r.status, r.body), (413, json!({"code": "scratchpad_too_large", "maxChars": 64000})));
    assert!(host.ops().is_empty());
    // Characters outside the basic plane count as two, like the old web code counted them.
    let r = route(&host, request("PUT", "/note", json!({"body": "😀".repeat(32001), "revision": 0})));
    assert_eq!(r.status, 413);
    let r = route(&host, request("PUT", "/note", json!({"body": "x".repeat(64000), "revision": 0})));
    assert_eq!(r.status, 200);
}

#[test]
fn save_succeeds_on_the_right_revision_and_conflicts_on_a_stale_one() {
    let host = Fake::default();
    let r = route(&host, request("PUT", "/note", json!({"body": "one", "revision": 0})));
    assert_eq!((r.status, r.body), (200, json!({"revision": 1, "updatedAt": STAMP})));
    let r = route(&host, request("PUT", "/note", json!({"body": "two", "revision": 0})));
    assert_eq!(r.status, 409);
    assert_eq!(r.body["error"], "scratchpad_conflict");
    assert_eq!((r.body["body"].as_str(), r.body["revision"].as_u64(), r.body["updatedAt"].as_str()), (Some("one"), Some(1), Some("")));
}

#[test]
fn append_trims_rejects_empty_and_joins_with_a_newline() {
    let host = Fake::default();
    let r = route(&host, request("POST", "/append", json!({"text": " \n\t "})));
    assert_eq!((r.status, r.body["error"].as_str()), (400, Some("text must not be empty")));
    let r = route(&host, request("POST", "/append", json!({"text": 5})));
    assert_eq!((r.status, r.body["error"].as_str()), (400, Some("text must be a string")));
    let r = route(&host, request("POST", "/append", json!({"text": "  first  "})));
    assert_eq!(r.body, json!({"revision": 1, "updatedAt": STAMP, "appended": "first"}));
    let r = route(&host, request("POST", "/append", json!({"text": "second"})));
    assert_eq!(r.body["appended"], "\nsecond");
    let r = route(&host, request("POST", "/append", json!({"text": "x".repeat(64001)})));
    assert_eq!(r.status, 413);
}

#[test]
fn settings_validate_before_the_store_is_called() {
    let host = Fake::default();
    let r = route(&host, request("PATCH", "/settings", json!({"syncToNotes": "yes"})));
    assert_eq!((r.status, r.body["error"].as_str()), (400, Some("syncToNotes must be a boolean")));
    for bad in [json!("mod+k"), json!("shift+s"), json!(5)] {
        let r = route(&host, request("PATCH", "/settings", json!({"shortcut": bad})));
        assert_eq!((r.status, r.body), (400, json!({"code": "scratchpad_shortcut_invalid"})));
    }
    let r = route(&host, request("PATCH", "/settings", json!("nope")));
    assert_eq!(r.status, 400);
    assert!(host.ops().is_empty());
}

#[test]
fn settings_turn_on_copying_only_with_a_notes_folder() {
    let without = Fake { notes_folder: false, ..Fake::default() };
    let r = route(&without, request("PATCH", "/settings", json!({"syncToNotes": true})));
    assert_eq!((r.status, r.body), (409, json!({"code": "scratchpad_notes_folder_missing"})));
    let r = route(&without, request("PATCH", "/settings", json!({"syncToNotes": false})));
    assert_eq!(r.status, 200);
    let with = Fake::default();
    let r = route(&with, request("PATCH", "/settings", json!({"syncToNotes": true, "shortcut": "ctrl+j"})));
    assert_eq!((r.status, r.body), (200, json!({"syncToNotes": true, "shortcut": "ctrl+j"})));
}

#[test]
fn unknown_routes_are_not_found_and_only_the_store_is_used() {
    let host = Fake::default();
    assert_eq!(route(&host, request("DELETE", "/note", json!({}))).status, 404);
    route(&host, request("GET", "/note", json!(null)));
    let calls = host.calls.borrow();
    assert!(calls.iter().all(|c| c.0 == "kv" && c.2 == "scratchpad.store"));
}

#[test]
fn settings_refuse_null_values_like_the_old_handler() {
    let host = Fake::default();
    let r = route(&host, request("PATCH", "/settings", json!({"syncToNotes": null})));
    assert_eq!((r.status, r.body["error"].clone()), (400, json!("syncToNotes must be a boolean")));
    let r = route(&host, request("PATCH", "/settings", json!({"shortcut": null})));
    assert_eq!((r.status, r.body["code"].clone()), (400, json!("scratchpad_shortcut_invalid")));
}
