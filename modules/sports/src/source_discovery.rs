//! Turns what a person typed into a checked source: a subreddit read through the shared reader,
//! or a site whose feed is found by plain fetch. A site with no feed would need the recipe maker,
//! which is a later part, so it answers "unsupported".
use crate::public_cache::now_ms;
use crate::source_scope::Target;
use crate::source_web::{self as web, DomainRefusal, Fail};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{Host, Result};
use moss_news_reader::url::Url;
use moss_news_reader::{
    parse_subreddit_input, publisher_identity, read_subreddit, reddit_subreddit_url, subreddit_name_from_url,
    ReadSubredditResult, RedditFailureReason, RedditReaderOptions, SubredditInput,
};
use moss_news_reader::reddit::REDDIT_PREVIEW_SAMPLES;
use serde::{Deserialize, Serialize};

pub const REDDIT_DOMAIN: &str = moss_news_reader::reddit::REDDIT_CANONICAL_DOMAIN;
pub const REDDIT_HOSTS: [&str; 1] = moss_news_reader::reddit::REDDIT_FETCH_HOSTS;
const MAX_CONFIRMED_HOSTS: usize = 6;
const SAMPLE_CAP: usize = 10;

/// A target the person asked for, named for the screen.
#[derive(Clone, Debug)]
pub struct Wanted {
    pub target: Target,
    pub label: String,
    pub scope: &'static str,
    pub exact_target_url: Option<String>,
}

/// One checked target of a source.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub target: serde_json::Value,
    pub label: String,
    pub scope: String,
    pub target_url: String,
    pub parameters: serde_json::Value,
    pub sample_headlines: Vec<String>,
    pub checked_at: String,
}

/// A source the person can confirm.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub label: String,
    pub canonical_domain: String,
    pub homepage_url: String,
    pub feed_url: String,
    pub retrieval_method: String,
    pub validation_fingerprint: String,
    pub icon_url: Option<String>,
    pub confirmed_fetch_hosts: Vec<String>,
    pub checked_at: String,
    pub sample_count: usize,
    pub sample_headlines: Vec<String>,
    pub targets: Vec<Verified>,
    /// The accepted recipe of a site that publishes no feed.
    #[serde(default)]
    pub recipe: Option<serde_json::Value>,
    #[serde(default)]
    pub recipe_fingerprint: Option<String>,
}

