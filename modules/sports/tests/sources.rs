mod common;
use common::sources::*;
use serde_json::{json, Value};

fn rss(titles: &[&str]) -> String {
    let items: String = titles
        .iter()
        .map(|t| format!("<item><title>{t}</title><link>https://news.example.com/{}</link></item>", t.len()))
        .collect();
    format!("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Example</title>{items}</channel></rss>")
}

const HOME: &str = "<html><head><title>Example Daily</title>\
    <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head><body></body></html>";

fn site(f: &Src) {
    f.page("https://news.example.com/", "text/html", HOME);
    f.page("https://news.example.com/feed.xml", "application/rss+xml", &rss(&["Alpha wins", "Beta loses"]));
}

fn subreddit_feed(name: &str) -> String {
    let entry = |t: &str| {
        format!(
            "<entry><content type=\"html\">&lt;a href=\"https://www.espn.com/story\"&gt;[link]&lt;/a&gt;</content>\
             <id>t3_{t}</id><title>{t}</title><published>2025-09-04T14:13:20+00:00</published></entry>"
        )
    };
    format!(
        "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><category term=\"{name}\" label=\"r/{name}\"/>\
         <title>{name}</title>{}{}</feed>",
        entry("Game one"),
        entry("Game two")
    )
}

fn reddit(f: &Src, name: &str) {
    f.page(&format!("https://www.reddit.com/r/{name}/hot.rss"), "application/atom+xml", &subreddit_feed(name));
}

fn preview(f: &Src, url: &str) -> Value {
    let (status, body) = f.route("POST", "/sources/preview", &[], json!({"url":url}));
    assert_eq!(status, 200, "{body}");
    body
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

fn save(f: &Src, shown: &Value) -> (u16, Value) {
    f.route("POST", "/sources", &[], confirm_body(shown))
}

fn saved_reddit(f: &Src, name: &str) -> String {
    reddit(f, name);
    let shown = preview(f, &format!("r/{name}"));
    let (status, body) = save(f, &shown);
    assert_eq!(status, 201, "{body}");
    body["source"]["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_site_with_a_feed_previews_and_saves() {
    let f = Src::new();
    site(&f);
    let shown = preview(&f, "news.example.com");
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["candidate"]["retrievalMethod"], "feed");
    assert_eq!(shown["candidate"]["label"], "Example Daily");
    assert_eq!(shown["candidate"]["sampleHeadlines"], json!(["Alpha wins", "Beta loses"]));
    assert_eq!(
        shown["authorizationAcknowledgement"],
        "I confirm I am authorized to fetch this publisher's public, unauthenticated sports news."
    );
    let (status, body) = save(&f, &shown);
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["source"]["feedUrl"], "https://news.example.com/feed.xml");
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    let all = list["sources"].as_array().unwrap();
    assert_eq!((all[0]["kind"].as_str(), all[1]["kind"].as_str()), (Some("builtin"), Some("custom")));
    assert_eq!(all[1]["id"], body["source"]["id"]);
}

#[test]
fn each_failure_reason_reaches_the_preview() {
    let reason = |f: &Src, url: &str| preview(f, url)["reason"].as_str().unwrap_or("").to_owned();
    let hot = "https://www.reddit.com/r/nfl/hot.rss";
    for (kind, status, shown) in [
        ("rate_limited", None, "rate_limited"),
        ("http_error", Some(403), "auth_required"),
        ("http_error", Some(404), "not_found"),
        ("network", None, "unreachable"),
    ] {
        let f = Src::new();
        f.fails(hot, kind, status);
        assert_eq!(reason(&f, "r/nfl"), shown, "{kind} {status:?}");
    }
    assert_eq!(preview(&Src::new(), "r/a")["reason"], "invalid_input");
    assert_eq!(preview(&Src::new(), "http://news.example.com")["reason"], "not_https");
    assert_eq!(preview(&Src::new(), "not a site")["reason"], "invalid_input");
    assert_eq!(reason(&Src::new(), "news.example.com"), "unreachable");
    // A site that sends the visitor to another publisher is refused.
    let f = Src::new();
    f.moved("https://news.example.com/", "https://other.example.org/", "text/html", HOME);
    assert_eq!(reason(&f, "news.example.com"), "policy");
    // A site with no feed goes to the recipe maker; a reply that is no recipe is unsupported.
    let f = Src::new();
    f.page("https://news.example.com/", "text/html", "<html><head><title>No feed</title></head></html>");
    f.reply("I could not find one.");
    assert_eq!(reason(&f, "news.example.com"), "unsupported");
    // With no model set up the answer says so instead.
    let f = Src::new();
    f.page("https://news.example.com/", "text/html", "<html><head><title>No feed</title></head></html>");
    assert_eq!(preview(&f, "news.example.com")["status"], "unavailable");
    // A target the person no longer has, or a repeated one, is invalid input.
    let (status, body) = Src::new().route(
        "POST",
        "/sources/preview",
        &[],
        json!({"url":"news.example.com","assignments":[{"target":{"kind":"follow","followId":"99999999-9999-4999-8999-999999999999"}}]}),
    );
    assert_eq!((status, body["reason"].as_str()), (200, Some("invalid_input")));
}

