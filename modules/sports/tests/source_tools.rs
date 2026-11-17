mod common;
use common::sources::*;
use moss_sports_module::{source_approval, source_tools, teams::Unavailable};
use serde_json::{json, Value};

const HOME: &str = "<html><head><title>Example Daily</title>\
    <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head><body></body></html>";
const FEED: &str = "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Example</title>\
    <item><title>Alpha wins</title><link>https://news.example.com/1</link></item></channel></rss>";

fn site(f: &Src) {
    f.page("https://news.example.com/", "text/html", HOME);
    f.page("https://news.example.com/feed.xml", "application/rss+xml", FEED);
}

fn call(f: &Src, tool: &str, parameters: Value, version: Option<&str>) -> Value {
    let payload = json!({"tool":tool,"parameters":parameters,"approvalVersion":version});
    source_tools::run(f, &Unavailable, &payload.to_string()).unwrap()
}

fn card(f: &Src, tool: &str, input: &Value) -> Value {
    source_approval::prepare(f, &Unavailable, tool, &input.to_string())
}

fn confirm_input(shown: &Value) -> Value {
    let c = &shown["candidate"];
    json!({
        "confirmationId": shown["confirmationId"],
        "authorizationAcknowledgement": shown["authorizationAcknowledgement"],
        "canonicalDomain": c["canonicalDomain"],
        "confirmedFetchHosts": c["confirmedFetchHosts"],
        "targets": c["targets"].as_array().unwrap().iter().map(|t| json!({"target":t["target"],"targetUrl":t["targetUrl"]})).collect::<Vec<_>>(),
    })
}

fn saved(f: &Src) -> String {
    f.rows(SOURCES)[0]["id"].as_str().unwrap().to_owned()
}

#[test]
fn reads_run_without_an_approval_and_match_the_routes() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None);
    assert_eq!(shown["data"]["status"], "ok", "{shown}");
    assert_eq!(shown["data"]["candidate"]["label"], "Example Daily");
    let (_, via_route) = f.route("GET", "/sources", &[], Value::Null);
    assert_eq!(call(&f, "sports.listSources", json!({}), None)["data"]["sources"], via_route["sources"]);
}

#[test]
fn a_new_source_card_comes_from_the_stored_preview_and_the_save_needs_its_version() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None)["data"].clone();
    let input = confirm_input(&shown);
    let made = card(&f, "sports.confirmSource", &input);
    let c = &made["ok"];
    assert_eq!(c["title"], "Add sports news source", "{made}");
    let fields = c["fields"].to_string();
    assert!(fields.contains("Example Daily") && fields.contains("news.example.com") && fields.contains("Coverage"), "{fields}");
    // No approval, a wrong approval and a card for other details all leave the source unsaved.
    assert!(call(&f, "sports.confirmSource", input.clone(), None)["data"]["error"].as_str().unwrap().contains("approval no longer matches"));
    assert!(call(&f, "sports.confirmSource", input.clone(), Some("nope"))["data"]["error"].is_string());
    assert!(f.rows(SOURCES).is_empty());
    let version = c["version"].as_str().unwrap();
    let done = call(&f, "sports.confirmSource", input.clone(), Some(version));
    assert_eq!(done["data"]["source"]["feedUrl"], "https://news.example.com/feed.xml", "{done}");
    assert_eq!(f.rows(SOURCES).len(), 1);
    // The preview was used up, so no card can be made again.
    assert_eq!(card(&f, "sports.confirmSource", &input)["ok"], Value::Null);
}

#[test]
fn a_card_that_does_not_match_the_preview_is_not_made() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None)["data"].clone();
    let mut input = confirm_input(&shown);
    input["canonicalDomain"] = json!("elsewhere.example.org");
    assert_eq!(card(&f, "sports.confirmSource", &input)["ok"], Value::Null);
    let mut extra = confirm_input(&shown);
    extra["more"] = json!(1);
    assert_eq!(card(&f, "sports.confirmSource", &extra)["ok"], Value::Null);
    assert_eq!(card(&f, "sports.nothing", &json!({}))["error"]["statusCode"], 400);
}

#[test]
fn remove_shows_the_saved_source_and_runs_only_with_its_version() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None)["data"].clone();
    let version = card(&f, "sports.confirmSource", &confirm_input(&shown))["ok"]["version"].as_str().unwrap().to_owned();
    call(&f, "sports.confirmSource", confirm_input(&shown), Some(&version));
    let id = saved(&f);
    let input = json!({"sourceId":id});
    let made = card(&f, "sports.removeSource", &input);
    assert_eq!(made["ok"]["title"], "Remove sports news source", "{made}");
    assert!(made["ok"]["fields"].to_string().contains("Example Daily"));
    assert!(call(&f, "sports.removeSource", input.clone(), None)["data"]["error"].is_string());
    assert!(call(&f, "sports.removeSource", input.clone(), Some("old"))["data"]["error"].is_string());
    assert_eq!(f.rows(SOURCES).len(), 1, "a refused removal leaves the row");
    let version = made["ok"]["version"].as_str().unwrap();
    assert_eq!(call(&f, "sports.removeSource", input.clone(), Some(version))["data"]["removed"], true);
    assert!(f.rows(SOURCES).is_empty());
    // A source that no longer exists has no card and says so.
    assert_eq!(card(&f, "sports.removeSource", &input)["ok"], Value::Null);
}

