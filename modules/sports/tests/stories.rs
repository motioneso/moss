mod common;
use common::both::Both;
use moss_sports_module::article;
use serde_json::{json, Value};

const EVENING: &str = "2026-11-13T03:00:00Z";
const CONTENT_HOST: &str = "content.core.api.espn.com";

/// Recorded in shape from ESPN's content host: markup, entities, a photo placeholder and a long tail.
fn recorded_story() -> String {
    let long = "The Premier League table tightened again on Saturday as the leaders dropped points. ".repeat(14);
    format!(
        "<p>Manchester United&#39;s plan &amp; the <a href=\"/x\">&ldquo;two-year&rdquo;</a> deal&nbsp;makes sense.</p>\
         <photo1><p>Second   paragraph\n with   spaces.</p><p>{long}</p><p>Fourth paragraph never shown.</p>"
    )
}

fn league_host() -> Both {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "EVE", "368");
    host
}

fn bodies(body: &Value) -> Vec<String> {
    body["leagueNews"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|g| g["headlines"].as_array().cloned().unwrap_or_default())
        .filter_map(|h| h["body"].as_str().map(str::to_owned))
        .collect()
}

fn content_fetches(host: &Both) -> Vec<String> {
    host.espn.fetched.borrow().iter().filter(|u| u.contains(CONTENT_HOST)).cloned().collect()
}

#[test]
fn a_recorded_article_is_cut_to_plain_text_and_clipped() {
    let text = article::sanitize(Some(&recorded_story()));
    assert!(text.starts_with("Manchester United\u{2019}s plan & the \u{201c}two-year\u{201d} deal makes sense.\n\nSecond paragraph with spaces.\n\n"), "{text}");
    assert!(!text.contains('<') && !text.contains("photo1") && !text.contains("Fourth"), "{text}");
    assert!(text.ends_with('\u{2026}'));
    assert!(text.encode_utf16().count() <= 901);
    assert_eq!(article::sanitize(None), "");
    assert_eq!(article::sanitize(Some("")), "");
}

#[test]
fn only_a_number_of_four_digits_or_more_names_an_article() {
    for good in ["1234", "50475329"] {
        assert!(article::is_article_id(good), "{good}");
    }
    for bad in ["", "7", "123", "12a4", "1234/../x", "1234?x=1", "https://evil.example/1234", "١٢٣٤"] {
        assert!(!article::is_article_id(bad), "{bad}");
    }
}

#[test]
fn a_featured_story_body_is_read_once_sanitised_and_shared() {
    let host = league_host();
    *host.espn.article_story.borrow_mut() = Some(recorded_story());
    let (status, body) = host.get("/overview", &[]);
    assert_eq!(status, 200);
    let found = bodies(&body);
    assert_eq!(found.len(), 1, "{}", body["leagueNews"]);
    assert!(found[0].starts_with("Manchester United\u{2019}s plan") && found[0].ends_with('\u{2026}'));
    let fetched = content_fetches(&host);
    assert_eq!(fetched.len(), 1);
    let id = fetched[0].rsplit('/').next().unwrap();
    assert!(article::is_article_id(id), "{id}");
    // The next page load answers from the install-wide copy and reads nothing from ESPN.
    host.get("/overview", &[]);
    assert_eq!(content_fetches(&host).len(), 1);
}

#[test]
fn a_failed_body_read_leaves_the_summary_and_is_tried_again() {
    let host = league_host();
    host.espn.article_fails.set(true);
    let (status, body) = host.get("/overview", &[]);
    assert_eq!(status, 200);
    assert!(bodies(&body).is_empty());
    assert_eq!(body["degraded"], true);
    let featured = body["leagueNews"].as_array().unwrap().iter().flat_map(|g| g["headlines"].as_array().unwrap().clone()).count();
    assert!(featured > 0);
    assert_eq!(content_fetches(&host).len(), 1);
    // Nothing was remembered, so a working read the next time fills the body in.
    host.espn.article_fails.set(false);
    *host.espn.article_story.borrow_mut() = Some(recorded_story());
    let (_, again) = host.get("/overview", &[]);
    assert_eq!(bodies(&again).len(), 1);
}

