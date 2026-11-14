//! Parity checks shared by the native test and the WebAssembly runner.
//!
//! Every case in the golden file was produced by the old TypeScript reader. Each check runs the
//! same input through the Rust reader and compares the result as JSON.

use moss_news_reader::reddit::{RedditFetchFailure, RedditFetched, RedditHop};
use moss_news_reader::url::Url;
use moss_news_reader::*;
use serde_json::{json, Value};

pub const FIXTURES: [(&str, &str); 4] = [
    ("bbc-feed.xml", include_str!("fixtures/bbc-feed.xml")),
    ("guardian-feed.xml", include_str!("fixtures/guardian-feed.xml")),
    ("npr-feed.xml", include_str!("fixtures/npr-feed.xml")),
    ("verge-feed.xml", include_str!("fixtures/verge-feed.xml")),
];

pub const GOLDEN: &str = include_str!("golden/legacy-cases.json");

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

fn strs(v: &Value) -> Vec<&str> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default()
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("serialise")
}

fn opt_str(v: Option<String>) -> Value {
    v.map(Value::String).unwrap_or(Value::Null)
}

fn headline(h: Option<RedditLinkedHeadline>) -> Value {
    h.map(|h| to_value(&h)).unwrap_or(Value::Null)
}

fn reason(r: RedditFailureReason) -> &'static str {
    match r {
        RedditFailureReason::NotFound => "not_found",
        RedditFailureReason::AuthRequired => "auth_required",
        RedditFailureReason::RateLimited => "rate_limited",
        RedditFailureReason::Unreachable => "unreachable",
    }
}

fn fetch_failure(v: &Value) -> RedditFetchFailure {
    RedditFetchFailure {
        reason: v["reason"].as_str().unwrap_or_default().to_string(),
        status: v["status"].as_u64().map(|n| n as u16),
        detail: v["detail"].as_str().map(String::from),
    }
}

pub struct Report {
    pub checked: usize,
    pub failures: Vec<String>,
}

impl Report {
    fn check(&mut self, label: &str, name: &str, want: &Value, got: Value) {
        self.checked += 1;
        if *want != got {
            let mut a = want.to_string();
            let mut b = got.to_string();
            a.truncate(600);
            b.truncate(600);
            self.failures.push(format!("{label} [{name}]\n  old: {a}\n  new: {b}"));
        }
    }
}