pub enum Resolution {
    Ok(Box<Candidate>),
    Rejected(&'static str),
}

/// What a saved source already settled, so a later check cannot wander to another publisher.
pub struct Authority {
    pub canonical_domain: String,
    pub confirmed_fetch_hosts: Vec<String>,
    /// The saved recipe, when targets are re-checked against it instead of a new proposal.
    pub recipe: Option<serde_json::Value>,
}

pub fn iso_now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let at = DateTime::<Utc>::from_timestamp_millis(now_ms(host)?).unwrap_or_default();
    Ok(at.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn exact_host(url: &str) -> String {
    Url::parse(url).map(|u| u.hostname.to_lowercase()).unwrap_or_default()
}

fn dedupe(hosts: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for host in hosts {
        if !out.contains(&host) {
            out.push(host);
        }
    }
    out
}

fn targets_for(wanted: &[Wanted], url: &str, headlines: &[String], checked_at: &str) -> Vec<Verified> {
    wanted
        .iter()
        .map(|w| Verified {
            target: w.target.to_json(),
            label: w.label.clone(),
            scope: w.scope.to_owned(),
            target_url: url.to_owned(),
            parameters: serde_json::json!({}),
            sample_headlines: headlines.to_vec(),
            checked_at: checked_at.to_owned(),
        })
        .collect()
}

pub fn resolve<H: Host + ?Sized>(host: &H, raw_url: &str, wanted: &[Wanted], authority: Option<&Authority>) -> Result<Resolution> {
    let raw = raw_url.trim();
    if let Some(parsed) = parse_subreddit_input(raw) {
        return match parsed {
            SubredditInput::Invalid => Ok(Resolution::Rejected("invalid_input")),
            SubredditInput::Subreddit { name } => resolve_subreddit(host, &name, wanted, authority),
        };
    }
    resolve_site(host, raw, wanted, authority)
}

fn resolve_subreddit<H: Host + ?Sized>(host: &H, name: &str, wanted: &[Wanted], authority: Option<&Authority>) -> Result<Resolution> {
    if let Some(a) = authority {
        if a.canonical_domain != REDDIT_DOMAIN || a.confirmed_fetch_hosts.iter().any(|h| !REDDIT_HOSTS.contains(&h.as_str())) {
            return Ok(Resolution::Rejected("unsupported"));
        }
    }
    if wanted.iter().any(|w| w.exact_target_url.is_some()) {
        return Ok(Resolution::Rejected("invalid_input"));
    }
    let credited = |hostname: &str| publisher_identity(hostname);
    let options = RedditReaderOptions { publisher_domain: Some(&credited), ..Default::default() };
    let read = read_subreddit(|url, fetch| web::get_reddit(host, url, fetch), name, &options);
    let (subreddit, headlines, feed_url) = match read {
        ReadSubredditResult::Ok { subreddit, headlines, feed_url } => (subreddit, headlines, feed_url),
        ReadSubredditResult::Failed(reason) => {
            return Ok(Resolution::Rejected(match reason {
                RedditFailureReason::NotFound => "not_found",
                RedditFailureReason::AuthRequired => "auth_required",
                RedditFailureReason::RateLimited => "rate_limited",
                RedditFailureReason::Unreachable => "unreachable",
            }))
        }
    };
    let display = subreddit_name_from_url(Some(&feed_url)).unwrap_or(subreddit.display_name);
    let checked_at = iso_now(host)?;
    let samples: Vec<String> = headlines.iter().take(REDDIT_PREVIEW_SAMPLES).map(|h| h.title.clone()).collect();
    Ok(Resolution::Ok(Box::new(Candidate {
        label: format!("r/{display}"),
        canonical_domain: REDDIT_DOMAIN.to_owned(),
        homepage_url: reddit_subreddit_url(&display),
        validation_fingerprint: web::sha256_hex(feed_url.as_bytes()),
        icon_url: subreddit.icon_url,
        confirmed_fetch_hosts: REDDIT_HOSTS.iter().map(|h| (*h).to_owned()).collect(),
        sample_count: headlines.len(),
        targets: targets_for(wanted, &feed_url, &samples, &checked_at),
        sample_headlines: samples,
        checked_at,
        retrieval_method: "reddit".into(),
        feed_url,
        recipe: None,
        recipe_fingerprint: None,
    })))
}

fn resolve_site<H: Host + ?Sized>(host: &H, raw: &str, wanted: &[Wanted], authority: Option<&Authority>) -> Result<Resolution> {
    let requested = match web::normalize_publisher_domain(raw) {
        Ok(domain) => domain,
        Err(DomainRefusal::NonHttpsScheme) => return Ok(Resolution::Rejected("not_https")),
        Err(DomainRefusal::Other) => return Ok(Resolution::Rejected("invalid_input")),
    };
    let typed = if raw.find(':').is_some_and(|at| raw[..at].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))) {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let Some(start) = Url::parse(&typed) else { return Ok(Resolution::Rejected("invalid_input")) };
    if start.port.is_some() {
        return Ok(Resolution::Rejected("invalid_input"));
    }
    if let Some(a) = authority {
        let hosts = &a.confirmed_fetch_hosts;
        if hosts.is_empty()
            || hosts.len() > MAX_CONFIRMED_HOSTS
            || !hosts.contains(&exact_host(&start.href))
            || !moss_news_reader::same_publisher(&requested, &a.canonical_domain)
        {
            return Ok(Resolution::Rejected("unsupported"));
        }
    }
    let narrowed = authority.map(|a| a.confirmed_fetch_hosts.as_slice());
    let fetched = match web::get(host, &start.href, narrowed)? {
        Ok(fetched) => fetched,
        Err(Fail::NotHttps) => return Ok(Resolution::Rejected("not_https")),
        Err(Fail::Other) => return Ok(Resolution::Rejected("unreachable")),
    };
    let Some(final_url) = Url::parse(&fetched.final_url) else { return Ok(Resolution::Rejected("policy")) };
    if web::accepted_final_domain(&fetched.final_url, &requested).is_none() {
        return Ok(Resolution::Rejected("policy"));
    }
    let mut homepage_url = web::resolve("/", &final_url).map(|u| u.href).unwrap_or_default();
    let mut homepage_body = fetched.body.clone();
    let mut found: Option<(String, Vec<web::Sample>)> = None;
    if web::is_feed(&fetched.body) {
        found = Some((final_url.href.clone(), web::sample_feed_headlines(&fetched.body, SAMPLE_CAP)));
    } else {
        let meta = web::html_metadata(&fetched.body);
        if let Some(canonical) = meta.canonical_url {
            let Some(url) = web::publisher_url(&canonical, &final_url, &requested) else {
                return Ok(Resolution::Rejected("policy"));
            };
            homepage_url = Url::parse(&url).and_then(|u| web::resolve("/", &u)).map(|u| u.href).unwrap_or_default();
        }
        if web::normalize_publisher_domain(&homepage_url).is_err() {
            return Ok(Resolution::Rejected("policy"));
        }
        if final_url.href != homepage_url {
            let home_host = exact_host(&homepage_url);
            let page = match web::get(host, &homepage_url, Some(&[home_host.clone()]))? {
                Ok(page) => page,
                Err(_) => return Ok(Resolution::Rejected("unreachable")),
            };
            if exact_host(&page.final_url) != home_host || web::accepted_final_domain(&page.final_url, &requested).is_none() {
                return Ok(Resolution::Rejected("policy"));
            }
            homepage_url = Url::parse(&page.final_url).and_then(|u| web::resolve("/", &u)).map(|u| u.href).unwrap_or_default();
            homepage_body = page.body;
        }
        let home = Url::parse(&homepage_url);
        for advertised in web::discover_feed_urls(&homepage_body, &homepage_url) {
            let Some(base) = home.as_ref() else { break };
            let Some(candidate) = web::publisher_url(&advertised, base, &requested) else { continue };
            let candidate_host = exact_host(&candidate);
            if authority.is_some_and(|a| !a.confirmed_fetch_hosts.contains(&candidate_host)) {
                continue;
            }
            let Ok(page) = web::get(host, &candidate, Some(&[candidate_host.clone()]))? else { continue };
            if exact_host(&page.final_url) != candidate_host
                || web::accepted_final_domain(&page.final_url, &requested).is_none()
                || !web::is_feed(&page.body)
            {
                continue;
            }
            found = Some((page.final_url.clone(), web::sample_feed_headlines(&page.body, SAMPLE_CAP)));
            break;
        }
    }
    let Some((feed_url, samples)) = found else {
        let Ok(domain) = web::normalize_publisher_domain(&homepage_url) else { return Ok(Resolution::Rejected("invalid_input")) };
        let hosts = match authority {
            Some(a) => a.confirmed_fetch_hosts.clone(),
            None => dedupe([start.href.as_str(), fetched.final_url.as_str(), homepage_url.as_str()].map(exact_host)),
        };
        return scrape_candidate(host, &homepage_url, &homepage_body, wanted, authority, domain, hosts);
    };
    let Ok(domain) = web::normalize_publisher_domain(&homepage_url) else { return Ok(Resolution::Rejected("invalid_input")) };
    let metadata = web::html_metadata(&homepage_body);
    let hosts = match authority {
        Some(a) => a.confirmed_fetch_hosts.clone(),
        None => dedupe([start.href.as_str(), fetched.final_url.as_str(), homepage_url.as_str(), feed_url.as_str()].map(exact_host)),
    };
    let checked_at = iso_now(host)?;
    let headlines: Vec<String> = samples.iter().map(|s| s.headline.clone()).collect();
    Ok(Resolution::Ok(Box::new(Candidate {
        label: if metadata.title.is_empty() { domain.clone() } else { metadata.title },
        canonical_domain: authority.map(|a| a.canonical_domain.clone()).unwrap_or(domain),
        homepage_url,
        validation_fingerprint: web::sha256_hex(feed_url.as_bytes()),
        icon_url: None,
        confirmed_fetch_hosts: hosts,
        sample_count: headlines.len(),
        targets: targets_for(wanted, &feed_url, &headlines, &checked_at),
        sample_headlines: headlines,
        checked_at,
        retrieval_method: "feed".into(),
        feed_url,
        recipe: None,
        recipe_fingerprint: None,
    })))
}

/// Renders the homepage in the host's sandboxed browser and turns what it saw into evidence.
/// Any refusal (no browser, a chat call, busy, slow, blank page, an address outside the confirmed
/// sites) answers `None`, so the caller keeps the plain-fetch result.
fn render_evidence<H: Host + ?Sized>(host: &H, homepage_url: &str, plain: &[serde_json::Value], confirmed: &[String], domain: &str) -> Option<Vec<serde_json::Value>> {
    let mut allowed = dedupe(std::iter::once(exact_host(homepage_url)).chain(confirmed.iter().cloned()));
    allowed.truncate(MAX_CONFIRMED_HOSTS);
    let listed: Vec<&str> = allowed.iter().map(String::as_str).collect();
    let rendered = moss_module_sdk::Client(host).render_page(homepage_url, &listed).ok()?;
    if rendered["ok"] != true {
        return None;
    }
    let final_url = rendered["finalUrl"].as_str()?;
    if !allowed.contains(&exact_host(final_url)) || web::accepted_final_domain(final_url, domain).is_none() {
        return None;
    }
    let text = rendered["text"].as_str().unwrap_or_default();
    if text.trim().is_empty() {
        return None;
    }
    let links: Vec<(String, String)> = rendered["candidates"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|c| Some((c["url"].as_str()?.to_owned(), c["text"].as_str()?.to_owned())))
        .filter(|(url, _)| allowed.contains(&exact_host(url)) && web::accepted_final_domain(url, domain).is_some())
        .collect();
    Some(crate::recipe_propose::with_rendered(plain, final_url, text, &links))
}

/// A site with no feed: the model proposes a recipe (or fills a saved one), and the recipe is kept
/// only after a replay through the real fetch path returns headlines.
fn scrape_candidate<H: Host + ?Sized>(
    host: &H,
    homepage_url: &str,
    homepage_body: &str,
    wanted: &[Wanted],
    authority: Option<&Authority>,
    domain: String,
    hosts: Vec<String>,
) -> Result<Resolution> {
    use crate::recipe_propose::{ask, gather, Outcome};
    let fixed = match authority.and_then(|a| a.recipe.as_ref()) {
        Some(value) => match crate::recipe::validate(value) {
            Some(recipe) => Some(recipe),
            None => return Ok(Resolution::Rejected("unsupported")),
        },
        None => None,
    };
    let plain = gather(host, homepage_url, homepage_body, wanted, &hosts)?;
    let mut outcome = ask(host, &plain, wanted, &hosts, fixed.as_ref())?;
    if matches!(outcome, Outcome::Rejected) {
        // The plain page gave no usable recipe. A page that hides its headlines until scripts run
        // gets one render, and one more proposal from what the browser saw.
        if let Some(rendered) = render_evidence(host, homepage_url, &plain, &hosts, &domain) {
            outcome = ask(host, &rendered, wanted, &hosts, fixed.as_ref())?;
        }
    }
    let proposed = match outcome {
        Outcome::Recipe(proposed) => proposed,
        Outcome::Unavailable => return Ok(Resolution::Rejected("unavailable")),
        Outcome::Rejected => return Ok(Resolution::Rejected("unsupported")),
    };
    let title = web::html_metadata(homepage_body).title;
    let checked_at = iso_now(host)?;
    let samples = proposed.replays.first().map(|r| r.headlines.clone()).unwrap_or_default();
    let targets = if wanted.is_empty() {
        Vec::new()
    } else {
        wanted
            .iter()
            .zip(&proposed.replays)
            .map(|(w, r)| Verified {
                target: w.target.to_json(),
                label: w.label.clone(),
                scope: w.scope.to_owned(),
                target_url: r.url.clone(),
                parameters: r.parameters.clone(),
                sample_headlines: r.headlines.clone(),
                checked_at: checked_at.clone(),
            })
            .collect()
    };
    Ok(Resolution::Ok(Box::new(Candidate {
        label: if title.is_empty() { domain.clone() } else { title },
        canonical_domain: authority.map(|a| a.canonical_domain.clone()).unwrap_or(domain),
        homepage_url: homepage_url.to_owned(),
        feed_url: String::new(),
        retrieval_method: "scrape".into(),
        validation_fingerprint: proposed.fingerprint.clone(),
        icon_url: None,
        confirmed_fetch_hosts: hosts,
        checked_at,
        sample_count: samples.len(),
        sample_headlines: samples,
        targets,
        recipe: Some(proposed.recipe.value.clone()),
        recipe_fingerprint: Some(proposed.fingerprint),
    })))
}