#[test]
fn a_short_or_odd_id_never_reaches_the_fetch() {
    let host = league_host();
    *host.espn.article_story.borrow_mut() = Some(recorded_story());
    // The first story leads the top band, so the one under test is the second.
    let hostile = |id: &str| {
        let story = |id: &str, n: u32| {
            json!({
                "id": id, "headline": format!("Story {n}"), "description": "A summary.",
                "published": "2026-11-13T10:00:00Z", "links": {"web": {"href": format!("https://www.espn.com/soccer/story/_/id/{n}")}},
                "images": [{"type": "header", "url": "https://a.espncdn.com/photo/1.jpg"}],
            })
        };
        json!({"articles": [story("9999", 1), story(id, 2)]}).to_string()
    };
    // Control: the same feed with a real id does reach the fetch, so the bad ids above are what stop it.
    *host.espn.news_override.borrow_mut() = Some(hostile("1234"));
    host.get("/overview", &[]);
    assert_eq!(content_fetches(&host).len(), 1);
    host.espn.fetched.borrow_mut().clear();
    for id in ["7", "1234/../../x", "12 34", "abcd"] {
        *host.espn.news_override.borrow_mut() = Some(hostile(id));
        host.espn.kv.borrow_mut().clear();
        let (_, body) = host.get("/overview", &[]);
        assert!(bodies(&body).is_empty());
        assert!(content_fetches(&host).is_empty(), "{id}: {:?}", content_fetches(&host));
    }
}

#[test]
fn a_game_in_the_window_leads_the_page_and_an_early_one_does_not() {
    let host = Both::new();
    host.follow("nhl", "BOS", "1");
    host.at(EVENING);
    *host.espn.hockey_state.borrow_mut() = Some("in");
    let (_, live) = host.get("/overview", &[]);
    assert_eq!(live["hero"]["mode"], "gameday");
    assert!(live["hero"]["games"][0]["rationale"].as_str().unwrap().starts_with("You follow "));
    // Two hours before the start the top story leads instead.
    *host.espn.hockey_state.borrow_mut() = Some("pre");
    host.espn.kv.borrow_mut().clear();
    host.at("2026-11-12T22:00:00Z");
    let (_, early) = host.get("/overview", &[]);
    assert_eq!(early["hero"]["mode"], "story");
    // Fifteen minutes before the start the game leads.
    host.at("2026-11-12T23:46:00Z");
    host.espn.kv.borrow_mut().clear();
    let (_, near) = host.get("/overview", &[]);
    assert_eq!(near["hero"]["mode"], "gameday");
}

#[test]
fn headlines_switched_off_read_no_news_and_show_none() {
    let host = league_host();
    host.headlines_on.set(false);
    let (_, body) = host.get("/overview", &[]);
    assert!(!host.espn.fetched.borrow().iter().any(|u| u.contains("/news")));
    assert_eq!(body["topStories"], json!([]));
    assert_eq!(body["leagueNews"], json!([]));
    assert_eq!(body["hero"], json!({"mode": "story", "headline": null}));
}

#[test]
fn coverage_naming_one_sport_reads_only_that_sports_feeds() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "MUN", "360");
    host.follow("nhl", "BOS", "1");
    host.coverage_rows.borrow_mut().push(json!({"sport_key": "hockey"}));
    host.get("/overview", &[]);
    let news: Vec<String> = host.espn.fetched.borrow().iter().filter(|u| u.contains("/news")).cloned().collect();
    assert!(!news.is_empty() && news.iter().all(|u| u.contains("/hockey/")), "{news:?}");
}

#[test]
fn a_second_person_never_gets_the_first_persons_stories_and_the_filter_is_what_stops_it() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "MUN", "360");
    let (_, mine) = host.get("/overview", &[]);
    assert!(!mine["followed"][0]["stories"].as_array().unwrap().is_empty(), "{}", mine["followed"]);
    host.follows.as_actor(common::B);
    let (_, theirs) = host.get("/overview", &[]);
    assert_eq!(theirs["followed"], json!([]));
    // With the owner filter off, the same second person sees the first person's card and stories.
    host.follows.rls_off.set(true);
    let (_, leaked) = host.get("/overview", &[]);
    assert_eq!(leaked["followed"].as_array().map(Vec::len), Some(1));
    assert!(!leaked["followed"][0]["stories"].as_array().unwrap().is_empty());
}

#[test]
fn private_text_stays_out_of_the_shared_copy_and_every_address() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "MARK-4f1c9b", "368");
    *host.espn.article_story.borrow_mut() = Some(recorded_story());
    host.get("/overview", &[]);
    assert!(!host.espn.kv_text().contains("MARK-4f1c9b"));
    assert!(!host.espn.fetched.borrow().iter().any(|u| u.contains("MARK-4f1c9b")));
    assert!(host.espn.kv.borrow().keys().any(|k| k.contains("espn-article-body")));
}
