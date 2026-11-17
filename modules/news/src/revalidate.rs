//! The daily check of every saved source and topic. It re-reads each source, asks the person's
//! model again when the earlier verdict is old, and records the health and verdict it finds.
//! One notification goes out, with counts only, when something newly needs attention.
use crate::personalization::{SOURCES, TOPICS};
use crate::policy::{self, Subject, Verdict};
use crate::util::{now, values};
use crate::web;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use moss_news_reader::{html::{extract_listing_headlines, sample_feed_headlines}, subreddit_name_from_url};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const HEADLINE_SAMPLE_CAP: usize = 10;

fn needs_attention_source(row: &Value) -> bool {
    row["validation_status"] != "approved" || row["health_status"] != "healthy"
}

fn needs_attention_topic(row: &Value) -> bool {
    row["validation_status"] != "approved"
}

/// Headlines from the source's page or feed, or None when it cannot be read.
fn sample<H: Host + ?Sized>(host: &H, source: &Value) -> Option<Vec<String>> {
    let homepage = source["homepage_url"].as_str().unwrap_or_default();
    let address = source["feed_url"].as_str().unwrap_or(homepage);
    if source["retrieval_method"] == "reddit" {
        let name = subreddit_name_from_url(Some(address))?;
        let read = crate::resolve::read_subreddit_for_compile(host, &name)?;
        return Some(read.into_iter().take(HEADLINE_SAMPLE_CAP).map(|item| item.title).collect());
    }
    let fetched = web::get(host, address, None).ok()?;
    let found = if source["retrieval_method"] == "feed" {
        sample_feed_headlines(&fetched.body, HEADLINE_SAMPLE_CAP)
    } else {
        extract_listing_headlines(&fetched.body, homepage, HEADLINE_SAMPLE_CAP)
    };
    Some(found.into_iter().map(|item| item.headline).collect())
}

fn update<H: Host + ?Sized>(host: &H, table: &str, id: &str, mut set: Vec<(&str, Value)>) -> Result<()> {
    let at = now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    set.push(("updated_at", json!(at)));
    Client(host).query(table, &Query::update(Filter::eq("id", id), values(set)))?;
    Ok(())
}

fn validation(status: &str, fingerprint: Option<&str>, at: &str) -> Vec<(&'static str, Value)> {
    let mut set = vec![("validation_status", json!(status)), ("validated_at", json!(at))];
    if let Some(fingerprint) = fingerprint {
        set.push(("validation_fingerprint", json!(fingerprint)));
    }
    set
}

fn check_source<H: Host + ?Sized>(host: &H, source: &Value, at: &str) -> Result<bool> {
    let id = source["id"].as_str().unwrap_or_default();
    let health = source["health_status"].as_str().unwrap_or("healthy");
    let current = source["validation_status"] == "approved"
        && source["validation_fingerprint"].as_str() == Some(policy::FINGERPRINT);
    if current {
        // A source marked temporarily unavailable is read again so it can recover.
        // Only the credentialed path clears a failed sign-in.
        if health == "temporarily_unavailable" {
            if sample(host, source).is_some() {
                update(host, SOURCES, id, vec![("health_status", json!("healthy"))])?;
            }
            return Ok(true);
        }
        return Ok(false);
    }
    let Some(headlines) = sample(host, source) else {
        if health != "authentication_failed" {
            update(host, SOURCES, id, vec![("health_status", json!("temporarily_unavailable"))])?;
        }
        update(host, SOURCES, id, validation("needs_revalidation", Some(policy::FINGERPRINT), at))?;
        return Ok(true);
    };
    let subject = Subject {
        canonical_domain: source["canonical_domain"].as_str().unwrap_or_default(),
        description: source["label"].as_str().unwrap_or_default(),
        headlines: &headlines,
        community: source["retrieval_method"] == "reddit",
    };
    match policy::decide(host, &subject, true)? {
        Verdict::Approved => {
            update(host, SOURCES, id, validation("approved", Some(policy::FINGERPRINT), at))?;
            if health != "authentication_failed" {
                update(host, SOURCES, id, vec![("health_status", json!("healthy"))])?;
            }
        }
        Verdict::Rejected => update(host, SOURCES, id, validation("rejected", Some(policy::FINGERPRINT), at))?,
        // The model gave no answer. The stored fingerprint stays, so nothing claims a new check.
        Verdict::Unavailable => update(host, SOURCES, id, validation("needs_revalidation", None, at))?,
    }
    Ok(true)
}

fn check_topic<H: Host + ?Sized>(host: &H, topic: &Value, at: &str) -> Result<bool> {
    if topic["validation_status"] == "approved"
        && topic["validation_fingerprint"].as_str() == Some(policy::FINGERPRINT)
    {
        return Ok(false);
    }
    let id = topic["id"].as_str().unwrap_or_default();
    let verdict = policy::decide_topic(host, topic["label"].as_str().unwrap_or_default(), topic["guidance"].as_str())?;
    let set = match verdict {
        Verdict::Approved => validation("approved", Some(policy::FINGERPRINT), at),
        Verdict::Rejected => validation("rejected", Some(policy::FINGERPRINT), at),
        Verdict::Unavailable => validation("needs_revalidation", None, at),
    };
    update(host, TOPICS, id, set)?;
    Ok(true)
}

fn ids(rows: &[Value], needs: fn(&Value) -> bool) -> BTreeSet<String> {
    rows.iter().filter(|row| needs(row)).filter_map(|row| row["id"].as_str().map(str::to_owned)).collect()
}

/// Runs the check for the person and returns counts only.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let all = Query::select(Filter::All);
    let sources = client.query(SOURCES, &all)?;
    let topics = client.query(TOPICS, &all)?;
    let at = now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (mut sources_checked, mut topics_checked) = (0, 0);
    for source in &sources {
        sources_checked += usize::from(check_source(host, source, &at)?);
    }
    for topic in &topics {
        topics_checked += usize::from(check_topic(host, topic, &at)?);
    }
    let sources_after = client.query(SOURCES, &all)?;
    let topics_after = client.query(TOPICS, &all)?;
    let before_sources = ids(&sources, needs_attention_source);
    let before_topics = ids(&topics, needs_attention_topic);
    let after_sources = ids(&sources_after, needs_attention_source);
    let after_topics = ids(&topics_after, needs_attention_topic);
    let transitioned =
        !after_sources.is_subset(&before_sources) || !after_topics.is_subset(&before_topics);
    if transitioned {
        // Counts stay out of the text, and the key keeps a repeat on the same day quiet.
        let day = &at[..10];
        host.call(
            "notify",
            "post",
            "news",
            json!({"text":"News sources need attention","urgency":"normal","eventKey":format!("news-attention-{day}")}),
        )?;
    }
    Ok(json!({
        "sourcesChecked": sources_checked, "topicsChecked": topics_checked,
        "sourcesNeedingAttention": after_sources.len(), "topicsNeedingAttention": after_topics.len(),
        "transitionedToAttention": transitioned,
    }))
}