#[test]
fn two_subreddits_that_differ_only_by_case_are_one_source() {
    let f = Src::new();
    saved_reddit(&f, "nfl");
    reddit(&f, "NFL");
    let shown = preview(&f, "r/NFL");
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["duplicateOfSourceId"], f.rows(SOURCES)[0]["id"]);
    let (status, body) = save(&f, &shown);
    assert_eq!((status, body["error"].as_str()), (409, Some("Source already exists")), "{body}");
    assert_eq!(f.rows(SOURCES).len(), 1);
    // A different subreddit is its own source.
    saved_reddit(&f, "nba");
    assert_eq!(f.rows(SOURCES).len(), 2);
}

#[test]
fn a_confirm_works_once_and_only_while_fresh() {
    let f = Src::new();
    site(&f);
    let shown = preview(&f, "news.example.com");
    assert_eq!(save(&f, &shown).0, 201);
    let (status, body) = save(&f, &shown);
    assert_eq!((status, body["error"].as_str()), (409, Some("Source preview expired or was not found")));
    f.route("DELETE", "/sources/:id", &[("id", f.rows(SOURCES)[0]["id"].as_str().unwrap())], Value::Null);
    let late = preview(&f, "news.example.com");
    f.advance(11 * 60 * 1000);
    assert_eq!(save(&f, &late).0, 409);
    assert!(f.rows(SOURCES).is_empty());
}

#[test]
fn a_changed_confirm_is_refused_and_a_bad_body_is_a_400() {
    let f = Src::new();
    site(&f);
    let shown = preview(&f, "news.example.com");
    let mut changed = confirm_body(&shown);
    changed["canonicalDomain"] = json!("elsewhere.example.org");
    let (status, body) = f.route("POST", "/sources", &[], changed);
    assert_eq!((status, body["error"].as_str()), (409, Some("Source preview identity changed")));
    let mut wrong = confirm_body(&preview(&f, "news.example.com"));
    wrong["authorizationAcknowledgement"] = json!("yes");
    assert_eq!(f.route("POST", "/sources", &[], wrong).0, 409);
    let (status, body) = f.route("POST", "/sources", &[], json!({"confirmationId":"x"}));
    assert_eq!((status, body["error"].as_str()), (400, Some("body must have required property 'authorizationAcknowledgement'")), "{body}");
    assert_eq!(f.route("POST", "/sources/preview", &[], json!({})).0, 400);
    assert_ne!(f.route("POST", "/sources/preview", &[], json!({"url":"x","more":1})).0, 400, "an unknown field is ignored, as the old route does");
    assert_eq!(f.route("POST", "/sources/preview", &[], json!({"url":""})).0, 400);
}

