//! Turns what a person typed into one verified source: a subreddit, a site with a feed, or a
//! site read from its pages. Each outcome is a candidate to confirm or a plain reason it failed.
use crate::policy::{self, Subject, Verdict};
use crate::previews::Candidate;
use crate::util::{js_trim, new_id};
use crate::web::{self, Failed};
use crate::{domain, personalization::EXCLUSIONS};
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Result};
use moss_news_reader::{
    html::{discover_feed_urls, extract_listing_headlines, html_metadata, resolve_url, sample_feed_headlines, SampleHeadline},
    parse_subreddit_input, read_subreddit, reddit::{RedditHop, REDDIT_CANONICAL_DOMAIN, REDDIT_FETCH_HOSTS, REDDIT_PREVIEW_SAMPLES},
    sanitize_feed_text, url::Url, ReadSubredditResult, RedditFailureReason, RedditFetchFailure,
    RedditFetched, RedditReaderOptions, SubredditInput,
};
use serde_json::json;

#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    Ok(Candidate),
    Rejected(&'static str),
    Unavailable,
}

enum Verified {
    Candidate(Candidate),
    Failed(Resolution),
}

fn has_scheme(raw: &str) -> bool {
    let mut chars = raw.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

fn same_identity(left: &str, right: &str) -> bool {
    left == right || domain::matches(left, right) || domain::matches(right, left)
}

fn excluded(exclusions: &[String], candidate: &str) -> bool {
    exclusions.iter().any(|e| domain::matches(e, candidate))
}

/// Why a fetched address cannot stand in for the requested publisher, or `None` when it can.
fn final_domain_rejection(final_url: &str, expected: &str, exclusions: &[String]) -> Option<&'static str> {
    let Ok(found) = domain::normalize(final_url) else { return Some("redirected") };
    if excluded(exclusions, &found) {
        return Some("policy");
    }
    if same_identity(expected, &found) { None } else { Some("redirected") }
}

fn redirect_note(from: &str, to: &str) -> String {
    if from == to {
        format!("We followed the address you gave to {to}'s homepage, so that is the page we will use.")
    } else {
        format!("{from} sends visitors to {to}, so that is the site we will follow.")
    }
}

struct Moved {
    redirected: bool,
    note: Option<String>,
}

/// Whether a fetch is still that publisher's own page. A move inside one registrable domain is
/// accepted with a note. A move to another domain is refused, because no domains are confirmed
/// as having the same owner.
fn evaluate_redirect(final_url: &str, requested_url: &str, requested_domain: &str, exclusions: &[String]) -> std::result::Result<Moved, &'static str> {
    match final_domain_rejection(final_url, requested_domain, exclusions) {
        Some(reason) => Err(reason),
        None if final_url == requested_url => Ok(Moved { redirected: false, note: None }),
        None => {
            let to = domain::normalize(final_url).unwrap_or_else(|_| requested_domain.to_owned());
            Ok(Moved { redirected: true, note: Some(redirect_note(requested_domain, &to)) })
        }
    }
}

fn is_feed(content_type: Option<&str>, body: &str) -> bool {
    let kind = content_type.unwrap_or("").to_ascii_lowercase();
    if ["rss", "atom", "xml"].iter().any(|word| kind.contains(word)) {
        return true;
    }
    let start = body.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_ascii_lowercase();
    ["<?xml", "<rss", "<feed"].iter().any(|tag| {
        start.strip_prefix(tag).is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
    })
}

fn origin_root(url: &str) -> Option<String> {
    let parsed = Url::parse(url)?;
    let port = parsed.port.map(|p| format!(":{p}")).unwrap_or_default();
    let scheme = if parsed.https { "https" } else { "http" };
    Some(format!("{scheme}://{}{port}/", parsed.hostname))
}

/// The hosts a source may be read from, in first-seen order.
pub fn fetch_hosts(urls: &[Option<&str>]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for url in urls.iter().flatten() {
        if let Some(host) = domain::host_of(url) {
            if !seen.contains(&host) {
                seen.push(host);
            }
        }
    }
    seen
}

fn exclusions<H: Host + ?Sized>(host: &H) -> Result<Vec<String>> {
    let rows = Client(host).query(EXCLUSIONS, &Query::select(Filter::All))?;
    Ok(rows.iter().filter_map(|r| r["canonical_domain"].as_str().map(str::to_owned)).collect())
}

