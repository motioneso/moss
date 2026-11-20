//! Part 7: chat tools, briefing evidence, picture and icon routes, approval cards.
mod common;
use common::*;
use moss_module_sdk::RouteRequest;
use serde_json::{json, Value};

const MARK: &str = "PLANTED-MARKER-7d20e1";
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHdrYoQAAAABJRU5ErkJggg==";
const ICO_B64: &str = "AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAA";

fn article(n: u32, image: Option<&str>) -> Value {
    json!({
        "id": format!("a{n}"), "publisher": "Daily", "canonicalDomain": "daily.example.com",
        "headline": format!("Story {n}"), "url": format!("https://daily.example.com/{n}"),
        "publishedAt": "2026-11-06T18:00:00.000Z", "excerpt": "  Some   words\n here ", "imageUrl": image,
        "preferred": false, "rank": n, "topics": [],
    })
}

fn store_page(f: &Fake, owner: &str, articles: Vec<Value>, expires: &str) {
    f.seed("app.news_compilation_snapshots", owner, json!({"payload": {"articles": articles}, "expires_at": expires}));
}

fn tool(f: &Fake, name: &str, parameters: Value) -> moss_module_sdk::Result<Value> {
    let payload = json!({"tool": name, "parameters": parameters}).to_string();
    moss_news_module::handle(f, "tool", &payload).map(|text| serde_json::from_str(&text).unwrap())
}

fn call_api(f: &Fake, name: &str, parameters: Value) -> Value {
    let payload = json!({"name": name, "parameters": parameters}).to_string();
    serde_json::from_str(&moss_news_module::handle(f, "api", &payload).unwrap()).unwrap()
}

fn image_route(f: &Fake, path: &str, key: &str, value: &str) -> moss_module_sdk::Response {
    let request = RouteRequest {
        method: "GET".into(),
        path: path.into(),
        params: [(key.to_owned(), value.to_owned())].into_iter().collect(),
        query: Default::default(),
        body: Value::Null,
    };
    moss_news_module::route(f, request)
}

const FUTURE: &str = "2099-01-01T00:00:00.000+00:00";

#[test]
fn top_headlines_read_the_stored_page_and_never_fetch() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, None), article(2, Some("https://img.example.com/2.png"))], FUTURE);
    let out = tool(&f, "news.topHeadlinesToday", json!({})).unwrap();
    assert_eq!(out["data"]["facts"][0], json!("Story 1 \u{2014} Daily"));
    let stories = out["data"]["evidence"]["stories"].as_array().unwrap();
    assert_eq!(stories.len(), 2);
    assert_eq!(stories[0]["summary"], json!("Some words here"));
    assert!(f.fetched().is_empty());
    assert_eq!(call_api(&f, "newsTopHeadlinesToday", json!({}))["facts"].as_array().unwrap().len(), 2);
}

#[test]
fn heartbeat_reports_freshness_and_refuses_extra_keys() {
    let f = Fake::new();
    let none = tool(&f, "news.heartbeatHeadlines", json!({})).unwrap();
    assert_eq!(none["data"]["freshness"], json!("unknown"));
    assert_eq!(none["data"]["items"], json!([]));
    store_page(&f, A, vec![article(1, None)], "2020-01-01T00:00:00.000+00:00");
    assert_eq!(tool(&f, "news.heartbeatHeadlines", json!({})).unwrap()["data"]["freshness"], json!("stale"));
    f.tables.borrow_mut().clear();
    store_page(&f, A, vec![article(1, None), article(2, None)], FUTURE);
    let fresh = tool(&f, "news.heartbeatHeadlines", json!({"limit": 1})).unwrap();
    assert_eq!(fresh["data"]["freshness"], json!("fresh"));
    assert_eq!(fresh["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(fresh["data"]["truncated"], json!(true));
    assert_eq!(fresh["data"]["items"][0]["entityKey"], json!("story:a1"));
    assert!(tool(&f, "news.heartbeatHeadlines", json!({"userId": A})).is_err());
    assert!(tool(&f, "news.heartbeatHeadlines", json!({"limit": 0})).is_err());
    assert!(tool(&f, "news.heartbeatHeadlines", json!({"limit": 21})).is_err());
}

#[test]
fn another_person_never_sees_my_stories_sources_or_pictures() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, Some("https://img.example.com/1.png"))], FUTURE);
    f.seed("app.news_custom_sources", A, json!({"label": "Mine", "canonical_domain": "mine.example.com", "health_status": "healthy"}));
    f.as_actor(B);
    assert_eq!(tool(&f, "news.topHeadlinesToday", json!({})).unwrap()["data"]["facts"], json!([]));
    assert_eq!(tool(&f, "news.credentialedSourceStatus", json!({})).unwrap()["data"]["sources"], json!([]));
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "a1").status, 404);
    assert!(f.fetched().is_empty());
    f.as_actor(A);
    assert_eq!(tool(&f, "news.topHeadlinesToday", json!({})).unwrap()["data"]["facts"].as_array().unwrap().len(), 1);
}

