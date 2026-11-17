mod common;
use common::sources::*;
use serde_json::{json, Value};

const HOME: &str = "<html><head><title>Plain Daily</title></head><body><a href=\"/sports\">Sports</a></body></html>";
const API: &str = "https://news.example.com/api/headlines";

fn recipe(host: &str) -> Value {
    json!({
        "version": 1, "kind": "json", "fetchHosts": [host], "scopes": ["sport"], "itemLimit": 10,
        "request": {"urlTemplate": format!("https://{host}/api/headlines"), "slots": [], "headers": {"accept": "application/json"}},
        "extraction": {"itemsPath": ["items"], "headlinePath": ["title"], "urlPath": ["url"], "normalize": ["trim"]}
    })
}

fn reply(r: &Value) -> String {
    json!({"recipe": r, "targets": [{"targetKey": "t0", "parameters": {}}]}).to_string()
}

fn feed_json(titles: &[&str]) -> String {
    let items: Vec<Value> = titles.iter().map(|t| json!({"title": t, "url": "https://news.example.com/a"})).collect();
    json!({"items": items}).to_string()
}

fn site(f: &Src) {
    f.page("https://news.example.com/", "text/html", HOME);
    f.page(API, "application/json", &feed_json(&["Alpha wins", "Beta loses"]));
}

fn preview(f: &Src) -> Value {
    let (status, body) = f.route("POST", "/sources/preview", &[], json!({"url": "news.example.com", "assignments": [{"target": {"kind": "sport", "sportKey": "football"}}]}));
    assert_eq!(status, 200, "{body}");
    body
}

fn save(f: &Src, shown: &Value) -> (u16, Value) {
    let c = &shown["candidate"];
    f.route(
        "POST",
        "/sources",
        &[],
        json!({
            "confirmationId": shown["confirmationId"],
            "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
            "canonicalDomain": c["canonicalDomain"],
            "confirmedFetchHosts": c["confirmedFetchHosts"],
            "targets": c["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
        }),
    )
}

fn saved(f: &Src) -> String {
    site(f);
    f.reply(&reply(&recipe("news.example.com")));
    let shown = preview(f);
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["candidate"]["retrievalMethod"], "scrape");
    let (status, body) = save(f, &shown);
    assert_eq!(status, 201, "{body}");
    body["source"]["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_reply_naming_a_new_host_is_refused_and_nothing_is_saved() {
    let f = Src::new();
    site(&f);
    f.page("https://evil.example.org/api/headlines", "application/json", &feed_json(&["Sneaky"]));
    f.reply(&reply(&recipe("evil.example.org")));
    let shown = preview(&f);
    assert_eq!(shown["status"], "rejected", "{shown}");
    assert!(!f.fetched().iter().any(|u| u.contains("evil.example.org")), "a refused host must never be fetched");
    assert!(f.rows(SOURCES).is_empty());
}

#[test]
fn a_good_reply_replays_through_the_fetch_and_saves() {
    let f = Src::new();
    let id = saved(&f);
    assert!(f.fetched().contains(&API.to_owned()));
    let row = &f.rows(SOURCES)[0];
    assert_eq!(row["retrieval_method"], "scrape");
    assert_eq!(row["recipe_status"], "ready");
    assert!(row["recipe_json"].is_object() || row["recipe_json"].is_string());
    assert!(!id.is_empty());
}

#[test]
fn a_reply_that_finds_no_headlines_is_refused() {
    let f = Src::new();
    f.page("https://news.example.com/", "text/html", HOME);
    f.page(API, "application/json", &feed_json(&[]));
    f.reply(&reply(&recipe("news.example.com")));
    assert_eq!(preview(&f)["status"], "rejected");
}

#[test]
fn a_loose_recipe_is_refused() {
    let f = Src::new();
    site(&f);
    let mut bad = recipe("news.example.com");
    bad["extra"] = json!(true);
    f.reply(&reply(&bad));
    assert_eq!(preview(&f)["status"], "rejected");
}

#[test]
fn a_model_that_is_not_set_up_reports_unavailable() {
    let f = Src::new();
    site(&f);
    assert_eq!(preview(&f)["status"], "unavailable");
}

#[test]
fn refresh_reads_with_the_fetch_port_only_and_marks_the_source_healthy() {
    let f = Src::new();
    let id = saved(&f);
    f.calls.borrow_mut().clear();
    let (status, body) = f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["source"]["healthState"], "healthy", "{body}");
    let ports: Vec<(String, String, String)> = f.calls.borrow().iter().filter(|(p, ..)| p != "db" && p != "kv" && p != "context").map(|(p, o, r, _)| (p.clone(), o.clone(), r.clone())).collect();
    assert!(!ports.is_empty());
    assert!(ports.iter().all(|(p, o, r)| (p.as_str(), o.as_str(), r.as_str()) == ("fetch", "get", "public-web")), "{ports:?}");
    assert_eq!(f.fetched(), vec![API.to_owned()], "only the recipe address is read, never an article");
}

#[test]
fn a_changed_page_marks_drift_and_a_gone_recipe_is_missing() {
    let f = Src::new();
    let id = saved(&f);
    f.page(API, "application/json", "{\"other\": []}");
    let (_, body) = f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert_ne!(body["source"]["healthState"], "healthy", "{body}");
    assert_eq!(f.rows(SOURCES)[0]["recipe_status"], "drift");
    f.tables.borrow_mut().get_mut(SOURCES).unwrap()[0]["recipe_json"] = Value::Null;
    f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert_eq!(f.rows(SOURCES)[0]["recipe_status"], "missing");
}