fn seed_source(f: &Src, owner: &str, domain: &str) -> String {
    let count = f.rows(SOURCES).len();
    let id = format!("00000000-0000-4000-8000-{:012x}", 5000 + count);
    f.tables.borrow_mut().entry(SOURCES.into()).or_default().push(json!({
        "id": id, "owner_user_id": owner, "label": domain, "canonical_domain": domain,
        "homepage_url": format!("https://{domain}/"), "feed_url": format!("https://{domain}/feed.xml"),
        "retrieval_method": "feed", "enabled": true, "health_state": "healthy", "recipe_status": "feed",
        "photo_rule_state": "none", "confirmed_fetch_hosts": [domain], "validation_fingerprint": "f",
        "created_at": format!("2026-11-01T10:00:{count:02}.000+00:00"),
        "updated_at": "2026-11-01T10:00:00.000+00:00",
    }));
    id
}

#[test]
fn the_limits_on_sources_and_targets_hold() {
    let f = Src::new();
    for n in 0..10 {
        seed_source(&f, A, &format!("s{n}.example.org"));
    }
    site(&f);
    let (status, body) = save(&f, &preview(&f, "news.example.com"));
    assert_eq!((status, body["error"].as_str()), (400, Some("A maximum of 10 custom sources is allowed")), "{body}");

    let g = Src::new();
    let one = seed_source(&g, A, "s.example.org");
    for n in 0..20 {
        g.tables.borrow_mut().entry(ASSIGNMENTS.into()).or_default().push(json!({
            "id": format!("00000000-0000-4000-8000-{:012x}", 9000 + n), "owner_user_id": A, "source_id": one,
            "sport_key": "soccer", "preview_status": "verified", "health_state": "healthy",
            "created_at": "2026-11-01T10:00:00.000+00:00",
        }));
    }
    site(&g);
    let (_, shown) = g.route("POST", "/sources/preview", &[], json!({"url":"news.example.com","assignments":[{"target":{"kind":"sport","sportKey":"hockey"}}]}));
    let (status, body) = save(&g, &shown);
    assert_eq!((status, body["error"].as_str()), (400, Some("A maximum of 20 source assignments is allowed")), "{body}");
}

#[test]
fn targets_are_saved_and_replaced_without_asking_the_network_again() {
    let f = Src::new();
    let follow = f.follow(A, "nba", None);
    reddit(&f, "nfl");
    let (_, shown) = f.route(
        "POST",
        "/sources/preview",
        &[],
        json!({"url":"r/nfl","assignments":[{"target":{"kind":"sport","sportKey":"football"}}]}),
    );
    let (status, saved) = save(&f, &shown);
    assert_eq!(status, 201, "{saved}");
    let id = saved["source"]["id"].as_str().unwrap().to_owned();
    assert_eq!(saved["source"]["assignments"][0]["sportKey"], "football");
    let first_row = f.rows(ASSIGNMENTS)[0]["id"].clone();
    let before = f.fetched().len();

    let wanted = json!({"assignments":[
        {"target":{"kind":"sport","sportKey":"football"}},
        {"target":{"kind":"follow","followId":follow}},
    ]});
    let (status, plan) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], wanted);
    assert_eq!(status, 200, "{plan}");
    assert_eq!(plan["status"], "ok", "{plan}");
    assert_eq!(f.fetched().len(), before, "a subreddit target needs no new fetch");
    let (status, done) = f.route("PATCH", "/sources/:id/assignments", &[("id", &id)], confirm_body(&plan));
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["source"]["assignments"].as_array().unwrap().len(), 2);
    assert_eq!(done["source"]["assignedFollowIds"], json!([follow]));
    assert!(f.rows(ASSIGNMENTS).iter().any(|r| r["id"] == first_row), "the reused row stays");

    // The same confirm cannot be used twice.
    let (status, _) = f.route("PATCH", "/sources/:id/assignments", &[("id", &id)], confirm_body(&plan));
    assert_eq!(status, 409);
}

