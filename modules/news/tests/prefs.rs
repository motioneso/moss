mod common;
use common::*;
use serde_json::json;

#[test]
fn saves_lists_and_removes_choices() {
    let f = Fake::new();
    let (status, body) = f.route("POST", "/prefs", &[], json!({"kind":"source","key":"bbc"}));
    assert_eq!(status, 200, "{body}");
    let id = body["pref"]["id"].as_str().unwrap().to_owned();
    assert_eq!(body["pref"]["kind"], "source");
    // Saving again returns the row already there.
    let (_, again) = f.route("POST", "/prefs", &[], json!({"kind":"source","key":"bbc"}));
    assert_eq!(again["pref"]["id"], id);
    assert_eq!(f.route("GET", "/prefs", &[], json!(null)).1["prefs"].as_array().unwrap().len(), 1);
    let (_, gone) = f.route("DELETE", "/prefs/:id", &[("id", &id)], json!(null));
    assert_eq!(gone, json!({"ok":true}));
    let (_, gone) = f.route("DELETE", "/prefs/:id", &[("id", &id)], json!(null));
    assert_eq!(gone, json!({"ok":false}));
}

#[test]
fn refuses_unknown_keys_and_bad_bodies() {
    let f = Fake::new();
    let (s, b) = f.route("POST", "/prefs", &[], json!({"kind":"topic","key":"nope"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Unknown topic: nope"));
    let (_, b) = f.route("POST", "/prefs", &[], json!({"kind":"source","key":"nope"}));
    assert_eq!(b["error"], "Unknown source: nope");
    let (_, b) = f.route("POST", "/prefs", &[], json!({"kind":"x","key":"a"}));
    assert_eq!(b["error"], "body/kind must be equal to one of the allowed values");
    let (_, b) = f.route("POST", "/prefs", &[], json!({"kind":"source"}));
    assert_eq!(b["error"], "body must have required property 'key'");
    let (_, b) = f.route("DELETE", "/prefs/:id", &[("id", "nope")], json!(null));
    assert_eq!(b["error"], "params/id must match format \"uuid\"");
}

#[test]
fn another_person_sees_and_removes_nothing() {
    let f = Fake::new();
    let (_, mine) = f.route("POST", "/prefs", &[], json!({"kind":"source","key":"bbc"}));
    let id = mine["pref"]["id"].as_str().unwrap().to_owned();
    f.as_actor(B);
    assert_eq!(f.route("GET", "/prefs", &[], json!(null)).1["prefs"], json!([]));
    assert_eq!(f.route("DELETE", "/prefs/:id", &[("id", &id)], json!(null)).1, json!({"ok":false}));
    f.as_actor(A);
    assert_eq!(f.route("GET", "/prefs", &[], json!(null)).1["prefs"].as_array().unwrap().len(), 1);
}

#[test]
fn excluding_a_catalog_source_removes_its_articles_from_the_saved_feed() {
    let f = Fake::new();
    let homepage = moss_news_module::catalog::SOURCES[0].homepage_url;
    let host = moss_news_module::domain::host_of(homepage).unwrap();
    f.seed(
        "app.news_compilation_snapshots",
        A,
        json!({"payload":{"articles":[
            {"canonicalDomain":host,"title":"a"},
            {"canonicalDomain":format!("x.{host}"),"title":"b"},
            {"canonicalDomain":"other.example","title":"c"}]}}),
    );
    let key = moss_news_module::catalog::SOURCES[0].key;
    f.route("POST", "/prefs", &[], json!({"kind":"source_exclude","key":key}));
    let snapshot = f.rows("app.news_compilation_snapshots");
    assert_eq!(snapshot[0]["payload"]["articles"].as_array().unwrap().len(), 1);
}

#[test]
fn catalog_lists_sources_and_topics() {
    let f = Fake::new();
    let (s, b) = f.route("GET", "/catalog", &[], json!(null));
    assert_eq!(s, 200);
    assert_eq!(b["sources"].as_array().unwrap().len(), 9);
    assert_eq!(b["topics"].as_array().unwrap().len(), 8);
}

#[test]
fn unknown_routes_and_failures_have_fixed_answers() {
    let f = Fake::new();
    assert_eq!(f.route("GET", "/nope", &[], json!(null)), (404, json!({"message":"Route not found"})));
    *f.db_failure.borrow_mut() = Some("boom".into());
    assert_eq!(f.route("GET", "/prefs", &[], json!(null)), (500, json!({"message":"Internal server error"})));
}
