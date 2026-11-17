//! Finds, downloads and stores one photo per story during a refresh, and keeps the source's
//! record of whether its photos work. No network call starts when the call is close to its time
//! limit, and a story left undone for that reason is tried again at the next refresh.
use crate::photo::{apply, photo_key, share_image, usable_candidate, validate, Rule};
use crate::photo_discovery::{propose, read_pages};
use crate::photo_store as store;
use crate::public_cache::now_ms;
use crate::source_web::get_up_to;
use crate::sources::SOURCES;
use crate::util::values;
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Result};
use moss_news_reader::url::Url;
use serde_json::{json, Value};

/// How long one call may run, and how much of the end of it is kept free of new network calls.
pub const CALL_LIMIT_MS: i64 = 30_000;
pub const DEADLINE_MARGIN_MS: i64 = 3_000;
/// New pictures one refresh may store across all sources.
const MAX_NEW_PHOTOS: usize = 24;
const PAGES_PER_SOURCE: usize = 6;
const STORIES_PER_SOURCE: usize = 12;
const PAGE_BYTES: u64 = 1_000_000;
const DOWNLOAD_BYTES: u64 = 786_432;
const DOWNLOAD_TIMEOUT_MS: u64 = 5_000;
const MISS_LIMIT: i64 = 3;
const RELOOK_MS: i64 = 24 * 60 * 60 * 1000;

/// The time left for starting network calls.
pub struct Budget {
    pub start_ms: i64,
    stored: std::cell::Cell<usize>,
}

impl Budget {
    pub fn open<H: Host + ?Sized>(host: &H) -> Result<Self> {
        Ok(Self::at(now_ms(host)?))
    }
    pub fn at(start_ms: i64) -> Self {
        Self { start_ms, stored: std::cell::Cell::new(0) }
    }
    /// False once starting a call now could run into the call's time limit.
    pub fn may_start<H: Host + ?Sized>(&self, host: &H) -> Result<bool> {
        self.may_start_within(host, DEADLINE_MARGIN_MS)
    }
    /// Like `may_start`, for a call that can run longer than a download, such as a model reply.
    pub fn may_start_within<H: Host + ?Sized>(&self, host: &H, margin_ms: i64) -> Result<bool> {
        Ok(now_ms(host)? + margin_ms < self.start_ms + CALL_LIMIT_MS)
    }
    /// True while this refresh may still store a new picture. Each one crosses the module as
    /// large text several times, so the count is capped to stay inside the step limit.
    pub fn may_store(&self) -> bool {
        self.stored.get() < MAX_NEW_PHOTOS
    }
    pub fn note_stored(&self) {
        self.stored.set(self.stored.get() + 1);
    }
}

/// One story to find a photo for.
pub struct Story {
    pub id: String,
    pub url: String,
    pub feed_image: Option<String>,
}

pub enum Fetched {
    Image(String),
    Failed,
    /// Left undone because of the time limit. Not a photo miss.
    Skipped,
}

/// Downloads one picture as base64, within the size and time caps.
pub fn download<H: Host + ?Sized>(host: &H, budget: &Budget, url: &str) -> Result<Fetched> {
    if !budget.may_start(host)? {
        return Ok(Fetched::Skipped);
    }
    let Some(parsed) = Url::parse(url) else { return Ok(Fetched::Failed) };
    let answer = host.call(
        "fetch",
        "get",
        "public-web",
        json!({"url": url, "maxBytes": DOWNLOAD_BYTES, "timeoutMs": DOWNLOAD_TIMEOUT_MS, "allowedHosts": [parsed.hostname], "rejectOversizedResponses": true, "encoding": "base64"}),
    );
    let Ok(answer) = answer else { return Ok(Fetched::Failed) };
    if answer["ok"].as_bool() != Some(true) || answer["truncated"].as_bool() == Some(true) {
        return Ok(Fetched::Failed);
    }
    Ok(answer["body"].as_str().map_or(Fetched::Failed, |b| Fetched::Image(b.to_owned())))
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Working(String),
    Nothing,
    Skipped,
}

struct Pass<'a, H: ?Sized> {
    host: &'a H,
    budget: &'a Budget,
    source_id: &'a str,
    confirmed: &'a [String],
    rule: Option<&'a Rule>,
    pages_left: usize,
    existing: std::collections::HashSet<String>,
    now: i64,
}

