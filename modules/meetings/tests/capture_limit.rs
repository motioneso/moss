//! Start budget rules ported from the TypeScript link security tests (T10).
use chrono::{DateTime, Duration, TimeZone, Utc};
use moss_meetings_module::capture_errors::{CaptureCode, Failure};
use moss_meetings_module::capture_limit::budget;

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 6, 12, 0, 0).unwrap()
}

#[test]
fn eleventh_start_in_a_minute_is_refused_with_an_exact_delay() {
    let at = base();
    let mut starts = vec![];
    for i in 0..10 {
        starts = budget(&starts, at + Duration::seconds(i)).expect("allowed");
    }
    starts.reverse();
    let refused = budget(&starts, at + Duration::seconds(10)).unwrap_err();
    assert_eq!(refused, Failure::rate_limited(50));
    assert_eq!(refused.status, 429);
    assert_eq!(budget(&starts, at + Duration::seconds(60)).unwrap().len(), 11);
}

#[test]
fn sixty_first_hourly_start_is_refused_and_old_entries_expire() {
    let at = base();
    let starts: Vec<_> = (0..60).map(|i| at - Duration::seconds(120 + i)).collect();
    assert_eq!(budget(&starts, at).unwrap_err(), Failure::rate_limited(3421));
    assert_eq!(budget(&starts, at + Duration::hours(1)).unwrap().len(), 1);
}

#[test]
fn a_refusal_body_carries_only_the_code_and_delay() {
    let body = Failure::rate_limited(7).body();
    assert_eq!(body["code"], CaptureCode::RateLimited.as_str());
    assert_eq!(body.as_object().unwrap().len(), 2);
}
