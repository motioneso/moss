//! Reads the headlines of the person's added sources and writes what happened back as health.
//! Every read is a plain public-web fetch of one address. Nothing is rendered, no article body is
//! read, and a site source is read only through its saved, checked recipe.
use crate::photo_pass::{self, Budget, Story};
use crate::recipe;
use crate::recipe_fetch::{self, Failure};
use crate::source_discovery::{iso_now, REDDIT_DOMAIN};
use crate::source_web as web;
use crate::sources;
use moss_module_sdk::{Host, Result};
use moss_news_reader::{
    parse_subreddit_input, publisher_identity, read_subreddit, subreddit_name_from_url, ReadSubredditResult,
    RedditFailureReason, RedditReaderOptions, SubredditInput,
};
use serde_json::{json, Value};

const MAX_REQUESTS: usize = 30;
const FEED_ITEMS: usize = 50;
const REDDIT_RATE_LIMIT: &str = "Reddit is rate limiting Moss. Headlines resume automatically.";
const REDDIT_AUTH: &str = "This subreddit is private or restricted.";

/// One headline a refresh read.
#[derive(Clone, Debug, PartialEq)]
pub struct Headline {
    pub headline: String,
    pub url: Option<String>,
    pub published_at: String,
    /// The picture the feed names for the story, when it names one.
    pub image_url: Option<String>,
}

struct Outcome {
    items: Vec<Headline>,
    state: &'static str,
    reason: Option<&'static str>,
    message: Option<&'static str>,
}

impl Outcome {
    fn healthy(items: Vec<Headline>) -> Self {
        Self { items, state: "healthy", reason: None, message: None }
    }
    fn bad(state: &'static str, reason: &'static str, message: &'static str) -> Self {
        Self { items: Vec::new(), state, reason: Some(reason), message: Some(message) }
    }
}

/// What a refresh gave back to its caller.
pub struct Refreshed {
    /// Headlines per assignment id, for the overview to show.
    pub headlines: Vec<(String, Vec<Headline>)>,
    pub requests: usize,
}

/// Names the failed read the way the person is told about it.
fn failure_outcome(failure: &Failure, reddit: bool) -> Outcome {
    match failure.status {
        Some(401 | 403) => return Outcome::bad("auth_required", "auth_required", if reddit { REDDIT_AUTH } else { "This publisher requires authentication." }),
        Some(429) => return Outcome::bad("failing", "rate_limited", if reddit { REDDIT_RATE_LIMIT } else { "The publisher asked Moss to retry later." }),
        _ => {}
    }
    match failure.reason.as_str() {
        "rate_limited" => Outcome::bad("failing", "rate_limited", if reddit { REDDIT_RATE_LIMIT } else { "The publisher asked Moss to retry later." }),
        "blocked" | "not_https" => Outcome::bad("unsupported", "unsafe_or_unsupported_target", "The source target did not pass the public-source safety checks."),
        "timeout" => Outcome::bad("failing", "timeout", "The publisher did not respond in time."),
        _ => Outcome::bad("failing", "upstream_unavailable", "The publisher could not be refreshed."),
    }
}

fn read_feed<H: Host + ?Sized>(host: &H, url: &str, hosts: &[String], at: &str) -> Result<Outcome> {
    let answer = match recipe_fetch::read(host, url, web::ACCEPT, &web::CONTENT_TYPES, hosts)? {
        Ok(answer) => answer,
        Err(failure) => return Ok(failure_outcome(&failure, false)),
    };
    if !web::is_feed(&answer.body) {
        return Ok(Outcome::bad("unsupported", "unsupported_response", "The publisher did not return a supported RSS or Atom feed."));
    }
    let art: std::collections::HashMap<String, String> =
        moss_news_reader::parse_feed_xml(&answer.body).into_iter().filter(|r| !r.image_url.is_empty()).map(|r| (r.link.trim().to_owned(), r.image_url)).collect();
    let items = web::sample_feed_headlines(&answer.body, FEED_ITEMS)
        .into_iter()
        .map(|s| Headline { image_url: art.get(&s.url).cloned(), headline: s.headline, url: Some(s.url), published_at: at.to_owned() })
        .collect();
    Ok(Outcome::healthy(items))
}

