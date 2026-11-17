//! Part 5b: refresh state, the two queues, the daily schedule, source health and drift.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const FEED: &str = "https://daily.example.com/feed.xml";
const MARK: &str = "PLANTED-MARKER-4f1c9b";
const RSS: &str = "<rss><channel><title>Daily</title><item><title>Alpha story</title><link>https://daily.example.com/a</link><pubDate>Fri, 06 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>";
const APPROVE: &str = r#"{"allowed":true,"category":"news_publisher"}"#;

fn source(fake: &Fake, who: &'static str, fingerprint: &str, health: &str, status: &str) -> String {
    fake.seed(
        "app.news_custom_sources",
        who,
        json!({
            "label": "Daily Example", "canonical_domain": "daily.example.com",
            "homepage_url": "https://daily.example.com/", "feed_url": FEED,
            "retrieval_method": "feed", "validation_status": status, "health_status": health,
            "validation_fingerprint": fingerprint,
        }),
    )
}

fn state(fake: &Fake) -> Value {
    fake.rows("app.news_refresh_state").into_iter().find(|r| r["owner_user_id"] == fake.actor.get()).expect("a state row")
}

fn health_of(fake: &Fake, id: &str) -> (String, String, Value) {
    let row = fake.rows("app.news_custom_sources").into_iter().find(|r| r["id"] == id).unwrap();
    (
        row["health_status"].as_str().unwrap().into(),
        row["validation_status"].as_str().unwrap().into(),
        row["validation_fingerprint"].clone(),
    )
}

#[test]
fn a_change_records_a_generation_and_queues_one_job() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.route("POST", "/prefs", &[], json!({"kind":"source","key":"bbc"}));
    assert_eq!(state(&fake)["state"], "queued");
    assert_eq!(state(&fake)["requested_generation"], 1);
    assert_eq!(fake.open_jobs("news-refresh"), 1);
    // A second change before the job runs bumps the generation but queues nothing more.
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    assert_eq!(state(&fake)["requested_generation"], 2);
    assert_eq!(fake.open_jobs("news-refresh"), 1);
    let job = fake.jobs.borrow()[0].3.clone();
    assert_eq!(job, json!({"kind":"user_refresh"}));
}

#[test]
fn a_finished_run_stores_the_page_and_records_history() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    fake.refresh();
    let row = state(&fake);
    assert_eq!(row["state"], "idle");
    assert_eq!(row["compiled_generation"], row["requested_generation"]);
    assert!(row["last_success_at"].is_string() && row["last_attempt_at"].is_string() && row["last_requested_at"].is_string());
    assert!(row["failure_kind"].is_null());
    assert_eq!(fake.rows("app.news_compilation_snapshots").len(), 1);
    let (_, body) = fake.route("GET", "/personalization", &[], json!(null));
    assert_eq!(body["refresh"]["state"], "idle");
    assert!(body["refresh"]["lastSuccessAt"].is_string());
}

#[test]
fn a_failed_run_keeps_the_last_page_and_records_why() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.seed(
        "app.news_compilation_snapshots",
        A,
        json!({"compiled_at":"2026-11-01T10:00:00.000Z","expires_at":"2026-11-02T10:00:00.000Z","payload":{"articles":[]}}),
    );
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    fake.refresh();
    let row = state(&fake);
    assert_eq!(row["state"], "failed");
    assert_eq!(row["failure_kind"], "fetch");
    assert_eq!(row["last_failure_kind"], "fetch");
    assert!(row["last_failure_at"].is_string());
    assert_eq!(fake.rows("app.news_compilation_snapshots")[0]["compiled_at"], "2026-11-01T10:00:00.000Z");
    // The next change clears the live failure but keeps the history.
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"science"}));
    let row = state(&fake);
    assert!(row["failure_kind"].is_null());
    assert_eq!(row["last_failure_kind"], "fetch");
}

#[test]
fn a_run_overtaken_by_a_newer_change_stores_nothing_and_starts_over() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    // A change lands while the first run is ranking.
    *fake.before_model.borrow_mut() = Some(Box::new(|f: &Fake| {
        f.route("POST", "/prefs", &[], json!({"kind":"topic","key":"science"}));
    }));
    fake.model_says(r#"{"rankings":[]}"#);
    fake.model_says(r#"{"rankings":[]}"#);
    let answer = fake.run_job("news-refresh").unwrap();
    assert!(answer.contains("\"ok\":true"), "{answer}");
    let row = state(&fake);
    assert_eq!(row["requested_generation"], 2);
    // The second pass of the same job compiled for the newest generation.
    assert_eq!(row["compiled_generation"], 2);
    assert_eq!(row["state"], "idle");
    assert_eq!(fake.rows("app.news_compilation_snapshots").len(), 1);
}

#[test]
fn the_daily_check_is_scheduled_once_per_person_with_sources() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    fake.as_actor(B);
    // B has nothing added, so a change leaves no schedule.
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    assert_eq!(fake.schedules.borrow().len(), 1);
    source(&fake, B, "host-ai-v1", "healthy", "approved");
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"science"}));
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"business"}));
    let schedules = fake.schedules.borrow();
    assert_eq!(schedules.len(), 2);
    for ((_, queue, _), plan) in schedules.iter() {
        assert_eq!(queue, "news-revalidate");
        assert_eq!(plan["cron"], "43 4 * * *");
        assert_eq!(plan["timezone"], "UTC");
        assert_eq!(plan["params"], json!({"kind":"revalidate"}));
    }
}

