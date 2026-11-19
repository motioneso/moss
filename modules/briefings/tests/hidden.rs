//! What a person's own ratings hide from the reader: dismissed runs, items and catch-up entries.
mod common;
use common::*;
use serde_json::{json, Value};

const RUN: &str = "00000000-0000-4000-8000-0000000000a1";
const OTHER_RUN: &str = "00000000-0000-4000-8000-0000000000a2";

fn setup() -> (Fake, String) {
    let fake = Fake::new();
    let (_, out) = fake.route("POST", "/definitions", &[], json!({"title":"Morning"}));
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    let metadata = json!({
        "aiModel": {"provider": "p", "model": "m"},
        "calendarSignals": [{"type": "meeting", "summary": "Design review", "score": 70}],
        "emailSignals": [{"type": "reply", "summary": "Reply to Sam", "score": 40}],
        "structuredPayload": {"version": 1, "actionRows": [], "catchUp": {
            "itemCount": 2,
            "entries": [
                {"id": "catch-1", "summary": "Contract question"},
                {"id": "catch-2", "summary": "Invoice"}
            ]
        }}
    });
    fake.seed_run(&id, A, RUN, "2026-11-11T07:00:00.000Z", metadata.clone());
    fake.seed_run(&id, A, OTHER_RUN, "2026-11-10T07:00:00.000Z", metadata);
    (fake, id)
}

fn list(fake: &Fake, id: &str) -> Value {
    fake.route("GET", "/definitions/:id/runs", &[("id", id)], json!({})).1
}

fn read(fake: &Fake, id: &str, run: &str) -> Value {
    fake.route("GET", "/definitions/:id/runs/:run_id", &[("id", id), ("run_id", run)], json!({})).1["run"].clone()
}

fn item_ids(run: &Value) -> Vec<String> {
    run["feedbackItems"].as_array().unwrap().iter().map(|i| i["feedbackItemId"].as_str().unwrap().to_owned()).collect()
}

fn catch_up_ids(run: &Value) -> Vec<String> {
    run["structuredPayload"]["catchUp"]["entries"]
        .as_array()
        .map(|e| e.iter().map(|x| x["id"].as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

#[test]
fn a_dismissed_item_stays_hidden_on_reload_and_undo_brings_it_back() {
    let (fake, id) = setup();
    let all = item_ids(&list(&fake, &id)["runs"][0]);
    assert_eq!(all.len(), 2);
    fake.rate(A, "briefing_item", "dismiss", &all[0]);
    for _ in 0..2 {
        // The reload gives the same answer.
        let runs = list(&fake, &id);
        assert_eq!(item_ids(&runs["runs"][0]), vec![all[1].clone()]);
        assert_eq!(item_ids(&runs["runs"][1]), vec![all[1].clone()]);
        assert_eq!(item_ids(&read(&fake, &id, RUN)), vec![all[1].clone()]);
    }
    fake.unrate(A, "briefing_item", "dismiss", &all[0]);
    assert_eq!(item_ids(&list(&fake, &id)["runs"][0]), all);
    assert_eq!(item_ids(&read(&fake, &id, RUN)), all);
}

#[test]
fn another_accounts_dismissals_never_hide_my_items() {
    let (fake, id) = setup();
    let all = item_ids(&list(&fake, &id)["runs"][0]);
    fake.rate(B, "briefing_item", "dismiss", &all[0]);
    fake.rate(B, "briefing_item", "dismiss", "catch-1");
    fake.rate(B, "briefing_run", "dismiss", RUN);
    let runs = list(&fake, &id);
    assert_eq!(runs["runs"].as_array().unwrap().len(), 2);
    assert_eq!(item_ids(&runs["runs"][0]), all);
    assert_eq!(catch_up_ids(&runs["runs"][0]), vec!["catch-1", "catch-2"]);
    assert_eq!(catch_up_ids(&read(&fake, &id, RUN)), vec!["catch-1", "catch-2"]);
}

#[test]
fn a_dismissed_run_leaves_the_list_but_opens_by_id() {
    let (fake, id) = setup();
    fake.rate(A, "briefing_run", "dismiss", RUN);
    let runs = list(&fake, &id);
    let ids: Vec<_> = runs["runs"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![OTHER_RUN]);
    assert_eq!(read(&fake, &id, RUN)["id"], RUN);
    fake.unrate(A, "briefing_run", "dismiss", RUN);
    assert_eq!(list(&fake, &id)["runs"].as_array().unwrap().len(), 2);
}

#[test]
fn a_handled_catch_up_entry_drops_out_and_the_block_goes_when_none_remain() {
    let (fake, id) = setup();
    fake.rate(A, "briefing_item", "dismiss", "catch-1");
    let run = list(&fake, &id)["runs"][0].clone();
    assert_eq!(catch_up_ids(&run), vec!["catch-2"]);
    assert_eq!(run["structuredPayload"]["catchUp"]["itemCount"], 1);
    fake.rate(A, "briefing_item", "more_like_this", "catch-2");
    for run in [list(&fake, &id)["runs"][0].clone(), read(&fake, &id, RUN)] {
        assert_eq!(run["structuredPayload"]["catchUp"], Value::Null);
    }
    fake.unrate(A, "briefing_item", "more_like_this", "catch-2");
    assert_eq!(catch_up_ids(&read(&fake, &id, RUN)), vec!["catch-2"]);
}

#[test]
fn a_like_does_not_hide_a_signal_item() {
    let (fake, id) = setup();
    let all = item_ids(&list(&fake, &id)["runs"][0]);
    fake.rate(A, "briefing_item", "more_like_this", &all[0]);
    assert_eq!(item_ids(&list(&fake, &id)["runs"][0]), all);
}