/// Resolves the typed text. A name with no address needs web search, which this package lacks.
pub fn resolve<H: Host + ?Sized>(host: &H, raw: &str) -> Result<Resolution> {
    let raw = js_trim(raw);
    let exclusions = exclusions(host)?;
    if let Some(found) = parse_subreddit_input(raw) {
        return match found {
            SubredditInput::Invalid => Ok(Resolution::Rejected("invalid_input")),
            SubredditInput::Subreddit { name } => resolve_subreddit(host, &name, &exclusions),
        };
    }
    let looks_like_url = has_scheme(raw) || (!raw.contains(' ') && raw.contains('.'));
    if !looks_like_url {
        return Ok(Resolution::Unavailable);
    }
    let normalized = match domain::normalize(raw) {
        Ok(found) => found,
        Err(reason) => {
            return Ok(Resolution::Rejected(if reason == "non_https_scheme" { "not_https" } else { "invalid_input" }))
        }
    };
    if excluded(&exclusions, &normalized) {
        return Ok(Resolution::Rejected("policy"));
    }
    let url = if has_scheme(raw) { raw.to_owned() } else { format!("https://{raw}") };
    Ok(match verify_publisher(host, &url, &exclusions)? {
        Verified::Candidate(candidate) => Resolution::Ok(candidate),
        Verified::Failed(result) => result,
    })
}

fn failed(reason: &'static str) -> Verified {
    Verified::Failed(Resolution::Rejected(reason))
}

fn verify_publisher<H: Host + ?Sized>(host: &H, raw_url: &str, exclusions: &[String]) -> Result<Verified> {
    let Ok(requested_domain) = domain::normalize(raw_url) else { return Ok(failed("invalid_input")) };
    let Some(requested) = Url::parse(raw_url) else { return Ok(failed("invalid_input")) };
    let requested_url = requested.href;
    let fetched = match web::get(host, &requested_url, None) {
        Ok(fetched) => fetched,
        Err(error) => return Ok(failed(web::rejection_for(&error))),
    };
    let moved = match evaluate_redirect(&fetched.final_url, &requested_url, &requested_domain, exclusions) {
        Ok(moved) => moved,
        Err(reason) => return Ok(failed(reason)),
    };
    let Some(fetched_url) = Url::parse(&fetched.final_url) else { return Ok(failed("invalid_input")) };
    let mut redirected = moved.redirected;
    let mut note = moved.note;
    let mut homepage_url = origin_root(&fetched.final_url).unwrap_or_default();
    let mut homepage_body = fetched.body.clone();
    let mut feed_url: Option<String> = None;
    let mut headlines: Vec<SampleHeadline> = Vec::new();

    if is_feed(fetched.content_type.as_deref(), &fetched.body) {
        feed_url = Some(fetched_url.href.clone());
        headlines = sample_feed_headlines(&fetched.body, 10);
    } else {
        if let Some(canonical) = html_metadata(&fetched.body).canonical_url {
            let Some(found) = resolve_url(&canonical, &fetched_url).and_then(|u| origin_root(&u.href)) else {
                return Ok(failed("invalid_input"));
            };
            homepage_url = found;
        }
        let Ok(canonical_domain) = domain::normalize(&homepage_url) else { return Ok(failed("redirected")) };
        if excluded(exclusions, &canonical_domain) {
            return Ok(failed("policy"));
        }
        if fetched_url.href != homepage_url {
            let homepage = match web::get(host, &homepage_url, None) {
                Ok(page) => page,
                Err(error) => return Ok(failed(web::rejection_for(&error))),
            };
            // The page named this homepage itself, so ownership is checked against the address
            // the person typed.
            if let Err(reason) = evaluate_redirect(&homepage.final_url, &homepage_url, &requested_domain, exclusions) {
                return Ok(failed(reason));
            }
            redirected = true;
            let landed = domain::normalize(&homepage.final_url).unwrap_or_else(|_| requested_domain.clone());
            note = Some(redirect_note(&requested_domain, &landed));
            homepage_url = origin_root(&homepage.final_url).unwrap_or(homepage_url);
            homepage_body = homepage.body;
        }
        for discovered in discover_feed_urls(&homepage_body, &homepage_url) {
            let Ok(response) = web::get(host, &discovered, None) else { continue };
            let Ok(expected) = domain::normalize(&homepage_url) else { continue };
            if final_domain_rejection(&response.final_url, &expected, exclusions).is_some() {
                continue;
            }
            let samples = sample_feed_headlines(&response.body, 10);
            if !samples.is_empty() {
                feed_url = Some(response.final_url);
                headlines = samples;
                break;
            }
        }
        if feed_url.is_none() {
            headlines = extract_listing_headlines(&homepage_body, &homepage_url, 10);
        }
    }
    if headlines.is_empty() {
        return Ok(failed("unreachable"));
    }
    let Ok(domain_name) = domain::normalize(&homepage_url) else { return Ok(failed("invalid_input")) };
    let metadata = html_metadata(&homepage_body);
    let titles: Vec<String> = headlines.iter().map(|h| h.headline.clone()).collect();
    let subject = Subject { canonical_domain: &domain_name, description: &metadata.description, headlines: &titles, community: false };
    // A followed redirect never reaches the model. An unseen domain then reads as unavailable.
    match policy::decide(host, &subject, !redirected)? {
        Verdict::Unavailable => return Ok(Verified::Failed(Resolution::Unavailable)),
        Verdict::Rejected => return Ok(failed("policy")),
        Verdict::Approved => {}
    }
    Ok(Verified::Candidate(Candidate {
        candidate_id: new_id(host)?,
        label: if metadata.title.is_empty() { domain_name.clone() } else { metadata.title },
        canonical_domain: domain_name,
        feed_url: feed_url.clone(),
        retrieval_method: if feed_url.is_some() { "feed".into() } else { "scrape".into() },
        confirmed_fetch_hosts: fetch_hosts(&[Some(&homepage_url), feed_url.as_deref()]),
        homepage_url,
        sample_count: headlines.len(),
        validation_fingerprint: policy::FINGERPRINT.into(),
        redirect_note: note,
        icon_url: None,
    }))
}

