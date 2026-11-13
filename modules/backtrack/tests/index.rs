//! The index job, from the legacy index-job and upkeep tests that a scripted host can show.
mod common;
use common::*;
use moss_backtrack_module::{handle, index};
use serde_json::{json, Value};

const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn seg(id: &str, body: &str) -> Value {
    json!({"id": id, "windowTitle": "A page", "address": "https://example.test/a", "body": body})
}

fn job(host: &Fake, queue: &str) -> moss_module_sdk::Result<String> {
    handle(host, "job", &json!({"queue": queue, "parameters": {}}).to_string())
}

fn memory_calls(host: &Fake, name: &str) -> Vec<Value> {
    host.calls.borrow().iter().filter(|c| c.0 == "api" && c.3["name"] == name).map(|c| c.3["parameters"].clone()).collect()
}

#[test]
fn source_path_and_kind_match_the_legacy_ones() {
    assert_eq!(index::source_path(A), format!("backtrack/{A}"));
    assert_eq!(index::SOURCE_KIND, "screen");
    assert_eq!(index::BATCH, 200);
}

#[test]
fn embeds_a_segment_under_source_kind_screen_and_stamps_it() {
    let host = Fake { pending: vec![seg(A, "hello world")], ..Fake::default() };
    let out = job(&host, "backtrack.index").unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"indexed": 1}));
    let sent = memory_calls(&host, "upsertChunks");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["sourceKind"], "screen");
    assert_eq!(sent[0]["sourcePath"], format!("backtrack/{A}"));
    assert_eq!(sent[0]["replaceExisting"], true);
    assert_eq!(sent[0]["chunks"][0]["text"], "A page\nhttps://example.test/a\nhello world");
    assert_eq!(host.params("kv.mark-indexed").unwrap(), json!({"ids": [A]}));
    assert_eq!(host.ops()[0], "kv.lock");
}

#[test]
fn a_segment_with_no_text_is_stamped_without_a_chunk() {
    let blank = json!({"id": A, "windowTitle": "", "address": null, "body": "  "});
    let host = Fake { pending: vec![blank], ..Fake::default() };
    job(&host, "backtrack.index").unwrap();
    assert!(memory_calls(&host, "upsertChunks").is_empty());
    assert_eq!(host.params("kv.mark-indexed").unwrap(), json!({"ids": [A]}));
}

#[test]
fn an_embedding_failure_leaves_the_segment_unindexed_and_fails_the_job() {
    let host = Fake { pending: vec![seg(A, "x")], memory_fails: true, ..Fake::default() };
    assert!(job(&host, "backtrack.index").is_err());
    assert!(host.params("kv.mark-indexed").is_none());
}

#[test]
fn a_full_batch_queues_another_run() {
    let host = Fake { pending: (0..200).map(|_| seg(A, "x")).collect(), ..Fake::default() };
    job(&host, "backtrack.index").unwrap();
    assert!(host.ops().contains(&"jobs.enqueue-after-commit".to_string()));
    let small = Fake { pending: vec![seg(A, "x")], ..Fake::default() };
    job(&small, "backtrack.index").unwrap();
    assert!(!small.ops().contains(&"jobs.enqueue-after-commit".to_string()));
}

#[test]
fn an_upload_queues_an_index_run_with_no_text_in_the_payload() {
    let host = Fake::default();
    let started = "2026-11-12T11:00:00.000Z";
    let ended = "2026-11-12T11:01:00.000Z";
    let body = json!({"sentAt": "2026-11-12T12:00:00.000Z", "segments": [segment(started, ended, "SECRET SCREEN WORDS")]});
    let response = moss_backtrack_module::route(&host, request("POST", "/ingest", body));
    assert_eq!(response.status, 200);
    let queued = host.params("jobs.enqueue-after-commit").expect("index run queued");
    assert_eq!(queued["params"], json!({}));
    assert!(!queued.to_string().contains("SECRET"));
    let queued_calls: Vec<String> =
        host.calls.borrow().iter().filter(|c| c.0 == "jobs").map(|c| format!("{} {}", c.2, c.3)).collect();
    assert!(queued_calls.iter().all(|c| !c.contains("SECRET")));
}

#[test]
fn deleting_removes_the_indexed_chunks_before_the_rows() {
    let host = Fake { segment_ids: vec![A.into(), B.into()], ..Fake::default() };
    let response = moss_backtrack_module::route(&host, request("DELETE", "/segments", json!({})));
    assert_eq!(response.status, 200);
    let sent = memory_calls(&host, "deleteChunksForSources");
    assert_eq!(sent[0]["sourceKind"], "screen");
    assert_eq!(sent[0]["sourcePaths"], json!([format!("backtrack/{A}"), format!("backtrack/{B}")]));
    let ops = host.ops();
    let removed = ops.iter().position(|o| o == "api.call").unwrap();
    let deleted = ops.iter().position(|o| o == "kv.delete").unwrap();
    assert!(removed < deleted);
}

#[test]
fn a_failed_chunk_removal_keeps_the_text_so_nothing_is_orphaned() {
    let host = Fake { segment_ids: vec![A.into()], memory_fails: true, ..Fake::default() };
    let response = moss_backtrack_module::route(&host, request("DELETE", "/segments", json!({})));
    assert_eq!(response.status, 500);
    assert!(!host.ops().contains(&"kv.delete".to_string()));
}

#[test]
fn the_sweep_removes_chunks_with_expired_segments_and_queues_stale_text() {
    let host = Fake { expired: vec![A.into()], stale: true, ..Fake::default() };
    job(&host, "backtrack.upkeep").unwrap();
    let sent = memory_calls(&host, "deleteChunksForSources");
    assert_eq!(sent[0]["sourcePaths"], json!([format!("backtrack/{A}")]));
    assert_eq!(host.params("kv.upkeep").unwrap(), json!({"ids": [A]}));
    assert!(host.ops().contains(&"jobs.enqueue-after-commit".to_string()));
}

#[test]
fn the_sweep_queues_nothing_when_no_text_is_stale() {
    let host = Fake::default();
    job(&host, "backtrack.upkeep").unwrap();
    assert!(!host.ops().contains(&"jobs.enqueue-after-commit".to_string()));
}

#[test]
fn removal_splits_into_batches_of_500_paths() {
    let ids: Vec<String> = (0..1100).map(|i| format!("{i:08}-0000-4000-8000-000000000000")).collect();
    let host = Fake::default();
    index::remove_chunks(&host, &ids).unwrap();
    let sizes: Vec<usize> = memory_calls(&host, "deleteChunksForSources").iter().map(|c| c["sourcePaths"].as_array().unwrap().len()).collect();
    assert_eq!(sizes, [500, 500, 100]);
}

#[test]
fn job_payloads_stay_metadata_only() {
    let host = Fake { pending: vec![seg(A, "SECRET")], ..Fake::default() };
    job(&host, "backtrack.index").unwrap();
    for call in host.calls.borrow().iter().filter(|c| c.0 == "jobs") {
        assert!(!call.3.to_string().contains("SECRET"));
    }
}