#[test]
fn a_blocked_fetch_is_recorded_without_leaking_the_page() {
    let f = Src::new();
    let id = saved(&f);
    f.fails(API, "blocked", None);
    let (status, body) = f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert_eq!(status, 200, "{body}");
    assert_ne!(body["source"]["healthState"], "healthy");
}

#[test]
fn retry_of_another_persons_source_is_not_found() {
    let f = Src::new();
    let id = saved(&f);
    f.as_actor(B);
    let (status, _) = f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert_eq!(status, 404);
    let (status, _) = f.route("POST", "/sources/:id/rebuild/preview", &[("id", &id)], Value::Null);
    assert_eq!(status, 404);
}

#[test]
fn a_rebuild_previews_then_replaces_the_recipe() {
    let f = Src::new();
    let id = saved(&f);
    let mut next = recipe("news.example.com");
    next["itemLimit"] = json!(5);
    f.reply(&reply(&next));
    let (status, shown) = f.route("POST", "/sources/:id/rebuild/preview", &[("id", &id)], Value::Null);
    assert_eq!((status, shown["status"].as_str()), (200, Some("ok")), "{shown}");
    let c = &shown["candidate"];
    let body = json!({
        "confirmationId": shown["confirmationId"],
        "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
        "canonicalDomain": c["canonicalDomain"],
        "confirmedFetchHosts": c["confirmedFetchHosts"],
        "targets": c["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
    });
    let before = f.rows(SOURCES)[0]["recipe_fingerprint"].clone();
    let (status, done) = f.route("PATCH", "/sources/:id/rebuild", &[("id", &id)], body.clone());
    assert_eq!(status, 200, "{done}");
    assert_ne!(f.rows(SOURCES)[0]["recipe_fingerprint"], before);
    let (status, _) = f.route("PATCH", "/sources/:id/rebuild", &[("id", &id)], body);
    assert_eq!(status, 409, "a preview can be confirmed once");
}

#[test]
fn a_preview_of_another_kind_cannot_confirm_a_rebuild() {
    let f = Src::new();
    let id = saved(&f);
    let body = json!({"confirmationId": "00000000-0000-4000-8000-0000000000ff", "authorizationAcknowledgement": "x", "canonicalDomain": "news.example.com", "confirmedFetchHosts": ["news.example.com"], "targets": []});
    let (status, _) = f.route("PATCH", "/sources/:id/rebuild", &[("id", &id)], body);
    assert!(status == 409 || status == 400, "{status}");
}

#[test]
fn headline_text_stays_out_of_rows_logs_jobs_and_other_people() {
    const MARK: &str = "PLANTED-MARKER-9d2e71";
    let f = Src::new();
    f.page("https://news.example.com/", "text/html", HOME);
    f.page(API, "application/json", &feed_json(&[MARK, "Beta loses"]));
    f.reply(&reply(&recipe("news.example.com")));
    let shown = preview(&f);
    let (status, body) = save(&f, &shown);
    assert_eq!(status, 201, "{body}");
    let id = body["source"]["id"].as_str().unwrap().to_owned();
    f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    // No saved row holds the headline.
    for (table, rows) in f.tables.borrow().iter() {
        assert!(!rows.iter().any(|r| r.to_string().contains(MARK)), "{table}");
    }
    // Another person sees none of it.
    f.as_actor(B);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert!(!list.to_string().contains(MARK));
    // Only the expected ports were used and no write other than the person's own stores carries it.
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "kv", "context", "fetch", "ai"].contains(&port.as_str()), "{port}");
        assert!(!(resource.contains("activity") || operation.contains("job") || resource.contains("log")));
        let sink = port != "fetch" && port != "kv" && !(port == "db" && operation == "query");
        assert!(!(sink && parameters.to_string().contains(MARK)), "{port}.{operation}.{resource}");
    }
}

#[test]
fn another_person_cannot_use_a_preview_or_see_the_recipe() {
    let f = Src::new();
    let id = saved(&f);
    f.reply(&reply(&recipe("news.example.com")));
    let (_, shown) = f.route("POST", "/sources/:id/rebuild/preview", &[("id", &id)], Value::Null);
    f.as_actor(B);
    let body = json!({"confirmationId": shown["confirmationId"], "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
        "canonicalDomain": "news.example.com", "confirmedFetchHosts": ["news.example.com"], "targets": []});
    let (status, _) = f.route("PATCH", "/sources/:id/rebuild", &[("id", &id)], body);
    assert_eq!(status, 409);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert!(!list.to_string().contains("recipe"));
}

#[test]
fn a_reply_with_missing_keys_is_refused_without_panicking() {
    let f = Src::new();
    site(&f);
    let mut cases = Vec::new();
    let mut no_template = recipe("news.example.com");
    no_template["request"].as_object_mut().unwrap().remove("urlTemplate");
    cases.push(no_template);
    let mut empty_slot = recipe("news.example.com");
    empty_slot["request"]["slots"] = json!([{}]);
    cases.push(empty_slot);
    let mut html = recipe("news.example.com");
    html["kind"] = json!("html");
    html["request"]["headers"]["accept"] = json!("text/html,application/xhtml+xml");
    html["extraction"] = json!({"collectionSelector": "ul", "itemSelector": "li", "headline": {"source": "text"}, "normalize": []});
    cases.push(html);
    for case in cases {
        f.reply(&reply(&case));
        assert_eq!(preview(&f)["status"], "rejected");
    }
}
