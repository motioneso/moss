//! Account deletion and export shape, and agreement with the manifest.
mod common;
use common::{Fake, A, B};
use moss_meetings_module::lifecycle::{collect, COUNT_PREDICATE, OWNED_TABLES};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn manifest() -> Value {
    let path = format!("{}/../moss.module.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn deletion_covers_the_same_twenty_two_tables_the_manifest_owns() {
    let m = manifest();
    let owned: Vec<&str> = m["database"]["ownedTables"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(owned.len(), 22);
    assert_eq!(owned, OWNED_TABLES.to_vec());
    let db = m["capabilities"].as_array().unwrap().iter().find(|c| c["port"] == "db").unwrap();
    assert_eq!(db["resources"].as_array().unwrap().len(), 22);
    assert_eq!(COUNT_PREDICATE, "owner_user_id = $1::uuid");
}

#[test]
fn the_manifest_declares_the_same_routes_jobs_and_ledger() {
    let m = manifest();
    assert_eq!(m["database"]["ledger"], "core-legacy");
    assert_eq!(m["database"]["migrations"].as_array().unwrap().len(), 17);
    assert_eq!(m["navigation"], json!([]));
    assert_eq!(m["screens"], json!({}));
    let routes: BTreeSet<(String, String)> = m["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["method"].as_str().unwrap().into(), r["path"].as_str().unwrap().into()))
        .collect();
    let chat: BTreeSet<(String, String)> = moss_meetings_module::approval::CHAT_CLASSES
        .iter()
        .map(|(m, p, _)| ((*m).into(), (*p).into()))
        .collect();
    assert_eq!(routes, chat);
    let jobs: BTreeSet<&str> = m["jobs"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(jobs, moss_meetings_module::jobs::QUEUES.iter().copied().collect());
}

#[test]
fn export_holds_all_eighteen_collections() {
    let f = Fake::new();
    let (_, made) = f.route("POST", "/records", &[], json!({"requestKey":"11111111-1111-4111-8111-111111111111","title":"Export me"}));
    let id = made["meeting"]["id"].as_str().unwrap();
    f.route(
        "PUT",
        "/records/:id/notes",
        &[("id", id)],
        json!({"requestKey":"22222222-2222-4222-8222-222222222222","expectedRevision":0,"personalNotes":"kept"}),
    );
    let section = collect(&f).unwrap();
    let names: BTreeSet<&str> = section.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(names.len(), 18);
    let records = section["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["title"], "Export me");
    assert_eq!(records[0]["creationTitle"], "Export me");
    assert_eq!(records[0]["personalNotes"], "kept");
    assert_eq!(records[0]["notesRevision"], 1);
    assert_eq!(records[0]["ownerUserId"], A);
    let writes = section["note_writes"].as_array().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["expectedRevision"], 0);
}

#[test]
fn host_collections_pass_through_untouched() {
    let f = Fake::new();
    f.section.borrow_mut().insert(
        A.into(),
        json!({"recording_imports":[{"id":"x","ready":true,"chunks":[{"kind":"wav","index":0,"byteLength":3,"sha256":"h","base64":"AQID"}]}]}),
    );
    let section = collect(&f).unwrap();
    assert_eq!(section["recording_imports"][0]["chunks"][0]["base64"], "AQID");
    assert_eq!(section["export_receipts"], json!([]));
    assert_eq!(section.as_object().unwrap().len(), 18);
}

#[test]
fn export_never_includes_another_persons_rows() {
    let f = Fake::new();
    f.route("POST", "/records", &[], json!({"requestKey":"11111111-1111-4111-8111-111111111111","title":"Mine"}));
    f.as_actor(B);
    let section = collect(&f).unwrap();
    assert_eq!(section["records"], json!([]));
    assert_eq!(section["note_writes"], json!([]));
}

#[test]
fn export_pages_past_one_hundred_rows() {
    let f = Fake::new();
    for n in 0..230 {
        f.route("POST", "/records", &[], json!({"requestKey":format!("bbbbbbbb-0000-4000-8000-{n:012}"),"title":format!("m{n}")}));
    }
    assert_eq!(collect(&f).unwrap()["records"].as_array().unwrap().len(), 230);
}
