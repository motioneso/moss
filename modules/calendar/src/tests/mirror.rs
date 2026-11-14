//! The Outlook mirror import, against an in-memory event cache. Ported from the old import tests.
use moss_calendar::mirror::{external_id, import};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

#[derive(Default)]
struct Cache {
    rows: RefCell<Vec<Value>>,
    writes: RefCell<usize>,
}

impl Host for Cache {
    fn call(&self, port: &str, _: &str, resource: &str, p: Value) -> Result<Value> {
        assert_eq!((port, resource), ("kv", "calendar.cache-write"));
        let mut rows = self.rows.borrow_mut();
        match p["action"].as_str().unwrap() {
            "mirror-rows" => Ok(json!({"rows": rows.iter().filter(|r| r["externalId"].as_str().unwrap().starts_with(p["prefix"].as_str().unwrap())).cloned().collect::<Vec<_>>()})),
            "upsert" => {
                *self.writes.borrow_mut() += 1;
                let e = &p["event"];
                let row = json!({"id":format!("row{}", rows.len()),"externalId":p["externalId"],
                    "startsAt":e["startsAt"],"endsAt":e["endsAt"],"metadata":e["externalMetadata"]});
                match rows.iter_mut().find(|r| r["externalId"] == p["externalId"]) {
                    Some(old) => *old = row,
                    None => rows.push(row),
                }
                Ok(json!({}))
            }
            "mirror-merge" => {
                *self.writes.borrow_mut() += 1;
                let row = rows.iter_mut().find(|r| r["id"] == p["id"]).unwrap();
                for (k, v) in p["metadata"].as_object().unwrap() {
                    row["metadata"][k] = v.clone();
                }
                Ok(json!({}))
            }
            other => panic!("unexpected {other}"),
        }
    }
}

fn event(key: &str, day: &str) -> Value {
    json!({"occurrenceKey":key,"title":"Invented meeting","startsAt":format!("{day}T17:00:00.000Z"),
           "endsAt":format!("{day}T18:00:00.000Z"),"allDay":false,"timeZone":"America/Los_Angeles"})
}

fn batch(observed: &str, complete: bool, events: Vec<Value>) -> Value {
    json!({"batch":{"calendarKey":"primary","timeZone":"America/Los_Angeles","observedAt":observed,
        "windowStart":"2026-10-20","windowEnd":"2026-11-21","complete":complete,"events":events},
        "connectorAccountId":"account"})
}

#[test]
fn identity_is_a_json_pair() {
    assert_eq!(external_id("primary", "a,b"), r#"["primary","a,b"]"#);
}

#[test]
fn a_bad_batch_is_refused_before_any_write() {
    let cache = Cache::default();
    let mut bad = batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21"), event("a", "2026-10-22")]);
    assert!(import(&cache, &bad).is_err());
    bad["batch"]["events"] = json!([event("a", "2026-10-21")]);
    bad["batch"]["windowEnd"] = json!("2026-12-30");
    assert!(import(&cache, &bad).is_err());
    assert_eq!(*cache.writes.borrow(), 0);
}

#[test]
fn an_older_or_equal_scan_never_overwrites_a_newer_row() {
    let cache = Cache::default();
    let now = "2026-10-21T18:00:00.000Z";
    assert_eq!(import(&cache, &batch(now, true, vec![event("a", "2026-10-21")])).unwrap()["upserted"], 1);
    assert_eq!(import(&cache, &batch(now, true, vec![event("a", "2026-10-22")])).unwrap()["upserted"], 0);
    assert_eq!(cache.rows.borrow()[0]["startsAt"], "2026-10-21T17:00:00.000Z");
}

#[test]
fn two_complete_misses_make_an_event_unconfirmed_and_a_sighting_clears_it() {
    let cache = Cache::default();
    import(&cache, &batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    let first = import(&cache, &batch("2026-10-21T18:05:00.000Z", true, vec![])).unwrap();
    assert_eq!(first["unconfirmed"], 0);
    assert_eq!(cache.rows.borrow()[0]["metadata"]["mirrorMissingCount"], 1);
    let second = import(&cache, &batch("2026-10-21T18:10:00.000Z", true, vec![])).unwrap();
    assert_eq!(second["unconfirmed"], 1);
    assert_eq!(cache.rows.borrow()[0]["metadata"]["mirrorUnconfirmed"], true);
    import(&cache, &batch("2026-10-21T18:15:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    assert_eq!(cache.rows.borrow()[0]["metadata"]["mirrorUnconfirmed"], false);
}

#[test]
fn a_partial_scan_adds_events_but_marks_nothing_missing() {
    let cache = Cache::default();
    import(&cache, &batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    import(&cache, &batch("2026-10-21T18:05:00.000Z", false, vec![event("b", "2026-10-22")])).unwrap();
    let rows = cache.rows.borrow();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["metadata"]["mirrorMissingCount"], 0);
    assert_eq!(rows[1]["metadata"]["mirrorState"], "partial");
}

#[test]
fn a_different_window_restarts_the_miss_count() {
    let cache = Cache::default();
    import(&cache, &batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    import(&cache, &batch("2026-10-21T18:05:00.000Z", true, vec![])).unwrap();
    let mut shifted = batch("2026-10-21T18:10:00.000Z", true, vec![]);
    shifted["batch"]["windowStart"] = json!("2026-10-21");
    shifted["batch"]["windowEnd"] = json!("2026-11-22");
    assert_eq!(import(&cache, &shifted).unwrap()["unconfirmed"], 0);
    assert_eq!(cache.rows.borrow()[0]["metadata"]["mirrorMissingCount"], 1);
}

#[test]
fn an_older_scan_still_counts_rows_a_newer_scan_made_uncertain() {
    let cache = Cache::default();
    import(&cache, &batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    import(&cache, &batch("2026-10-21T18:10:00.000Z", true, vec![])).unwrap();
    import(&cache, &batch("2026-10-21T18:20:00.000Z", true, vec![])).unwrap();
    let late = import(&cache, &batch("2026-10-21T18:05:00.000Z", true, vec![])).unwrap();
    assert_eq!(late["unconfirmed"], 1);
}

#[test]
fn an_older_sighting_skipped_for_a_newer_scan_still_counts_that_rows_uncertainty() {
    let cache = Cache::default();
    import(&cache, &batch("2026-10-21T18:00:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    import(&cache, &batch("2026-10-21T18:10:00.000Z", true, vec![])).unwrap();
    import(&cache, &batch("2026-10-21T18:20:00.000Z", true, vec![])).unwrap();
    let late = import(&cache, &batch("2026-10-21T18:05:00.000Z", true, vec![event("a", "2026-10-21")])).unwrap();
    assert_eq!(late["unconfirmed"], 1);
}
