mod common;
use common::sources::*;
use serde_json::{json, Value};

const HOME_URL: &str = "https://news.example.com/";
const API: &str = "https://news.example.com/api/headlines";
const SEEN: &str = "RENDERED-ONLY-HEADLINE-41c7";
// The headlines are not in the page. A script would build them, so plain reading finds none.
const HIDDEN: &str = "<html><head><title>Script Daily</title></head><body><div id=\"app\"></div><script>render()</script></body></html>";

fn recipe() -> Value {
    json!({
        "version": 1, "kind": "json", "fetchHosts": ["news.example.com"], "scopes": ["sport"], "itemLimit": 10,
        "request": {"urlTemplate": API, "slots": [], "headers": {"accept": "application/json"}},
        "extraction": {"itemsPath": ["items"], "headlinePath": ["title"], "urlPath": ["url"], "normalize": ["trim"]}
    })
}

fn good() -> String {
    json!({"recipe": recipe(), "targets": [{"targetKey": "t0", "parameters": {}}]}).to_string()
}

fn site(f: &Src) {
    f.page(HOME_URL, "text/html", HIDDEN);
    f.page(API, "application/json", &json!({"items": [{"title": SEEN, "url": "https://news.example.com/a"}]}).to_string());
}

fn preview(f: &Src) -> Value {
    let body = json!({"url": "news.example.com", "assignments": [{"target": {"kind": "sport", "sportKey": "football"}}]});
    let (status, shown) = f.route("POST", "/sources/preview", &[], body);
    assert_eq!(status, 200, "{shown}");
    shown
}

fn confirm_body(shown: &Value) -> Value {
    let c = &shown["candidate"];
    json!({
        "confirmationId": shown["confirmationId"],
        "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
        "canonicalDomain": c["canonicalDomain"],
        "confirmedFetchHosts": c["confirmedFetchHosts"],
        "targets": c["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
    })
}

#[test]
fn a_page_that_hides_its_headlines_until_scripts_run_yields_a_recipe() {
    let f = Src::new();
    site(&f);
    f.render(HOME_URL, &format!("Script Daily\n{SEEN}\nBeta loses"), &[("https://news.example.com/a", SEEN)]);
    f.reply("{}");
    f.reply(&good());
    let shown = preview(&f);
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["candidate"]["retrievalMethod"], "scrape");
    assert_eq!(shown["candidate"]["sampleHeadlines"][0], SEEN);
    // One render, of the confirmed home page only.
    assert_eq!(f.rendered(), vec![(HOME_URL.to_owned(), vec!["news.example.com".to_owned()])]);
    // The first ask saw only the bare page. The second saw what the browser rendered.
    let prompts = f.prompts();
    assert_eq!(prompts.len(), 2);
    assert!(!prompts[0].contains(SEEN));
    assert!(prompts[1].contains(SEEN));
    let (status, saved) = f.route("POST", "/sources", &[], confirm_body(&shown));
    assert_eq!(status, 201, "{saved}");
    assert_eq!(f.rows(SOURCES)[0]["recipe_status"], "ready");
}

#[test]
fn with_the_browser_off_the_site_falls_back_to_unsupported_as_before() {
    for refusal in ["unsupported", "busy", "timeout", "blocked", "render_failed"] {
        let f = Src::new();
        site(&f);
        f.render_refused(HOME_URL, refusal);
        f.reply("{}");
        f.reply(&good());
        let shown = preview(&f);
        assert_eq!(shown["status"], "rejected", "{refusal}: {shown}");
        assert_eq!(shown["reason"], "unsupported", "{refusal}");
        assert_eq!(f.prompts().len(), 1, "a refused render must not cost a second model call");
        assert!(f.rows(SOURCES).is_empty());
    }
}

#[test]
fn a_host_that_grants_no_browser_falls_back_the_same_way() {
    let f = Src::new();
    site(&f);
    f.no_browser.set(true);
    f.reply("{}");
    let shown = preview(&f);
    assert_eq!((shown["status"].as_str(), shown["reason"].as_str()), (Some("rejected"), Some("unsupported")), "{shown}");
}

#[test]
fn a_blank_render_is_not_worth_a_second_ask() {
    let f = Src::new();
    site(&f);
    f.render(HOME_URL, "   ", &[]);
    f.reply("{}");
    assert_eq!(preview(&f)["reason"], "unsupported");
    assert_eq!(f.prompts().len(), 1);
}

#[test]
fn a_page_that_works_plainly_never_opens_the_browser() {
    let f = Src::new();
    f.page(HOME_URL, "text/html", "<html><head><title>Plain</title></head><body><a href=\"/s\">S</a></body></html>");
    f.page(API, "application/json", &json!({"items": [{"title": "Alpha", "url": "https://news.example.com/a"}]}).to_string());
    f.reply(&good());
    assert_eq!(preview(&f)["status"], "ok");
    assert!(f.rendered().is_empty());
}

