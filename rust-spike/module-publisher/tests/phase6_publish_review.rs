mod support;
use moss_module_host::archive::pack;
use serde_json::{json, Value};
use support::*;

#[test]
fn clean_package_and_signed_growth_index() {
    let f = Fixture::new();
    let review = f.review_ok();
    assert_eq!(review["diff"]["newPublisher"], false);
    assert_eq!(review["diff"]["capabilities"], json!([]));
    let envelope = f.publish_ok(None);
    f.verify_index(&envelope);
    let index: Value = serde_json::from_str(envelope["index"].as_str().unwrap()).unwrap();
    assert!(
        index["publishReviews"][&f.digest()]["request"]["diff"]["capabilities"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn new_publisher_waits_for_human() {
    let f = Fixture::new();
    f.clear_history();
    assert_eq!(f.review_ok()["diff"]["newPublisher"], true);
    f.refused("publish", None, "Human approval required");
    let approval = f.approve();
    f.verify_index(&f.publish_ok(Some(&approval)));
}

#[test]
fn new_capability_waits_and_marks_signed_index() {
    let f = Fixture::new();
    f.edit_manifest(|m| {
        m["capabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!({"port":"ai","operations":["summarize"]}))
    });
    f.refused("publish", None, "Human approval required");
    let approval = f.approve();
    let envelope = f.publish_ok(Some(&approval));
    f.verify_index(&envelope);
    let index: Value = serde_json::from_str(envelope["index"].as_str().unwrap()).unwrap();
    assert_eq!(
        index["publishReviews"][&f.digest()]["request"]["diff"]["capabilities"][0]["port"],
        "ai"
    );
}

#[test]
fn fetch_host_growth_waits_and_is_marked() {
    let f = Fixture::new();
    f.edit_manifest(|m| {
        m["capabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!({"port":"fetch","operations":["get"],"resources":["example.org"]}))
    });
    assert_eq!(f.review_ok()["diff"]["fetchHosts"], json!(["example.org"]));
    f.refused("publish", None, "Human approval required");
    let approval = f.approve();
    let envelope = f.publish_ok(Some(&approval));
    f.verify_index(&envelope);
}

#[test]
fn modified_approval_digest_diff_and_signer_are_refused() {
    let f = Fixture::new();
    f.clear_history();
    let approval = f.approve();
    let mut changed = approval.clone();
    changed["request"]["digest"] = json!("0".repeat(64));
    f.refused("publish", Some(&changed), "Approval does not match");
    let mut changed = approval.clone();
    changed["request"]["diff"]["newPublisher"] = json!(false);
    f.refused("publish", Some(&changed), "Approval does not match");
    let mut changed = approval.clone();
    changed["reviewer"] = json!("unknown");
    f.refused("publish", Some(&changed), "Reviewer is not trusted");
    let mut changed = approval;
    changed["signature"] = json!(sign(&key(), b"wrong"));
    f.refused("publish", Some(&changed), "signature does not match");
}

#[test]
fn approval_cannot_be_replayed_after_package_or_base_changes() {
    let f = Fixture::new();
    f.clear_history();
    let approval = f.approve();
    f.files
        .borrow_mut()
        .insert("CHANGELOG.md".into(), b"changed".to_vec());
    f.write_package();
    f.refused("publish", Some(&approval), "Approval does not match");
    let approval = f.approve();
    f.edit_index(|index| index["serial"] = json!(8));
    f.refused("publish", Some(&approval), "Approval does not match");
}

#[test]
fn self_hosted_policy_still_runs_install_checks() {
    let f = Fixture::new();
    f.clear_history();
    f.edit_config(|c| c["policy"] = json!("self-hosted"));
    f.verify_index(&f.publish_ok(None));
    f.files
        .borrow_mut()
        .insert("code/module.wasm".into(), b"bad component".to_vec());
    f.write_package();
    f.refused("publish", None, "component");
}

#[test]
fn bad_archive_is_refused() {
    let f = Fixture::new();
    f.files.borrow_mut().remove("NOTICE");
    f.write_package();
    f.refused("review", None, "missing NOTICE");
}

#[test]
fn bad_manifest_is_refused() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["schemaVersion"] = json!(999));
    f.refused("review", None, "unsupported manifest version");
}

#[test]
fn undeclared_import_is_refused() {
    let f = Fixture::new();
    // The real sample component imports kv; notify is valid but does not grant kv.
    f.edit_manifest(|m| m["capabilities"] = json!([{"port":"notify","operations":["send"]}]));
    f.refused("review", None, "undeclared or forbidden host service");
}

#[test]
fn bad_sql_is_refused() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["database"] = json!({"migrations":["sql/001.sql"]}));
    f.files
        .borrow_mut()
        .insert("sql/001.sql".into(), b"DROP TABLE app.other;".to_vec());
    f.write_package();
    f.refused("review", None, "not part of the module package subset");
}

#[test]
fn provider_model_fields_are_refused() {
    let f = Fixture::new();
    f.edit_manifest(|m| {
        m["capabilities"].as_array_mut().unwrap().push(json!({"port":"tools","operations":["offer"]}));
        m["tools"] = json!({"sample.inspect":{"description":"Inspect","risk":"read","inputSchema":{"type":"object","properties":{"model":{"type":"string","description":"A forbidden model selector"}}}}});
    });
    f.refused("review", None, "not providers or models");
}

#[test]
fn wrong_publisher_name_and_signature_are_refused() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["id"] = json!("other.counter"));
    f.refused("review", None, "cannot sign this module name");
    let f = Fixture::new();
    f.edit_submission(|s| s["signature"] = json!(sign(&key(), b"wrong")));
    f.refused("review", None, "signature does not match");
}

#[test]
fn version_reuse_and_downgrade_are_refused() {
    let f = Fixture::new();
    f.edit_manifest(|m| m["version"] = json!("1.0.0"));
    f.refused("review", None, "Version must be newer");
    f.edit_manifest(|m| m["version"] = json!("0.9.0"));
    f.refused("review", None, "Version must be newer");
}

#[test]
fn altered_published_sql_is_refused() {
    let f = Fixture::new();
    f.add_prior_sql();
    f.files.borrow_mut().insert(
        "sql/001.sql".into(),
        b"CREATE TABLE app.sample_counter_rows (id text);".to_vec(),
    );
    f.write_package();
    f.refused("review", None, "published migration was changed or removed");
}

#[test]
fn newest_signed_version_is_the_baseline() {
    let f = Fixture::new();
    f.add_newer_history();
    f.refused("review", None, "Version must be newer");
}

#[test]
fn tampered_prior_index_is_refused() {
    let f = Fixture::new();
    let path = f.dir.path().join("registry/index.json");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.push(b' ');
    std::fs::write(path, bytes).unwrap();
    f.refused("review", None, "signature does not match");
}

#[test]
fn tampered_prior_package_is_refused() {
    let f = Fixture::new();
    let bytes = pack(&f.files.borrow()).unwrap();
    let index: Value =
        serde_json::from_slice(&std::fs::read(f.dir.path().join("registry/index.json")).unwrap())
            .unwrap();
    let digest = index["modules"][0]["digest"].as_str().unwrap();
    std::fs::write(
        f.dir
            .path()
            .join(format!("registry/packages/{digest}.mosspkg")),
        bytes,
    )
    .unwrap();
    f.refused("review", None, "does not match");
}