#[test]
fn another_person_cannot_see_or_remove_a_source() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None)["data"].clone();
    let version = card(&f, "sports.confirmSource", &confirm_input(&shown))["ok"]["version"].as_str().unwrap().to_owned();
    call(&f, "sports.confirmSource", confirm_input(&shown), Some(&version));
    let id = saved(&f);
    let version = card(&f, "sports.removeSource", &json!({"sourceId":id}))["ok"]["version"].as_str().unwrap().to_owned();
    f.as_actor(B);
    let seen = call(&f, "sports.listSources", json!({}), None);
    assert_eq!(seen["data"]["sources"].as_array().unwrap().len(), 1, "only the built-in source");
    assert_eq!(card(&f, "sports.removeSource", &json!({"sourceId":id}))["ok"], Value::Null);
    let out = call(&f, "sports.removeSource", json!({"sourceId":id}), Some(&version));
    assert!(out["data"]["error"].is_string(), "{out}");
    assert_eq!(f.rows(SOURCES).len(), 1);
}

#[test]
fn coverage_is_replaced_through_a_card_and_retry_and_rebuild_run() {
    let f = Src::new();
    site(&f);
    let shown = call(&f, "sports.previewSource", json!({"url":"news.example.com"}), None)["data"].clone();
    let version = card(&f, "sports.confirmSource", &confirm_input(&shown))["ok"]["version"].as_str().unwrap().to_owned();
    call(&f, "sports.confirmSource", confirm_input(&shown), Some(&version));
    let id = saved(&f);
    let plan = call(
        &f,
        "sports.previewSourceAssignments",
        json!({"sourceId":id,"assignments":[{"target":{"kind":"sport","sportKey":"football"}}]}),
        None,
    )["data"]
        .clone();
    assert_eq!(plan["status"], "ok", "{plan}");
    let mut input = confirm_input(&plan);
    input["sourceId"] = json!(id);
    let made = card(&f, "sports.confirmSourceAssignments", &input);
    assert_eq!(made["ok"]["title"], "Change sports source coverage", "{made}");
    let version = made["ok"]["version"].as_str().unwrap();
    assert!(call(&f, "sports.confirmSourceAssignments", input.clone(), None)["data"]["error"].is_string());
    let done = call(&f, "sports.confirmSourceAssignments", input, Some(version));
    assert_eq!(done["data"]["source"]["assignments"][0]["sportKey"], "football", "{done}");

    let plan = call(&f, "sports.rebuildSourceRecipe", json!({"sourceId":id}), None)["data"].clone();
    assert_eq!(plan["status"], "ok", "{plan}");
    let mut input = confirm_input(&plan);
    input["sourceId"] = json!(id);
    let made = card(&f, "sports.confirmSourceRecipe", &input);
    assert_eq!(made["ok"]["title"], "Change sports source instructions", "{made}");
    let done = call(&f, "sports.confirmSourceRecipe", input, made["ok"]["version"].as_str());
    assert!(done["data"]["source"].is_object(), "{done}");

    let made = card(&f, "sports.retrySource", &json!({"sourceId":id}));
    assert_eq!(made["ok"]["title"], "Retry sports news source");
    let done = call(&f, "sports.retrySource", json!({"sourceId":id}), made["ok"]["version"].as_str());
    assert!(done["data"].get("error").is_none(), "{done}");
}

#[test]
fn a_tool_refuses_extra_fields_and_a_bad_source_id() {
    let f = Src::new();
    let bad = |tool: &str, input: Value| call(&f, tool, input, None)["data"]["error"].as_str().unwrap_or("").to_owned();
    assert_eq!(bad("sports.listSources", json!({"x":1})), "Invalid Sports tool input");
    assert_eq!(bad("sports.previewSource", json!({"url":"a","x":1})), "Invalid Sports tool input");
    assert!(bad("sports.removeSource", json!({"sourceId":"nope"})).contains("uuid"));
    assert_eq!(bad("sports.removeSource", json!({})), "Provide the sourceId to use.");
    assert_eq!(bad("sports.other", json!({})), "Unknown Sports tool");
    assert_eq!(
        bad("sports.removeSource", json!({"sourceId":"99999999-9999-4999-8999-999999999999"})),
        "The approval no longer matches this source. Ask again to review the current details."
    );
}

#[test]
fn text_a_person_types_into_a_tool_stays_out_of_logs_and_jobs() {
    const MARK: &str = "PLANTED-MARKER-77aa31";
    let f = Src::new();
    let marked = format!("{}.example.com", MARK.to_lowercase());
    f.page(&format!("https://{marked}/"), "text/html", &format!("<html><head><title>{MARK}</title></head></html>"));
    f.reply("no recipe");
    let out = call(&f, "sports.previewSource", json!({"url":marked}), None);
    assert_eq!(out["data"]["reason"], "unsupported", "{out}");
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "kv", "context", "fetch", "ai"].contains(&port.as_str()), "{port}");
        assert!(!(resource.contains("activity") || operation.contains("job")));
        let sink = port != "fetch" && port != "ai" && !(port == "db" && operation == "query");
        assert!(!(sink && parameters.to_string().to_lowercase().contains(&MARK.to_lowercase())), "{port}.{operation}.{resource}");
    }
}