#[test]
fn no_model_means_no_render() {
    let f = Src::new();
    site(&f);
    assert_eq!(preview(&f)["status"], "unavailable");
    assert!(f.rendered().is_empty());
}

#[test]
fn a_render_that_lands_on_another_site_is_ignored() {
    let f = Src::new();
    site(&f);
    f.renders.borrow_mut().insert(
        HOME_URL.into(),
        json!({"ok":true,"requestId":"r","finalUrl":"https://evil.example.org/","title":"T","text":SEEN,"candidates":[],"requests":1}),
    );
    f.reply("{}");
    assert_eq!(preview(&f)["reason"], "unsupported");
    assert_eq!(f.prompts().len(), 1);
}

#[test]
fn links_to_other_sites_never_reach_the_model() {
    let f = Src::new();
    site(&f);
    f.render(HOME_URL, SEEN, &[("https://news.example.com/a", "Inside link"), ("https://evil.example.org/x", "Outside link")]);
    f.reply("{}");
    f.reply(&good());
    preview(&f);
    let second = &f.prompts()[1];
    assert!(second.contains("Inside link"));
    assert!(!second.contains("Outside link") && !second.contains("evil.example.org"));
}

#[test]
fn a_reply_that_names_a_new_host_is_still_refused_after_a_render() {
    let f = Src::new();
    site(&f);
    f.render(HOME_URL, SEEN, &[]);
    let mut other = recipe();
    other["fetchHosts"] = json!(["evil.example.org"]);
    other["request"]["urlTemplate"] = json!("https://evil.example.org/api/headlines");
    f.page("https://evil.example.org/api/headlines", "application/json", &json!({"items": [{"title": "Sneaky"}]}).to_string());
    f.reply("{}");
    f.reply(&json!({"recipe": other, "targets": [{"targetKey": "t0", "parameters": {}}]}).to_string());
    assert_eq!(preview(&f)["status"], "rejected");
    assert!(!f.fetched().iter().any(|u| u.contains("evil.example.org")));
}

#[test]
fn a_rebuild_preview_renders_too_and_a_retry_never_does() {
    let f = Src::new();
    f.page(HOME_URL, "text/html", "<html><head><title>Plain</title></head><body><a href=\"/s\">S</a></body></html>");
    f.page(API, "application/json", &json!({"items": [{"title": "Alpha", "url": "https://news.example.com/a"}]}).to_string());
    f.reply(&good());
    let first = preview(&f);
    let (status, saved) = f.route("POST", "/sources", &[], confirm_body(&first));
    assert_eq!(status, 201, "{saved}");
    let id = saved["source"]["id"].as_str().unwrap().to_owned();
    f.calls.borrow_mut().clear();
    f.route("POST", "/sources/:id/retry", &[("id", &id)], Value::Null);
    assert!(f.rendered().is_empty(), "a refresh never renders");
    // The site later moves behind scripts, so a rebuild needs the browser.
    f.page(HOME_URL, "text/html", HIDDEN);
    f.render(HOME_URL, SEEN, &[]);
    f.reply("{}");
    f.reply(&good());
    let (status, shown) = f.route("POST", "/sources/:id/rebuild/preview", &[("id", &id)], Value::Null);
    assert_eq!((status, shown["status"].as_str()), (200, Some("ok")), "{shown}");
    assert_eq!(f.rendered().len(), 1);
}

#[test]
fn rendered_text_stays_out_of_rows_other_people_and_every_other_port() {
    const MARK: &str = "PLANTED-RENDER-MARKER-5b08";
    let f = Src::new();
    f.page(HOME_URL, "text/html", HIDDEN);
    f.page(API, "application/json", &json!({"items": [{"title": "Alpha", "url": "https://news.example.com/a"}]}).to_string());
    f.render(HOME_URL, MARK, &[("https://news.example.com/a", MARK)]);
    f.reply("{}");
    f.reply(&good());
    let shown = preview(&f);
    let (status, _) = f.route("POST", "/sources", &[], confirm_body(&shown));
    assert_eq!(status, 201);
    for (table, rows) in f.tables.borrow().iter() {
        assert!(!rows.iter().any(|r| r.to_string().contains(MARK)), "{table}");
    }
    assert!(!f.files.borrow().values().any(|v| v.to_string().contains(MARK)), "saved settings hold rendered text");
    f.as_actor(B);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert!(!list.to_string().contains(MARK));
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "kv", "context", "fetch", "ai", "browser"].contains(&port.as_str()), "{port}");
        let sink = port != "ai" && !(port == "db" && operation == "query");
        assert!(!(sink && parameters.to_string().contains(MARK)), "{port}.{operation}.{resource}");
    }
}