#[test]
fn a_source_that_moved_after_the_preview_is_refused() {
    let f = Src::new();
    let id = saved_reddit(&f, "nfl");
    let body = json!({"assignments":[{"target":{"kind":"sport","sportKey":"hockey"}}]});
    let (_, plan) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], body.clone());
    // Another change lands first.
    let (_, other) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], body);
    assert_eq!(f.route("PATCH", "/sources/:id/assignments", &[("id", &id)], confirm_body(&other)).0, 200);
    let (status, refused) = f.route("PATCH", "/sources/:id/assignments", &[("id", &id)], confirm_body(&plan));
    assert_eq!((status, refused["error"].as_str()), (409, Some("Source changed after assignment preview")), "{refused}");
    // A preview made for one source does not confirm for another.
    let second = saved_reddit(&f, "nba");
    let (_, plan) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &second)], json!({"assignments":[]}));
    let (status, refused) = f.route("PATCH", "/sources/:id/assignments", &[("id", &id)], confirm_body(&plan));
    assert_eq!((status, refused["error"].as_str()), (409, Some("Assignment preview expired or was not found")));
    let missing = "99999999-9999-4999-8999-999999999999";
    let (status, body) = f.route("POST", "/sources/:id/assignments/preview", &[("id", missing)], json!({"assignments":[]}));
    assert_eq!((status, body["error"].as_str()), (404, Some("Source not found")));
    assert_eq!(f.route("POST", "/sources/:id/assignments/preview", &[("id", "nope")], json!({"assignments":[]})).0, 400);
}

#[test]
fn a_site_source_is_checked_again_and_a_changed_publisher_is_stale() {
    let f = Src::new();
    site(&f);
    let (_, shown) = f.route("POST", "/sources/preview", &[], json!({"url":"news.example.com"}));
    let (_, saved) = save(&f, &shown);
    let id = saved["source"]["id"].as_str().unwrap().to_owned();
    let before = f.fetched().len();
    let body = json!({"assignments":[{"target":{"kind":"sport","sportKey":"hockey"}}]});
    let (_, plan) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], body.clone());
    assert_eq!(plan["status"], "ok", "{plan}");
    assert!(f.fetched().len() > before, "a site source is read again");
    f.moved("https://news.example.com/feed.xml", "https://news.example.com/feed.xml", "application/rss+xml", "<html></html>");
    f.reply("no recipe");
    let (_, plan) = f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], body);
    assert_eq!(plan["status"], "rejected", "{plan}");
}

#[test]
fn espn_coverage_is_saved_validated_and_listed() {
    let f = Src::new();
    let follow = f.follow(A, "nba", None);
    let (status, body) = f.route("PUT", "/sources/espn/coverage", &[], json!({"assignments":[
        {"kind":"sport","sportKey":"soccer"},{"kind":"follow","followId":follow}]}));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["source"]["enabled"], true);
    assert_eq!(body["source"]["usesDefaultCoverage"], false);
    assert_eq!(body["source"]["assignments"].as_array().unwrap().len(), 2);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert_eq!(list["sources"][0]["assignments"].as_array().unwrap().len(), 2);
    // Saving again replaces rather than adds.
    let (_, body) = f.route("PUT", "/sources/espn/coverage", &[], json!({"assignments":[{"kind":"sport","sportKey":"hockey"}]}));
    assert_eq!(body["source"]["assignments"], json!([{"kind":"sport","sportKey":"hockey"}]));
    assert_eq!(f.rows(COVERAGE).len(), 1);
    // An empty list turns ESPN headlines off.
    let (_, body) = f.route("PUT", "/sources/espn/coverage", &[], json!({"assignments":[]}));
    assert_eq!((body["source"]["enabled"].clone(), body["source"]["usesDefaultCoverage"].clone()), (json!(false), json!(false)));
    let g = Src::new();
    let (_, fresh) = g.route("GET", "/sources", &[], Value::Null);
    assert_eq!(fresh["sources"][0]["usesDefaultCoverage"], true);
    // Refusals.
    let two = json!({"assignments":[{"kind":"sport","sportKey":"hockey"},{"kind":"sport","sportKey":"hockey"}]});
    let (status, body) = g.route("PUT", "/sources/espn/coverage", &[], two);
    assert_eq!((status, body["error"].as_str()), (400, Some("Invalid ESPN sports coverage targets")));
    let gone = json!({"assignments":[{"kind":"follow","followId":"99999999-9999-4999-8999-999999999999"}]});
    let (status, body) = g.route("PUT", "/sources/espn/coverage", &[], gone);
    assert_eq!((status, body["error"].as_str()), (400, Some("ESPN coverage contains an unavailable follow")));
    assert_eq!(g.route("PUT", "/sources/espn/coverage", &[], json!({"assignments":[{"kind":"sport","sportKey":"golf"}]})).0, 400);
}