fn read_reddit<H: Host + ?Sized>(host: &H, feed_url: &str, at: &str) -> Outcome {
    let name = subreddit_name_from_url(Some(feed_url)).or_else(|| match parse_subreddit_input(feed_url) {
        Some(SubredditInput::Subreddit { name }) => Some(name),
        _ => None,
    });
    let Some(name) = name else { return Outcome::bad("unsupported", "unsupported_response", "Reddit did not return a readable post feed.") };
    let credited = |hostname: &str| publisher_identity(hostname);
    let options = RedditReaderOptions { publisher_domain: Some(&credited), ..Default::default() };
    match read_subreddit(|url, fetch| web::get_reddit(host, url, fetch), &name, &options) {
        ReadSubredditResult::Ok { headlines, .. } => Outcome::healthy(
            headlines.into_iter().map(|h| Headline { headline: h.title, url: Some(h.url), published_at: h.published_at.unwrap_or_else(|| at.to_owned()), image_url: None }).collect(),
        ),
        ReadSubredditResult::Failed(reason) => match reason {
            RedditFailureReason::NotFound => Outcome::bad("unsupported", "unsupported_response", "Reddit did not return a readable post feed."),
            RedditFailureReason::AuthRequired => Outcome::bad("auth_required", "auth_required", REDDIT_AUTH),
            RedditFailureReason::RateLimited => Outcome::bad("failing", "rate_limited", REDDIT_RATE_LIMIT),
            RedditFailureReason::Unreachable => Outcome::bad("failing", "upstream_unavailable", "The publisher could not be refreshed."),
        },
    }
}

fn read_recipe<H: Host + ?Sized>(host: &H, source: &Value, assignment: &Value, at: &str) -> Result<Outcome> {
    let json = &source["recipe_json"];
    if json.is_null() {
        return Ok(Outcome::bad("failing", "recipe_missing", "Rebuild this source recipe before refreshing."));
    }
    let Some(parsed) = recipe::validate(json) else {
        return Ok(Outcome::bad("failing", "recipe_drift", "The saved source recipe is no longer valid."));
    };
    if source["recipe_fingerprint"].as_str() != Some(recipe::fingerprint(&parsed).as_str()) {
        return Ok(Outcome::bad("failing", "recipe_drift", "The saved source recipe fingerprint changed."));
    }
    let Some(url) = recipe::expand(&parsed, &assignment["target_parameters"]) else {
        return Ok(Outcome::bad("failing", "invalid_target", "The saved source target is no longer valid."));
    };
    if assignment["target_url"].as_str() != Some(url.as_str()) {
        return Ok(Outcome::bad("failing", "invalid_target", "The saved source target is no longer valid."));
    }
    let url_host = moss_news_reader::url::Url::parse(&url).map(|u| u.hostname.to_lowercase()).unwrap_or_default();
    if !parsed.fetch_hosts.contains(&url_host) {
        return Ok(Outcome::bad("failing", "invalid_target", "The saved source target is no longer valid."));
    }
    let answer = match recipe_fetch::get(host, &parsed, &url)? {
        Ok(answer) => answer,
        Err(failure) => return Ok(failure_outcome(&failure, false)),
    };
    Ok(match recipe::extract(&parsed, &answer.body, answer.content_type.as_deref(), &answer.final_url) {
        Ok(items) => Outcome::healthy(
            items.into_iter().map(|i| Headline { headline: i.headline, url: i.url, published_at: i.published_at.unwrap_or_else(|| at.to_owned()), image_url: None }).collect(),
        ),
        Err(recipe::Reason::Drift) => Outcome::bad("failing", "recipe_drift", "The publisher changed the structure used by this source."),
        Err(recipe::Reason::Unsupported) => Outcome::bad("unsupported", "unsupported_response", "The publisher returned an unsupported response."),
    })
}