fn resolve_subreddit<H: Host + ?Sized>(host: &H, name: &str, exclusions: &[String]) -> Result<Resolution> {
    if excluded(exclusions, REDDIT_CANONICAL_DOMAIN) {
        return Ok(Resolution::Rejected("policy"));
    }
    let read = read_subreddit(
        |url, options| {
            let extra = json!({
                "allowedHosts": options.allowed_hosts, "accept": options.accept,
                "userAgent": options.user_agent, "allowedContentTypes": options.allowed_content_types,
                "maxBytes": options.max_bytes, "rejectOversizedResponses": options.reject_oversized_responses,
                "skipRobots": options.skip_robots,
            });
            let refused = |f: Failed| RedditFetchFailure { reason: f.reason, status: f.status, detail: f.detail };
            let fetched = web::get(host, url, Some(extra)).map_err(refused)?;
            // The call must land on the exact feed address with no redirect.
            let hop = Url::parse(&fetched.final_url).map(|url| RedditHop { url, redirect_count: fetched.hop_count });
            if !hop.is_some_and(|hop| options.hop_allowed(&hop)) {
                return Err(RedditFetchFailure { reason: "blocked".into(), status: None, detail: None });
            }
            Ok(RedditFetched {
                status: fetched.status, final_url: fetched.final_url, content_type: fetched.content_type,
                body: fetched.body, truncated: false,
            })
        },
        name,
        &RedditReaderOptions::default(),
    );
    let (subreddit, headlines, feed_url) = match read {
        ReadSubredditResult::Ok { subreddit, headlines, feed_url } => (subreddit, headlines, feed_url),
        ReadSubredditResult::Failed(RedditFailureReason::RateLimited) => return Ok(Resolution::Rejected("rate_limited")),
        ReadSubredditResult::Failed(RedditFailureReason::AuthRequired) => return Ok(Resolution::Rejected("auth_required")),
        ReadSubredditResult::Failed(_) => return Ok(Resolution::Rejected("unreachable")),
    };
    let label = format!("r/{}", subreddit.display_name);
    let description = sanitize_feed_text(
        Some(&[label.as_str(), subreddit.title.as_str(), subreddit.description.as_str()].iter().copied().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" \u{2014} ")),
        300,
    );
    let titles: Vec<String> = headlines.iter().take(REDDIT_PREVIEW_SAMPLES).map(|h| h.title.clone()).collect();
    let scoped = format!("{REDDIT_CANONICAL_DOMAIN}/r/{}", subreddit.display_name.to_lowercase());
    let subject = Subject { canonical_domain: &scoped, description: &description, headlines: &titles, community: true };
    match policy::decide(host, &subject, true)? {
        Verdict::Unavailable => return Ok(Resolution::Unavailable),
        Verdict::Rejected => return Ok(Resolution::Rejected("policy")),
        Verdict::Approved => {}
    }
    Ok(Resolution::Ok(Candidate {
        candidate_id: new_id(host)?,
        label,
        canonical_domain: REDDIT_CANONICAL_DOMAIN.into(),
        homepage_url: moss_news_reader::reddit_subreddit_url(&subreddit.display_name),
        feed_url: Some(feed_url),
        retrieval_method: "reddit".into(),
        sample_count: headlines.len().min(REDDIT_PREVIEW_SAMPLES),
        validation_fingerprint: policy::FINGERPRINT.into(),
        redirect_note: None,
        confirmed_fetch_hosts: REDDIT_FETCH_HOSTS.iter().map(|h| (*h).to_owned()).collect(),
        icon_url: None,
    }))
}