#[test]
fn deleting_removes_the_source_and_its_targets_for_its_owner_only() {
    let f = Src::new();
    let id = saved_reddit(&f, "nfl");
    f.route("POST", "/sources/:id/assignments/preview", &[("id", &id)], json!({"assignments":[]}));
    f.as_actor(B);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert_eq!(list["sources"].as_array().unwrap().len(), 1, "another person sees only the built-in source");
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], Value::Null).1, json!({"deleted":false}));
    assert_eq!(f.rows(SOURCES).len(), 1);
    f.as_actor(A);
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], Value::Null).1, json!({"deleted":true}));
    assert!(f.rows(SOURCES).is_empty() && f.rows(ASSIGNMENTS).is_empty());
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], Value::Null).1, json!({"deleted":false}));
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", "nope")], Value::Null).0, 400);
}

const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";

#[test]
fn an_icon_is_found_sniffed_and_a_miss_is_remembered() {
    let f = Src::new();
    site(&f);
    let (_, shown) = f.route("POST", "/sources/preview", &[], json!({"url":"news.example.com"}));
    let (_, saved) = save(&f, &shown);
    let id = saved["source"]["id"].as_str().unwrap().to_owned();
    let icon = |f: &Src| f.route("GET", "/sources/:id/icon", &[("id", &id)], Value::Null);
    assert_eq!(icon(&f).0, 404);
    f.image("https://news.example.com/favicon.ico", PNG);
    // The miss is remembered for an hour, so the new icon is not asked for yet.
    assert_eq!(icon(&f).1["error"], "Sports source icon not found");
    f.advance(61 * 60 * 1000);
    let (status, body) = icon(&f);
    assert_eq!((status, body["contentType"].as_str(), body["bodyBase64"].as_str()), (200, Some("image/png"), Some(PNG)));
    // A page that is not an image is not accepted.
    let g = Src::new();
    site(&g);
    let (_, shown) = g.route("POST", "/sources/preview", &[], json!({"url":"news.example.com"}));
    let (_, saved) = save(&g, &shown);
    g.page("https://news.example.com/favicon.ico", "text/html", "PGh0bWw+");
    let sid = saved["source"]["id"].as_str().unwrap();
    assert_eq!(g.route("GET", "/sources/:id/icon", &[("id", sid)], Value::Null).0, 404);
    let (status, body) = g.route("GET", "/sources/:id/icon", &[("id", "nope")], Value::Null);
    assert_eq!((status, body["error"].as_str()), (404, Some("Sports source not found")));
    // Another person's source answers like a missing one.
    g.as_actor(B);
    assert_eq!(g.route("GET", "/sources/:id/icon", &[("id", sid)], Value::Null).1["error"], "Sports source not found");
}

#[test]
fn text_a_person_types_stays_out_of_logs_jobs_and_other_people() {
    const MARK: &str = "PLANTED-MARKER-4f1c9b";
    let f = Src::new();
    let marked = format!("{}.example.com", MARK.to_lowercase());
    f.page(&format!("https://{marked}/"), "text/html", &format!("<html><head><title>{MARK}</title></head></html>"));
    f.reply("no recipe");
    let (_, shown) = f.route("POST", "/sources/preview", &[], json!({"url":marked}));
    assert_eq!(shown["reason"], "unsupported");
    // Another person sees none of it and the calls reached only the expected ports.
    f.as_actor(B);
    let (_, list) = f.route("GET", "/sources", &[], Value::Null);
    assert!(!list.to_string().contains(MARK));
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "kv", "context", "fetch", "ai", "browser"].contains(&port.as_str()), "{port}");
        assert!(!(resource.contains("activity") || operation.contains("job")));
        let sink = port != "fetch" && port != "ai" && port != "browser" && !(port == "db" && operation == "query");
        assert!(!(sink && parameters.to_string().to_lowercase().contains(&MARK.to_lowercase())), "{port}.{operation}.{resource}");
    }
}