pub fn run_all() -> Report {
    let g: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let mut r = Report { checked: 0, failures: vec![] };

    for case in g["feeds"].as_array().unwrap() {
        let file = s(&case["fixture"]).unwrap();
        let xml = FIXTURES.iter().find(|(n, _)| *n == file).expect("fixture").1;
        let hosts = strs(&case["imageHosts"]);
        r.check("fixture feed", file, &case["items"], to_value(&to_feed_items(xml, &hosts)));
    }
    for case in g["synthetic"].as_array().unwrap() {
        let name = s(&case["name"]).unwrap();
        let xml = s(&case["xml"]).unwrap();
        let hosts = strs(&case["imageHosts"]);
        r.check("feed items", name, &case["items"], to_value(&to_feed_items(xml, &hosts)));
        r.check("public items", name, &case["public"], to_value(&parse_public_feed_items(xml)));
        r.check("is feed", name, &case["isFeed"], json!(is_public_feed_document(xml)));
    }
    for case in g["docs"].as_array().unwrap() {
        let xml = s(&case["xml"]).unwrap();
        r.check("document check", xml, &case["isFeed"], json!(is_public_feed_document(xml)));
    }
    for case in g["text"].as_array().unwrap() {
        let cap = case["cap"].as_u64().unwrap() as usize;
        let got = sanitize_feed_text(s(&case["raw"]), cap);
        r.check("feed text", &case["raw"].to_string(), &case["out"], json!(got));
    }
    for case in g["urls"].as_array().unwrap() {
        let got = sanitize_item_url(s(&case["raw"]));
        r.check("item url", &case["raw"].to_string(), &case["out"], opt_str(got));
    }
    for case in g["images"].as_array().unwrap() {
        let got = sanitize_image_url(s(&case["raw"]), &strs(&case["hosts"]));
        r.check("image url", &case["raw"].to_string(), &case["out"], opt_str(got));
    }
    for case in g["dates"].as_array().unwrap() {
        let got = sanitize_published_at(s(&case["raw"]));
        r.check("date", &case["raw"].to_string(), &case["out"], opt_str(got));
    }
    for case in g["ids"].as_array().unwrap() {
        let got = stable_id_for_url(s(&case["raw"]).unwrap());
        r.check("stable id", &case["raw"].to_string(), &case["out"], json!(got));
    }
    for case in g["identity"].as_array().unwrap() {
        let host = s(&case["host"]).unwrap();
        r.check("publisher", host, &case["identity"], opt_str(publisher_identity(host)));
    }

    for case in g["subredditInputs"].as_array().unwrap() {
        let got = match parse_subreddit_input(s(&case["raw"]).unwrap()) {
            None => Value::Null,
            Some(SubredditInput::Invalid) => json!({"kind": "invalid"}),
            Some(SubredditInput::Subreddit { name }) => json!({"kind": "subreddit", "name": name}),
        };
        r.check("subreddit input", &case["raw"].to_string(), &case["out"], got);
    }
    for case in g["nameUrls"].as_array().unwrap() {
        let got = subreddit_name_from_url(s(&case["raw"]));
        r.check("name from url", &case["raw"].to_string(), &case["out"], opt_str(got));
    }
    for case in g["urlHelpers"].as_array().unwrap() {
        let name = s(&case["name"]).unwrap();
        r.check("subreddit home", name, &case["home"], json!(reddit_subreddit_url(name)));
        r.check("hot feed", name, &case["hot"], json!(reddit_hot_feed_url(name)));
    }
    for case in g["entries"].as_array().unwrap() {
        let name = s(&case["name"]).unwrap();
        let domain = s(&case["publisherDomain"]).map(String::from);
        let map = |_: &str| domain.clone();
        let options = if domain.is_some() {
            RedditReaderOptions { publisher_domain: Some(&map), ..Default::default() }
        } else {
            RedditReaderOptions::default()
        };
        let got = reddit_entry_to_headline(s(&case["xml"]).unwrap(), &options);
        r.check("reddit entry", name, &case["out"], headline(got));
    }
    for case in g["redditFeeds"].as_array().unwrap() {
        let name = s(&case["name"]).unwrap();
        let options = RedditReaderOptions {
            limit: case["limit"].as_u64().map(|n| n as usize),
            ..Default::default()
        };
        let got = match parse_reddit_feed(s(&case["body"]).unwrap(), s(&case["fallback"]).unwrap(), &options) {
            None => json!({"ok": false}),
            Some(feed) => json!({"ok": true, "feed": to_value(&feed)}),
        };
        r.check("reddit feed", name, &case["out"], got);
    }
    for case in g["failures"].as_array().unwrap() {
        let got = reason(reddit_failure_reason(&fetch_failure(case)));
        r.check("reddit failure", &case.to_string(), &case["out"], json!(got));
    }

    let expected = "https://www.reddit.com/r/NFL/hot.rss";
    let guard = reddit_hop_guard(expected);
    for case in g["hops"].as_array().unwrap() {
        let hop = Url::parse(s(&case["url"]).unwrap()).map(|url| RedditHop {
            url,
            redirect_count: case["redirectCount"].as_u64().unwrap() as u32,
        });
        let got = hop.map(|h| guard(&h)).unwrap_or(false);
        r.check("reddit hop", &case["url"].to_string(), &case["out"], json!(got));
    }

    let o = reddit_fetch_options(expected, None);
    let want = &g["fetchOptions"];
    let got = json!({
        "allowedHosts": o.allowed_hosts, "accept": o.accept, "userAgent": o.user_agent,
        "allowedContentTypes": o.allowed_content_types, "maxBytes": o.max_bytes,
        "rejectOversizedResponses": o.reject_oversized_responses, "skipRobots": o.skip_robots,
    });
    r.check("reddit fetch options", "fixed", want, got);

    for case in g["reads"].as_array().unwrap() {
        let name = s(&case["name"]).unwrap();
        let res = &case["result"];
        let mut calls: Vec<String> = vec![];
        let result = read_subreddit(
            |url, _options| {
                calls.push(url.to_string());
                if res["ok"] == json!(true) {
                    Ok(RedditFetched {
                        status: res["status"].as_u64().unwrap() as u16,
                        final_url: s(&res["finalUrl"]).unwrap().to_string(),
                        content_type: s(&res["contentType"]).map(String::from),
                        body: s(&res["body"]).unwrap().to_string(),
                        truncated: false,
                    })
                } else {
                    Err(fetch_failure(res))
                }
            },
            s(&case["requestName"]).unwrap(),
            &RedditReaderOptions::default(),
        );
        let got = match result {
            ReadSubredditResult::Ok { subreddit, headlines, feed_url } => {
                json!({"ok": true, "subreddit": to_value(&subreddit), "headlines": to_value(&headlines), "feedUrl": feed_url})
            }
            ReadSubredditResult::Failed(why) => json!({"ok": false, "reason": reason(why)}),
        };
        r.check("read subreddit", name, &case["out"], got);
        r.check("read subreddit calls", name, &case["calls"], json!(calls));
    }
    r
}