fn hosts_of(source: &Value) -> Vec<String> {
    source["confirmed_fetch_hosts"].as_array().map(|h| h.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// Reads every verified target of every enabled source, or of one source, and records health.
pub fn refresh<H: Host + ?Sized>(host: &H, only: Option<&str>) -> Result<Refreshed> {
    let at = iso_now(host)?;
    let budget = Budget::open(host)?;
    let mut done = Refreshed { headlines: Vec::new(), requests: 0 };
    for (source, assignments) in sources::rows(host)? {
        let id = source["id"].as_str().unwrap_or_default().to_owned();
        if only.is_some_and(|o| o != id) || source["enabled"].as_bool() != Some(true) {
            continue;
        }
        let method = source["retrieval_method"].as_str().unwrap_or_default().to_owned();
        let mut seen: Vec<(String, Outcome)> = Vec::new();
        let mut stories: Vec<Story> = Vec::new();
        let mut drift = false;
        let mut missing = false;
        for assignment in assignments.iter().filter(|a| a["preview_status"] == "verified") {
            let Some(target_url) = assignment["target_url"].as_str() else { continue };
            let identity = format!("{target_url}\0{}", assignment["target_parameters"]);
            let known = seen.iter().position(|(key, _)| *key == identity);
            let at_index = match known {
                Some(i) => i,
                None => {
                    let outcome = if done.requests >= MAX_REQUESTS {
                        Outcome::bad("failing", "request_budget_exceeded", "The source request budget was exhausted.")
                    } else {
                        done.requests += 1;
                        match method.as_str() {
                            "scrape" => read_recipe(host, &source, assignment, &at)?,
                            "reddit" if source["canonical_domain"] == REDDIT_DOMAIN => read_reddit(host, target_url, &at),
                            _ => read_feed(host, target_url, &hosts_of(&source), &at)?,
                        }
                    };
                    seen.push((identity, outcome));
                    seen.len() - 1
                }
            };
            let outcome = &seen[at_index].1;
            drift |= outcome.reason == Some("recipe_drift");
            missing |= outcome.reason == Some("recipe_missing");
            let assignment_id = assignment["id"].as_str().unwrap_or_default();
            sources::write_assignment_health(host, assignment_id, target_url, outcome.state, outcome.reason, outcome.message, &at)?;
            if outcome.state == "healthy" {
                for item in &outcome.items {
                    let Some(url) = &item.url else { continue };
                    let id = headline_id(&id, item);
                    if !stories.iter().any(|s| s.id == id) {
                        stories.push(Story { id, url: url.clone(), feed_image: item.image_url.clone() });
                    }
                }
                done.headlines.push((assignment_id.to_owned(), outcome.items.clone()));
            }
        }
        if seen.is_empty() {
            continue;
        }
        let status = (method == "scrape").then_some(if drift { "drift" } else if missing { "missing" } else { "ready" });
        sources::recompute_health(host, &id, status)?;
        // Photos never fail a refresh. A story that gets none simply has no picture.
        let _ = photo_pass::run(host, &budget, &source, &stories);
    }
    Ok(done)
}

/// A stable id for a headline of one source: the source, then a hash of its address and words.
pub fn headline_id(source_id: &str, headline: &Headline) -> String {
    let digest = web::sha256_hex(format!("{}\0{}", headline.url.as_deref().unwrap_or_default(), headline.headline).as_bytes());
    format!("{source_id}:{}", &digest[..24])
}

/// What a refresh reports to a caller that wants the facts and no private text.
pub fn summary(done: &Refreshed) -> Value {
    json!({"requests": done.requests, "targets": done.headlines.len()})
}
