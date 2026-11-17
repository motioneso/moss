mod common;
use common::sources::*;
use moss_sports_module::photo::{photo_key, usable_candidate, validate};
use moss_sports_module::photo_pass::{self, next_record, Budget, Story};
use serde_json::{json, Value};

const SRC: &str = "00000000-0000-4000-8000-0000000000f1";
const HOST: &str = "news.example.com";

fn source(f: &Src, owner: &str, state: &str, streak: i64) -> Value {
    let row = json!({"id":SRC,"owner_user_id":owner,"enabled":true,"canonical_domain":HOST,"retrieval_method":"feed",
        "confirmed_fetch_hosts":[HOST],"photo_rule_state":state,"photo_miss_streak":streak,"photo_relook_at":null,"photo_rule_json":null,
        "label":"Example","homepage_url":"https://news.example.com/","health_state":"healthy","recipe_status":"none","created_at":"2026-11-01T00:00:00.000Z"});
    f.tables.borrow_mut().entry(SOURCES.into()).or_default().push(row.clone());
    row
}

fn story(n: u32, feed_image: Option<&str>) -> Story {
    Story { id: format!("{SRC}:{n:024x}"), url: format!("https://{HOST}/story-{n}"), feed_image: feed_image.map(str::to_owned) }
}

fn row(f: &Src) -> Value {
    f.rows(SOURCES).into_iter().find(|r| r["id"] == SRC).unwrap()
}

fn run(f: &Src, src: &Value, stories: &[Story]) -> usize {
    let budget = Budget::open(f).unwrap();
    photo_pass::run(f, &budget, src, stories).unwrap()
}

#[test]
fn candidates_must_be_public_https_on_the_same_site() {
    let ok = |u: &str| usable_candidate(u, HOST, &[]).is_some();
    assert!(ok("https://news.example.com/a.jpg"));
    assert!(ok("https://img.example.com/a.jpg"));
    assert!(!ok("http://news.example.com/a.jpg"));
    assert!(!ok("https://user:pw@news.example.com/a.jpg"));
    assert!(!ok("https://other.org/a.jpg"));
    assert!(!ok("https://news.example.com/favicon.ico"));
    assert!(!ok("https://news.example.com/logo.png"));
    assert!(!ok("https://news.example.com/track/pixel.gif"));
    assert!(!ok("https://127.0.0.1/a.jpg"));
    assert!(usable_candidate("https://cdn.other.org/a.jpg", HOST, &["cdn.other.org".to_owned()]).is_some());
}

#[test]
fn rules_are_checked_against_confirmed_hosts() {
    let rule = |host: &str, selector: &str| {
        json!({"version":1,"kind":"html","fetchHosts":[host],"photo":{"selector":selector,"source":"attribute","attribute":"src"},"fallback":"none"})
    };
    let confirmed = vec![HOST.to_owned()];
    assert!(validate(&rule(HOST, "img.lead"), &confirmed).is_some());
    assert!(validate(&rule("evil.org", "img.lead"), &confirmed).is_none());
    assert!(validate(&rule(HOST, "img::before"), &confirmed).is_none());
    assert!(validate(&rule(HOST, ""), &confirmed).is_none());
}

#[test]
fn a_feed_photo_is_stored_privately_and_served() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    let found = run(&f, &src, &[story(1, Some("https://news.example.com/one.png"))]);
    assert_eq!(found, 1);
    let key = photo_key(SRC, "https://news.example.com/one.png");
    assert_eq!(f.vault_names(A), vec![format!("{key}.jpg"), format!("{key}.json")]);
    assert!(f.vault_names(B).is_empty());
    assert_eq!(row(&f)["photo_last_outcome"], "working");
    let id = format!("{SRC}:{:024x}", 1);
    let (status, body) = f.route("GET", "/headlines/:headline_id/photo", &[("headline_id", &id)], Value::Null);
    assert_eq!(status, 200);
    assert_eq!(body["contentType"], "image/jpeg");
    assert_eq!(body["bodyBase64"], "JPEG:PIXELS-ONE");
}