#[test]
fn credential_status_reports_only_a_state_never_a_secret() {
    let f = Fake::new();
    let id = f.seed("app.news_custom_sources", A, json!({"label": "Paywalled", "canonical_domain": "pay.example.com", "health_status": "auth_required"}));
    f.seed("app.news_source_credentials", A, json!({"source_id": id, "status": "configured", "ciphertext": MARK}));
    let out = tool(&f, "news.credentialedSourceStatus", json!({})).unwrap();
    assert_eq!(out["data"]["sources"][0]["credentialStatus"], json!("configured"));
    assert!(!out.to_string().contains(MARK));
}

#[test]
fn picture_route_serves_only_checked_pictures_of_stored_stories() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, Some("https://img.example.com/1.png")), article(2, None)], FUTURE);
    f.page("https://img.example.com/1.png", 200, "image/png", PNG_B64);
    let ok = image_route(&f, "/images/:article_id", "article_id", "a1");
    assert_eq!(ok.status, 200);
    let image = ok.image.expect("a picture");
    assert_eq!(image.content_type, "image/png");
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "a2").status, 404);
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "nope").status, 404);
    // A page that says png but holds other bytes is refused.
    f.page("https://img.example.com/1.png", 200, "image/png", "aGVsbG8gd29ybGQ=");
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "a1").status, 502);
    // A type outside the list is refused.
    f.page("https://img.example.com/1.png", 200, "image/svg+xml", PNG_B64);
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "a1").status, 502);
}

#[test]
fn icon_route_needs_a_publisher_the_person_already_sees() {
    let f = Fake::new();
    f.seed("app.news_custom_sources", A, json!({"label": "Daily", "canonical_domain": "daily.example.com", "health_status": "healthy"}));
    f.page("https://daily.example.com/favicon.ico", 200, "image/x-icon", ICO_B64);
    let ok = image_route(&f, "/favicon/:domain", "domain", "daily.example.com");
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    assert_eq!(ok.image.unwrap().content_type, "image/x-icon");
    assert_eq!(image_route(&f, "/favicon/:domain", "domain", "other.example.com").status, 404);
    assert_eq!(image_route(&f, "/favicon/:domain", "domain", "not a host").status, 404);
    f.as_actor(B);
    assert_eq!(image_route(&f, "/favicon/:domain", "domain", "daily.example.com").status, 404);
}

#[test]
fn refresh_card_is_built_from_the_stored_record_and_refuses_extra_input() {
    let f = Fake::new();
    let card = call_api(&f, "prepareNewsAction", json!({"tool": "news.refreshNews", "inputJson": "{}"}));
    assert_eq!(card["ok"]["title"], json!("Refresh news"));
    assert_eq!(card["ok"]["target"], json!("Your news feed"));
    let extra = call_api(&f, "prepareNewsAction", json!({"tool": "news.refreshNews", "inputJson": "{\"x\":1}"}));
    assert_eq!(extra["ok"], Value::Null);
    store_page(&f, A, vec![article(1, Some("https://img.example.com/1.png"))], FUTURE);
    let route = call_api(&f, "prepareNewsRoute", json!({"route": "newsImage", "paramsJson": "{\"article_id\":\"a1\"}", "queryJson": "{}", "bodyJson": "{}"}));
    assert_eq!(route["ok"]["target"], json!("Story 1"));
    assert_eq!(route["ok"]["content"], json!("outside"));
    f.as_actor(B);
    let other = call_api(&f, "prepareNewsRoute", json!({"route": "newsImage", "paramsJson": "{\"article_id\":\"a1\"}", "queryJson": "{}", "bodyJson": "{}"}));
    assert_eq!(other["ok"], Value::Null);
}