impl<H: Host + ?Sized> Pass<'_, H> {
    /// Tries one address: download, re-encode, store. `Some(outcome)` ends the story.
    fn try_photo(&mut self, address: &str, story_url: &str) -> Result<Option<Outcome>> {
        if !self.budget.may_store() {
            return Ok(Some(Outcome::Skipped));
        }
        let body = match download(self.host, self.budget, address)? {
            Fetched::Image(body) => body,
            Fetched::Skipped => return Ok(Some(Outcome::Skipped)),
            Fetched::Failed => return Ok(None),
        };
        let Ok(photo) = store::reencode(self.host, &body)? else { return Ok(None) };
        let key = photo_key(self.source_id, address);
        if store::put(self.host, &key, self.source_id, story_url, &photo, self.now).is_err() {
            return Ok(None);
        }
        self.budget.note_stored();
        self.existing.insert(key.clone());
        Ok(Some(Outcome::Working(key)))
    }

    fn story(&mut self, story: &Story) -> Result<Outcome> {
        let page_host = Url::parse(&story.url).map(|u| u.hostname.to_lowercase()).unwrap_or_default();
        let mut tried: Vec<String> = Vec::new();
        let mut page: Option<String> = None;
        let mut stage = 0;
        loop {
            let address = match stage {
                0 => story.feed_image.clone(),
                _ => {
                    if page.is_none() && self.pages_left > 0 && self.confirmed.contains(&page_host) {
                        if !self.budget.may_start(self.host)? {
                            return Ok(Outcome::Skipped);
                        }
                        self.pages_left -= 1;
                        page = get_up_to(self.host, &story.url, Some(std::slice::from_ref(&page_host)), PAGE_BYTES, false)?.ok().map(|p| p.body);
                    }
                    let html = page.as_deref().unwrap_or_default();
                    match stage {
                        1 => self.rule.and_then(|r| apply(r, html, &story.url)),
                        2 if self.rule.is_none_or(|r| r.share_fallback) => share_image(html, &story.url),
                        _ => None,
                    }
                }
            };
            stage += 1;
            if let Some(address) = address.and_then(|a| usable_candidate(&a, &page_host, self.confirmed)) {
                if !tried.contains(&address) {
                    if self.existing.contains(&photo_key(self.source_id, &address)) {
                        return Ok(Outcome::Working(photo_key(self.source_id, &address)));
                    }
                    tried.push(address.clone());
                    if let Some(outcome) = self.try_photo(&address, &story.url)? {
                        return Ok(outcome);
                    }
                }
            }
            if stage > 2 {
                return Ok(Outcome::Nothing);
            }
        }
    }
}

fn confirmed_hosts(source: &Value) -> Vec<String> {
    source["confirmed_fetch_hosts"].as_array().map(|h| h.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn write<H: Host + ?Sized>(host: &H, id: &str, changes: Vec<(&str, Value)>) -> Result<()> {
    Client(host).query(SOURCES, &Query::update(Filter::eq("id", id), values(changes))).map(|_| ())
}

/// The source's new photo record after a pass with these results. `None` means no change.
pub fn next_record(state: &str, streak: i64, found: bool) -> Option<Vec<(&'static str, Value)>> {
    if found {
        let mut changes = vec![("photo_last_outcome", json!("working")), ("photo_miss_streak", json!(0)), ("photo_relook_at", Value::Null)];
        if state == "stale" {
            changes.push(("photo_rule_state", json!("in_use")));
        }
        return Some(changes);
    }
    let streak = if state == "in_use" { streak + 1 } else { streak };
    let mut changes = vec![("photo_last_outcome", json!("none")), ("photo_miss_streak", json!(streak))];
    if state == "in_use" && streak >= MISS_LIMIT {
        changes.push(("photo_rule_state", json!("stale")));
        changes.push(("photo_relook_at", Value::Null));
    }
    Some(changes)
}

/// Runs a once-a-day relook for a source whose rule stopped working. A rule that passes the
/// two-of-three check replaces the stale one at once. Otherwise the next try waits a day.
fn relook<H: Host + ?Sized>(host: &H, budget: &Budget, source: &Value, stories: &[Story], now: i64) -> Result<()> {
    let id = source["id"].as_str().unwrap_or_default();
    let due = match source["photo_relook_at"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()) {
        Some(at) => at.timestamp_millis() <= now,
        None => true,
    };
    if source["photo_rule_state"] != "stale" || !due || stories.is_empty() {
        return Ok(());
    }
    let confirmed = confirmed_hosts(source);
    let urls: Vec<String> = stories.iter().map(|s| s.url.clone()).collect();
    let pages = read_pages(host, budget, &urls, &confirmed)?;
    if pages.len() < 2 {
        return Ok(());
    }
    match propose(host, budget, &pages, &confirmed)? {
        Some(rule) => write(host, id, vec![("photo_rule_json", rule.to_value()), ("photo_rule_state", json!("in_use")), ("photo_miss_streak", json!(0)), ("photo_relook_at", Value::Null), ("photo_last_outcome", json!("working"))]),
        None => write(host, id, vec![("photo_relook_at", json!(iso(now + RELOOK_MS)))]),
    }
}

/// Photos for one source's stories, then the source's photo record, the once-a-day relook and a
/// sweep of the person's copies. Returns the number of stories that now have a photo.
pub fn run<H: Host + ?Sized>(host: &H, budget: &Budget, source: &Value, stories: &[Story]) -> Result<usize> {
    let id = source["id"].as_str().unwrap_or_default();
    let now = now_ms(host)?;
    let confirmed = confirmed_hosts(source);
    let state = source["photo_rule_state"].as_str().unwrap_or("none");
    let rule = (state == "in_use").then(|| validate(&source["photo_rule_json"], &confirmed)).flatten();
    let stories = &stories[..stories.len().min(STORIES_PER_SOURCE)];
    let mut pass = Pass { host, budget, source_id: id, confirmed: &confirmed, rule: rule.as_ref(), pages_left: PAGES_PER_SOURCE, existing: store::existing(host)?, now };
    let (mut found, mut missed, mut links) = (0, 0, Vec::new());
    for story in stories {
        match pass.story(story)? {
            Outcome::Working(key) => {
                found += 1;
                links.push((story.id.clone(), key));
            }
            Outcome::Nothing => missed += 1,
            Outcome::Skipped => {}
        }
    }
    store::set_links(host, &links, now)?;
    if found > 0 || missed > 0 {
        if let Some(changes) = next_record(state, source["photo_miss_streak"].as_i64().unwrap_or(0), found > 0) {
            write(host, id, changes)?;
        }
    }
    if found == 0 {
        relook(host, budget, source, stories, now)?;
    }
    store::sweep(host, now)?;
    Ok(found)
}