#[test]
fn another_person_cannot_read_the_photo() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    run(&f, &src, &[story(1, Some("https://news.example.com/one.png"))]);
    let id = format!("{SRC}:{:024x}", 1);
    f.as_actor(B);
    let (status, _) = f.route("GET", "/headlines/:headline_id/photo", &[("headline_id", &id)], Value::Null);
    assert_eq!(status, 404);
    let (status, _) = f.route("DELETE", "/sources/:id/photos", &[("id", SRC)], Value::Null);
    assert_eq!(status, 404);
    f.as_actor(A);
    assert_eq!(f.vault_names(A).len(), 2, "the other person's delete touched nothing");
}

#[test]
fn nothing_starts_near_the_deadline_and_a_skip_is_not_a_miss() {
    let f = Src::new();
    let src = source(&f, A, "in_use", 1);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    let budget = Budget::at(1_794_000_000_000 - 27_500);
    let found = photo_pass::run(&f, &budget, &src, &[story(1, Some("https://news.example.com/one.png"))]).unwrap();
    assert_eq!(found, 0);
    assert!(f.fetched().is_empty(), "no network call started");
    assert_eq!(row(&f)["photo_miss_streak"], 1, "a skipped story is not a miss");
    assert!(f.vault_names(A).is_empty());
}

#[test]
fn a_slow_fetch_stops_the_rest_of_the_pass() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.fetch_cost.set(14_000);
    let stories: Vec<Story> = (1..=3).map(|n| story(n, Some(&format!("https://news.example.com/{n}.png")))).collect();
    for n in 1..=3 {
        f.image(&format!("https://news.example.com/{n}.png"), "PIXELS");
    }
    assert_eq!(run(&f, &src, &stories), 2);
    assert_eq!(f.fetched().len(), 2);
}

#[test]
fn misses_count_only_while_in_use_and_three_make_it_stale() {
    let changes = |state, streak, found| next_record(state, streak, found).unwrap();
    let get = |c: &Vec<(&str, Value)>, k: &str| c.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
    let none = changes("none", 0, false);
    assert_eq!(get(&none, "photo_miss_streak"), Some(json!(0)));
    let two = changes("in_use", 1, false);
    assert_eq!(get(&two, "photo_miss_streak"), Some(json!(2)));
    assert_eq!(get(&two, "photo_rule_state"), None);
    let three = changes("in_use", 2, false);
    assert_eq!(get(&three, "photo_rule_state"), Some(json!("stale")));
    let back = changes("stale", 3, true);
    assert_eq!(get(&back, "photo_rule_state"), Some(json!("in_use")));
    assert_eq!(get(&back, "photo_miss_streak"), Some(json!(0)));
}

#[test]
fn an_unreadable_photo_is_a_miss_and_the_third_makes_the_rule_stale() {
    let f = Src::new();
    let mut src = source(&f, A, "in_use", 2);
    src["photo_rule_json"] = Value::Null;
    f.image("https://news.example.com/bad.png", "BAD");
    f.image("https://news.example.com/small.png", "TINY");
    assert_eq!(run(&f, &src, &[story(1, Some("https://news.example.com/bad.png")), story(2, Some("https://news.example.com/small.png"))]), 0);
    assert_eq!(row(&f)["photo_miss_streak"], 3);
    assert_eq!(row(&f)["photo_rule_state"], "stale");
    assert!(f.vault_names(A).is_empty());
}

fn page_with(image: &str) -> String {
    format!("<html><head></head><body><img class=\"lead\" src=\"{image}\"></body></html>")
}

const RULE_REPLY: &str = r#"{"version":1,"kind":"html","fetchHosts":["news.example.com"],"photo":{"selector":"img.lead","source":"attribute","attribute":"src"},"fallback":"none"}"#;