#[test]
fn refresh_tool_queues_one_job_with_no_private_text() {
    let f = Fake::new();
    f.seed("app.news_custom_sources", A, json!({"label": MARK, "canonical_domain": "daily.example.com", "health_status": "healthy"}));
    let out = tool(&f, "news.refreshNews", json!({})).unwrap();
    assert_eq!(out["data"]["asynchronous"], json!(true));
    assert!(tool(&f, "news.refreshNews", json!({"x": 1})).is_err());
    assert_eq!(f.open_jobs("news-refresh"), 1);
    assert!(f.jobs.borrow().iter().all(|(_, _, _, p)| !p.to_string().contains(MARK)));
}

#[test]
fn private_text_stays_out_of_reads_logs_jobs_and_activity_rows() {
    let f = Fake::new();
    let mut page = article(1, Some("https://img.example.com/1.png"));
    page["headline"] = json!(MARK);
    store_page(&f, A, vec![page], FUTURE);
    f.page("https://img.example.com/1.png", 200, "image/png", PNG_B64);
    tool(&f, "news.heartbeatHeadlines", json!({})).unwrap();
    tool(&f, "news.refreshNews", json!({})).unwrap();
    image_route(&f, "/images/:article_id", "article_id", "a1");
    call_api(&f, "prepareNewsRoute", json!({"route": "newsImage", "paramsJson": "{\"article_id\":\"a1\"}", "queryJson": "{}", "bodyJson": "{}"}));
    let calls = f.calls.borrow();
    for (port, _, resource, parameters) in calls.iter() {
        if port == "jobs" || resource.contains("activity") || resource.contains("log") {
            assert!(!parameters.to_string().contains(MARK), "{port} {resource}");
        }
    }
    assert!(f.jobs.borrow().iter().all(|(_, _, _, p)| !p.to_string().contains(MARK)));
    assert!(f.notices.borrow().iter().all(|(_, p)| !p.to_string().contains(MARK)));
}

fn mark(f: &Fake, story: &str, kind: &str, reason: Option<&str>) -> (u16, Value) {
    f.route("POST", "/story-feedback", &[], json!({"storyRef": story, "kind": kind, "reason": reason}))
}

fn heads(f: &Fake) -> Vec<String> {
    let out = tool(f, "news.topHeadlinesToday", json!({})).unwrap();
    out["data"]["evidence"]["stories"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn story_feedback_marks_lists_changes_and_undoes() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, None), article(2, None)], FUTURE);
    let (status, body) = mark(&f, "a1", "less_like_this", Some("  too much  "));
    assert_eq!(status, 200);
    assert_eq!(body["feedback"]["reason"], json!("too much"));
    let id = body["feedback"]["id"].as_str().unwrap().to_owned();
    // A repeat replaces the earlier choice.
    let (_, again) = mark(&f, "a1", "more_like_this", None);
    assert_eq!(again["feedback"]["id"], json!(id));
    assert_eq!(again["feedback"]["kind"], json!("more_like_this"));
    assert_eq!(f.rows("app.news_story_feedback").len(), 1);
    assert_eq!(f.route("GET", "/story-feedback", &[], Value::Null).1["feedback"].as_array().unwrap().len(), 1);
    let (status, changed) = f.route("PATCH", "/story-feedback/:id", &[("id", &id)], json!({"reason": "later"}));
    assert_eq!((status, changed["feedback"]["reason"].clone()), (200, json!("later")));
    assert_eq!(f.route("POST", "/story-feedback/:id/undo", &[("id", &id)], Value::Null).0, 200);
    assert_eq!(f.route("POST", "/story-feedback/:id/undo", &[("id", &id)], Value::Null).0, 404);
    assert!(f.rows("app.news_story_feedback").is_empty());
}

