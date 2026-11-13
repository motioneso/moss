//! The evening day math, ported from the old suite's lens tests with the same days and times.
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use moss_briefings_module::lenses::{filter_calendar, local_day, local_day_start, partition};
use serde_json::{json, Value};

const LA: Tz = chrono_tz::America::Los_Angeles;

/// 2026-07-02 21:00 in Los Angeles.
fn now() -> DateTime<Utc> {
    "2026-07-03T04:00:00.000Z".parse().unwrap()
}

fn titles(items: &[Value]) -> Vec<&str> {
    items.iter().map(|e| e["title"].as_str().unwrap()).collect()
}

#[test]
fn a_utc_instant_maps_to_the_owners_local_day() {
    assert_eq!(local_day(&json!("2026-07-03T02:30:00.000Z"), LA).unwrap().to_string(), "2026-07-02");
    assert!(local_day(&json!("not-a-date"), LA).is_none());
    assert!(local_day(&json!(42), LA).is_none());
}

#[test]
fn local_midnight_is_a_utc_instant_with_the_days_own_offset() {
    let start = |at: &str, zone: Tz| local_day_start(at.parse().unwrap(), zone).unwrap().to_rfc3339();
    assert_eq!(start("2026-07-03T04:00:00Z", LA), "2026-07-02T07:00:00+00:00");
    assert_eq!(start("2026-07-03T04:00:00Z", chrono_tz::UTC), "2026-07-03T00:00:00+00:00");
    // 2026-11-01 in Los Angeles starts in summer time and ends in winter time.
    assert_eq!(start("2026-11-01T20:00:00Z", LA), "2026-11-01T07:00:00+00:00");
}

fn task(title: &str, field: &str, at: &str) -> Value {
    json!({"id": format!("t-{title}"), "title": title, "status": "todo", field: at})
}

#[test]
fn tasks_split_into_done_today_slipped_and_carrying_forward_on_the_local_day() {
    let completed = [
        task("done-today", "completedAt", "2026-07-03T06:59:00.000Z"),
        task("done-tomorrow", "completedAt", "2026-07-03T07:01:00.000Z"),
    ];
    let open = [
        task("slipped-due", "dueAt", "2026-07-03T01:00:00.000Z"),
        task("slipped-do", "doAt", "2026-07-02T20:00:00.000Z"),
        task("carrying", "dueAt", "2026-06-30T12:00:00.000Z"),
        task("future", "dueAt", "2026-07-10T12:00:00.000Z"),
        json!({"id": "t-dateless", "title": "dateless"}),
    ];
    let lenses = partition(&completed, &open, now(), LA);
    let names = |items: &[moss_briefings_module::lenses::EveningTask]| items.iter().map(|t| t.title.clone()).collect::<Vec<_>>();
    assert_eq!(names(&lenses.completed_today), ["done-today"]);
    assert_eq!(names(&lenses.slipped), ["slipped-due", "slipped-do"]);
    assert_eq!(names(&lenses.carrying_forward), ["carrying"]);
}

#[test]
fn the_calendar_keeps_tomorrow_and_the_evening_still_ahead() {
    let events = [
        json!({"startsAt": "2026-07-02T16:00:00.000Z", "title": "this-morning"}),
        json!({"startsAt": "2026-07-03T05:00:00.000Z", "title": "tonight"}),
        json!({"startsAt": "2026-07-03T17:00:00.000Z", "title": "tomorrow-mtg"}),
        json!({"startsAt": "2026-07-04T17:00:00.000Z", "title": "day-after"}),
        json!({"title": "no-start"}),
    ];
    assert_eq!(titles(&filter_calendar(&events, now(), LA)), ["tonight", "tomorrow-mtg"]);
}

#[test]
fn all_day_events_compare_by_calendar_date_not_by_local_instant() {
    let all_day = |title: &str, from: &str, to: &str| json!({"allDay": true, "startsAt": from, "endsAt": to, "title": title});
    let events = [
        all_day("tomorrow-all-day", "2026-07-03T00:00:00.000Z", "2026-07-04T00:00:00.000Z"),
        all_day("day-after-all-day", "2026-07-04T00:00:00.000Z", "2026-07-05T00:00:00.000Z"),
        all_day("today-all-day", "2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"),
        all_day("multi-day-spanning-tomorrow", "2026-07-01T00:00:00.000Z", "2026-07-04T00:00:00.000Z"),
    ];
    assert_eq!(titles(&filter_calendar(&events, now(), LA)), ["tomorrow-all-day", "multi-day-spanning-tomorrow"]);
}

#[test]
fn tomorrow_is_right_across_the_fall_back_day() {
    // 2026-11-01 in Los Angeles is 25 hours long. This is the evening of October 31.
    let at: DateTime<Utc> = "2026-11-01T04:00:00.000Z".parse().unwrap();
    let events = [json!({"startsAt": "2026-11-01T20:00:00.000Z", "title": "nov-1-noon"})];
    assert_eq!(titles(&filter_calendar(&events, at, LA)), ["nov-1-noon"]);
}