#[test]
fn removing_the_last_added_source_removes_the_schedule() {
    let fake = Fake::new();
    let id = source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    assert_eq!(fake.schedules.borrow().len(), 1);
    fake.route("DELETE", "/sources/:id", &[("id", &id)], json!(null));
    assert_eq!(fake.schedules.borrow().len(), 0);
}

#[test]
fn drift_queues_exactly_one_revalidation() {
    let fake = Fake::new();
    source(&fake, A, "some-older-model", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/refresh", &[], json!(null));
    fake.refresh();
    assert_eq!(fake.open_jobs("news-revalidate"), 1);
    // Another refresh while that job is open adds nothing.
    fake.route("POST", "/refresh", &[], json!(null));
    fake.refresh();
    assert_eq!(fake.open_jobs("news-revalidate"), 1);
}

#[test]
fn no_drift_means_no_revalidation() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/refresh", &[], json!(null));
    fake.refresh();
    assert_eq!(fake.open_jobs("news-revalidate"), 0);
}

#[test]
fn an_unreachable_source_becomes_unavailable_and_one_notice_goes_out() {
    let fake = Fake::new();
    let id = source(&fake, A, "some-older-model", "healthy", "approved");
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    let (health, status, fingerprint) = health_of(&fake, &id);
    assert_eq!((health.as_str(), status.as_str()), ("temporarily_unavailable", "needs_revalidation"));
    assert_eq!(fingerprint, json!("host-ai-v1"));
    assert_eq!(fake.notices.borrow().len(), 1);
    let notice = fake.notices.borrow()[0].1.clone();
    assert_eq!(notice["text"], "News sources need attention");
    // A second run finds the same trouble and stays quiet.
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert_eq!(fake.notices.borrow().len(), 1);
    // Health on screen comes from the stored row.
    let (_, body) = fake.route("GET", "/personalization", &[], json!(null));
    assert_eq!(body["customSources"][0]["healthStatus"], "temporarily_unavailable");
}

#[test]
fn a_reachable_source_the_model_approves_is_healthy_under_the_new_fingerprint() {
    let fake = Fake::new();
    let id = source(&fake, A, "some-older-model", "temporarily_unavailable", "needs_revalidation");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.model_says(APPROVE);
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert_eq!(health_of(&fake, &id), ("healthy".into(), "approved".into(), json!("host-ai-v1")));
    assert!(fake.notices.borrow().is_empty());
}