fn stale_setup(f: &Src) -> (Value, Vec<Story>) {
    let src = source(f, A, "stale", 3);
    for n in 1..=2 {
        let img = format!("https://news.example.com/pic-{n}.png");
        f.page(&format!("https://{HOST}/story-{n}"), "text/html", &page_with(&img));
        f.image(&img, "PIXELS");
    }
    (src, vec![story(1, None), story(2, None)])
}

#[test]
fn a_stale_rule_is_looked_at_again_once_a_day() {
    let f = Src::new();
    let (src, stories) = stale_setup(&f);
    f.reply("not json at all");
    run(&f, &src, &stories);
    assert_eq!(f.prompts().len(), 1);
    let later = row(&f);
    assert!(later["photo_relook_at"].is_string(), "the next try is a day away");
    run(&f, &later, &stories);
    assert_eq!(f.prompts().len(), 1, "not asked again the same day");
    f.advance(24 * 3600 * 1000 + 1000);
    f.reply(RULE_REPLY);
    run(&f, &row(&f), &stories);
    assert_eq!(f.prompts().len(), 2);
    assert_eq!(row(&f)["photo_rule_state"], "in_use");
    assert_eq!(row(&f)["photo_miss_streak"], 0);
}

#[test]
fn no_model_means_no_new_rule() {
    let f = Src::new();
    let (src, stories) = stale_setup(&f);
    run(&f, &src, &stories);
    assert_eq!(row(&f)["photo_rule_state"], "stale");
}

#[test]
fn stopping_photos_clears_the_rule_and_deletes_the_files() {
    let f = Src::new();
    let src = source(&f, A, "in_use", 0);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    run(&f, &src, &[story(1, Some("https://news.example.com/one.png"))]);
    assert_eq!(f.vault_names(A).len(), 2);
    let (status, body) = f.route("DELETE", "/sources/:id/photos", &[("id", SRC)], Value::Null);
    assert_eq!(status, 200, "{body}");
    assert!(f.vault_names(A).is_empty());
    assert_eq!(row(&f)["photo_rule_state"], "none");
    let id = format!("{SRC}:{:024x}", 1);
    let (status, _) = f.route("GET", "/headlines/:headline_id/photo", &[("headline_id", &id)], Value::Null);
    assert_eq!(status, 404);
}

#[test]
fn deleting_a_source_deletes_its_photo_files() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    run(&f, &src, &[story(1, Some("https://news.example.com/one.png"))]);
    let (status, body) = f.route("DELETE", "/sources/:id", &[("id", SRC)], Value::Null);
    assert_eq!(status, 200, "{body}");
    assert!(f.vault_names(A).is_empty());
}

#[test]
fn old_copies_are_swept() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.image("https://news.example.com/one.png", "PIXELS-ONE");
    run(&f, &src, &[story(1, Some("https://news.example.com/one.png"))]);
    f.advance(15 * 24 * 3600 * 1000);
    run(&f, &row(&f), &[]);
    assert!(f.vault_names(A).is_empty());
}

#[test]
fn private_text_stays_out_of_every_side_channel() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    let url = "https://news.example.com/PLANTED-URL-MARKER.png";
    f.image(url, "PLANTED-BODY-MARKER");
    run(&f, &src, &[Story { id: format!("{SRC}:{:024x}", 9), url: "https://news.example.com/PLANTED-STORY-MARKER".into(), feed_image: Some(url.into()) }]);
    let ports: std::collections::BTreeSet<String> = f.calls.borrow().iter().map(|(p, _, _, _)| p.clone()).collect();
    for banned in ["log", "jobs", "activity", "events"] {
        assert!(!ports.contains(banned), "photo code touched the {banned} port");
    }
    for (port, _, _, params) in f.calls.borrow().iter() {
        if port == "db" {
            let text = params.to_string();
            assert!(!text.contains("PLANTED"), "a database call carried private text: {text}");
        }
    }
}