#[test]
fn story_feedback_refuses_bad_input() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, None)], FUTURE);
    assert_eq!(mark(&f, "nope", "less_like_this", None).0, 404);
    assert_eq!(mark(&f, "a1", "sideways", None).0, 400);
    assert_eq!(mark(&f, "", "less_like_this", None).0, 400);
    assert_eq!(mark(&f, "a1", "less_like_this", Some(&"x".repeat(501))).0, 400);
    assert!(f.rows("app.news_story_feedback").is_empty());
}

#[test]
fn a_story_marked_less_is_hidden_from_every_read_until_undone() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, Some("https://img.example.com/1.png")), article(2, None)], FUTURE);
    f.page("https://img.example.com/1.png", 200, "image/png", PNG_B64);
    assert_eq!(heads(&f), vec!["a1", "a2"]);
    assert_eq!(image_route(&f, "/images/:article_id", "article_id", "a1").status, 200, "the picture loads before the mark");
    let id = mark(&f, "a1", "less_like_this", None).1["feedback"]["id"].as_str().unwrap().to_owned();
    assert_eq!(heads(&f), vec!["a2"]);
    let beat = tool(&f, "news.heartbeatHeadlines", json!({})).unwrap();
    assert_eq!(beat["data"]["items"].as_array().unwrap().len(), 1);
    let hidden_pic = |f: &Fake| image_route(f, "/images/:article_id", "article_id", "a1").status;
    assert_eq!(hidden_pic(&f), 404, "a hidden story serves no picture");
    f.route("POST", "/story-feedback/:id/undo", &[("id", &id)], Value::Null);
    assert_eq!(heads(&f), vec!["a1", "a2"]);
}

#[test]
fn another_person_gets_none_of_my_story_feedback() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, None)], FUTURE);
    store_page(&f, B, vec![article(1, None)], FUTURE);
    let id = mark(&f, "a1", "less_like_this", Some(MARK)).1["feedback"]["id"].as_str().unwrap().to_owned();
    f.as_actor(B);
    assert_eq!(f.route("GET", "/story-feedback", &[], Value::Null).1["feedback"], json!([]));
    assert_eq!(heads(&f), vec!["a1"]);
    assert_eq!(f.route("PATCH", "/story-feedback/:id", &[("id", &id)], json!({"reason": "x"})).0, 404);
    assert_eq!(f.route("POST", "/story-feedback/:id/undo", &[("id", &id)], Value::Null).0, 404);
    f.as_actor(A);
    assert_eq!(f.rows("app.news_story_feedback").len(), 1);
    assert_eq!(heads(&f), Vec::<String>::new());
}

#[test]
fn story_feedback_reason_stays_out_of_jobs_and_notices() {
    let f = Fake::new();
    store_page(&f, A, vec![article(1, None)], FUTURE);
    mark(&f, "a1", "less_like_this", Some(MARK));
    tool(&f, "news.refreshNews", json!({})).unwrap();
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        if port == "jobs" || port == "notify" || resource.contains("log") {
            assert!(!parameters.to_string().contains(MARK), "{port} {resource}");
        }
    }
    assert!(f.jobs.borrow().iter().all(|(_, _, _, p)| !p.to_string().contains(MARK)));
    assert!(f.notices.borrow().iter().all(|(_, p)| !p.to_string().contains(MARK)));
}

#[test]
fn chat_card_adapter_uses_the_refresh_card_and_empty_input() {
    let f = Fake::new();
    let card = call_api(&f, "prepareChatAction", json!({"tool":"news.refreshNews","parameters":{}}));
    assert_eq!(card, json!({"title":"Refresh news","content":"user_authored","target":"Your news feed","fields":[],"version":"[]"}));
    for input in [
        json!({"tool":"news.refreshNews","parameters":{"source":"PLANTED"}}),
        json!({"tool":"news.topHeadlinesToday","parameters":{}}),
        json!({"tool":"news.refreshNews","parameters":null}),
    ] {
        assert!(call_api(&f, "prepareChatAction", input).is_null());
    }
    assert!(f.fetched().is_empty());
}