#[test]
fn a_model_refusal_is_recorded_and_no_answer_keeps_the_old_fingerprint() {
    let fake = Fake::new();
    let refused = source(&fake, A, "some-older-model", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.model_says(r#"{"allowed":false,"category":"other"}"#);
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert_eq!(health_of(&fake, &refused).1, "rejected");
    // With nothing queued the model call fails, which reads as no answer.
    let silent = source(&fake, A, "some-older-model", "healthy", "approved");
    fake.rows("app.news_custom_sources");
    fake.tables.borrow_mut().get_mut("app.news_custom_sources").unwrap().iter_mut().for_each(|r| {
        if r["id"] == silent.as_str() {
            r["canonical_domain"] = json!("other.example.com");
        }
    });
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    let (_, status, fingerprint) = health_of(&fake, &silent);
    assert_eq!(status, "needs_revalidation");
    assert_eq!(fingerprint, json!("some-older-model"));
}

#[test]
fn a_current_source_is_skipped_and_an_unavailable_one_recovers() {
    let fake = Fake::new();
    let fine = source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert!(fake.fetched().is_empty());
    assert_eq!(health_of(&fake, &fine).0, "healthy");
    let down = source(&fake, A, "host-ai-v1", "temporarily_unavailable", "approved");
    fake.tables.borrow_mut().get_mut("app.news_custom_sources").unwrap().iter_mut().for_each(|r| {
        if r["id"] == down.as_str() {
            r["canonical_domain"] = json!("other.example.com");
        }
    });
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert_eq!(health_of(&fake, &down).0, "healthy");
    assert_eq!(fake.model_calls(), 0);
}

#[test]
fn a_failed_sign_in_is_never_cleared_by_the_daily_check() {
    let fake = Fake::new();
    let id = source(&fake, A, "some-older-model", "authentication_failed", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.model_says(APPROVE);
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate").unwrap();
    assert_eq!(health_of(&fake, &id).0, "authentication_failed");
}

#[test]
fn a_saved_topic_is_checked_too() {
    let fake = Fake::new();
    let topic = fake.seed(
        "app.news_custom_topics",
        A,
        json!({"label":"Space","guidance":null,"validation_status":"needs_revalidation","validation_fingerprint":null}),
    );
    fake.model_says(r#"{"allowed":true,"category":"news_topic"}"#);
    fake.route("POST", "/revalidation", &[], json!(null));
    let answer = fake.run_job("news-revalidate").unwrap();
    assert!(answer.contains("\"topicsChecked\":1"), "{answer}");
    let row = fake.rows("app.news_custom_topics").into_iter().find(|r| r["id"] == topic.as_str()).unwrap();
    assert_eq!(row["validation_status"], "approved");
    assert_eq!(row["validation_fingerprint"], "host-ai-v1");
}

#[test]
fn deliveries_must_be_metadata_only_and_match_their_queue() {
    let fake = Fake::new();
    let bad = [
        json!({"queue":"news-refresh","parameters":{"kind":"user_refresh"},"title":MARK}),
        json!({"queue":"news-refresh","parameters":{"kind":"revalidate"}}),
        json!({"queue":"news-revalidate","parameters":{"kind":"user_refresh"}}),
        json!({"queue":"news-refresh","parameters":{"kind":"user_refresh","extra":MARK}}),
        json!({"queue":"other","parameters":{"kind":"user_refresh"}}),
    ];
    for payload in bad {
        assert!(moss_news_module::handle(&fake, "job", &payload.to_string()).is_err(), "{payload}");
    }
}

#[test]
fn typed_text_never_reaches_a_job_a_notice_or_the_job_calls() {
    let fake = Fake::new();
    fake.seed(
        "app.news_custom_sources",
        A,
        json!({
            "label": MARK, "canonical_domain": "daily.example.com",
            "homepage_url": "https://daily.example.com/", "feed_url": FEED, "retrieval_method": "feed",
            "validation_status": "approved", "health_status": "healthy", "validation_fingerprint": "old",
        }),
    );
    fake.seed(
        "app.news_custom_topics",
        A,
        json!({"label":MARK,"guidance":MARK,"validation_status":"approved","validation_fingerprint":"old"}),
    );
    fake.route("POST", "/refresh", &[], json!(null));
    fake.refresh();
    fake.route("POST", "/revalidation", &[], json!(null));
    fake.run_job("news-revalidate");
    for (port, _, _, parameters) in fake.calls.borrow().iter().filter(|c| c.0 == "jobs" || c.0 == "notify") {
        assert!(!parameters.to_string().contains(MARK), "{port} {parameters}");
    }
    assert!(fake.notices.borrow().iter().all(|(_, p)| !p.to_string().contains(MARK)));
    assert!(fake.schedules.borrow().values().all(|p| !p.to_string().contains(MARK)));
}

#[test]
fn another_person_has_their_own_state_and_jobs() {
    let fake = Fake::new();
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    fake.as_actor(B);
    assert_eq!(fake.open_jobs("news-refresh"), 0);
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    assert_eq!(fake.rows("app.news_refresh_state").len(), 2);
    assert_eq!(state(&fake)["requested_generation"], 1);
    assert_eq!(fake.jobs.borrow().len(), 2);
}

#[test]
fn a_request_made_while_a_job_runs_still_queues_a_job() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    fake.route("POST", "/prefs", &[], json!({"kind":"topic","key":"technology"}));
    assert_eq!(fake.open_jobs("news-refresh"), 1);
    let seen = std::rc::Rc::new(std::cell::Cell::new(usize::MAX));
    let probe = seen.clone();
    // The running job still counts as open on the real queue, so only a pending job may suppress a new one.
    *fake.before_model.borrow_mut() = Some(Box::new(move |f: &Fake| {
        f.route("POST", "/prefs", &[], json!({"kind":"topic","key":"science"}));
        probe.set(f.open_jobs("news-refresh"));
    }));
    fake.model_says(r#"{"rankings":[]}"#);
    fake.model_says(r#"{"rankings":[]}"#);
    fake.run_job("news-refresh").unwrap();
    assert_eq!(seen.get(), 1, "a change during a run must queue a follow-up job");
}

#[test]
fn the_first_job_creates_the_state_row_when_it_runs_before_the_request_commits() {
    let fake = Fake::new();
    source(&fake, A, "host-ai-v1", "healthy", "approved");
    fake.page(FEED, 200, "application/rss+xml", RSS);
    assert!(fake.rows("app.news_refresh_state").is_empty());
    fake.model_says(r#"{"rankings":[]}"#);
    let answer = fake.run_job_unqueued("news-refresh");
    assert!(answer.contains("\"stored\":true"), "{answer}");
    assert_eq!(state(&fake)["state"], "idle");
}