#[test]
fn the_model_is_not_started_with_too_little_time_left() {
    let f = Src::new();
    let (src, stories) = stale_setup(&f);
    f.reply(RULE_REPLY);
    let budget = Budget::at(1_794_000_000_000 - 16_000);
    photo_pass::run(&f, &budget, &src, &stories).unwrap();
    assert!(f.prompts().is_empty(), "the model was started with under 15 seconds left");
    assert!(row(&f)["photo_relook_at"].is_null(), "no relook day was recorded as if the model had said no");
    assert_eq!(row(&f)["photo_rule_state"], "stale");
}

#[test]
fn one_refresh_stores_at_most_24_new_pictures_and_the_rest_are_not_misses() {
    let f = Src::new();
    let template = source(&f, A, "in_use", 1);
    let budget = Budget::open(&f).unwrap();
    let mut found = Vec::new();
    for s in 0..3u32 {
        let mut src = template.clone();
        let id = format!("00000000-0000-4000-8000-0000000001{s:02}");
        src["id"] = json!(id);
        f.tables.borrow_mut().entry(SOURCES.into()).or_default().push(src.clone());
        let stories: Vec<Story> = (0..12u32)
            .map(|i| {
                let n = s * 12 + i + 1;
                let url = format!("https://news.example.com/p{n}.png");
                f.image(&url, "PIXELS");
                story(n, Some(&url))
            })
            .collect();
        found.push(photo_pass::run(&f, &budget, &src, &stories).unwrap());
    }
    assert_eq!(found, vec![12, 12, 0]);
    let jpgs = f.vault_names(A).iter().filter(|n| n.ends_with(".jpg")).count();
    assert_eq!(jpgs, 24);
    let third = f.rows(SOURCES).into_iter().find(|r| r["id"] == "00000000-0000-4000-8000-000000000102").unwrap();
    assert_eq!(third["photo_miss_streak"], 1, "skipped stories are not misses");
    assert_eq!(third["photo_rule_state"], "in_use");
    let first = f.rows(SOURCES).into_iter().find(|r| r["id"] == "00000000-0000-4000-8000-000000000100").unwrap();
    assert_eq!(first["photo_miss_streak"], 0, "a source that found photos resets its streak");
}

#[test]
fn a_picture_that_is_too_large_after_re_encoding_does_not_stop_the_pass() {
    let f = Src::new();
    let src = source(&f, A, "none", 0);
    f.image("https://news.example.com/huge.png", "HUGE");
    f.image("https://news.example.com/ok.png", "PIXELS");
    let stories = [story(1, Some("https://news.example.com/huge.png")), story(2, Some("https://news.example.com/ok.png"))];
    assert_eq!(run(&f, &src, &stories), 1);
    assert_eq!(f.vault_names(A).len(), 2);
}

#[test]
fn a_failed_save_counts_as_one_miss_and_the_pass_carries_on() {
    let f = Src::new();
    let src = source(&f, A, "in_use", 1);
    f.put_fails.set(true);
    f.image("https://news.example.com/one.png", "PIXELS");
    f.image("https://news.example.com/two.png", "PIXELS");
    let stories = [story(1, Some("https://news.example.com/one.png")), story(2, Some("https://news.example.com/two.png"))];
    assert_eq!(run(&f, &src, &stories), 0);
    assert!(f.fetched().contains(&"https://news.example.com/two.png".to_owned()), "the second story was still tried");
    assert_eq!(row(&f)["photo_miss_streak"], 2, "a refresh with only misses adds one to the streak");
}

#[test]
fn a_time_skip_after_the_model_answered_records_no_relook_day() {
    let f = Src::new();
    let (src, stories) = stale_setup(&f);
    f.reply(RULE_REPLY);
    // The model reply uses up the time, so the checking downloads are skipped.
    f.model_cost.set(28_000);
    run(&f, &src, &stories);
    assert_eq!(f.prompts().len(), 1);
    assert!(row(&f)["photo_relook_at"].is_null(), "a time skip is not a no from the model");
}
