use chrono::{TimeZone, Utc};
use moss_briefings_module::schedule::*;
use serde_json::json;

fn meta(value: serde_json::Value) -> Metadata {
    value.as_object().cloned().unwrap()
}

fn daily<'a>(metadata: &'a Metadata) -> Scheduled<'a> {
    Scheduled { id: "d1", briefing_type: "morning", cadence: "daily", enabled: true, metadata }
}

#[test]
fn cron_follows_the_target_time_and_weekday() {
    assert_eq!(cron_expr_for("daily", &meta(json!({"targetTime":"6:30"}))), "30 6 * * *");
    assert_eq!(cron_expr_for("daily", &meta(json!({}))), "0 7 * * *");
    assert_eq!(cron_expr_for("daily", &meta(json!({"targetTime":"25:00"}))), "0 7 * * *");
    assert_eq!(cron_expr_for("weekly", &meta(json!({"targetTime":"09:15","dayOfWeek":3}))), "15 9 * * 3");
    assert_eq!(cron_expr_for("weekly", &meta(json!({"targetTime":"09:15"}))), "15 9 * * 1");
}

#[test]
fn zones_fall_back_to_utc() {
    assert_eq!(timezone_for(&meta(json!({"timezone":"Asia/Tokyo"}))), "Asia/Tokyo");
    assert_eq!(timezone_for(&meta(json!({"timezone":"Nowhere/Land"}))), "UTC");
    assert_eq!(timezone_for(&meta(json!({}))), "UTC");
}

#[test]
fn a_matching_zone_always_runs() {
    let m = meta(json!({"targetTime":"07:00"}));
    let now = Utc.with_ymd_and_hms(2026, 11, 11, 3, 0, 0).unwrap();
    let out = align_fire(&daily(&m), Some("Europe/London"), "Europe/London", now);
    assert_eq!(out, Alignment { realigned: false, run: true });
    assert_eq!(align_fire(&daily(&m), None, "Europe/London", now), out);
}

#[test]
fn a_zone_change_realigns_and_runs_only_inside_the_grace() {
    let m = meta(json!({"targetTime":"07:00"}));
    // 07:30 in Auckland (UTC+13 in November) is 18:30 UTC the day before.
    let inside = Utc.with_ymd_and_hms(2026, 11, 10, 18, 30, 0).unwrap();
    assert_eq!(
        align_fire(&daily(&m), Some("Europe/London"), "Pacific/Auckland", inside),
        Alignment { realigned: true, run: true }
    );
    // Three hours and one minute after 07:00 is past the grace.
    let late = Utc.with_ymd_and_hms(2026, 11, 10, 21, 1, 0).unwrap();
    assert_eq!(
        align_fire(&daily(&m), Some("Europe/London"), "Pacific/Auckland", late),
        Alignment { realigned: true, run: false }
    );
    // Before the target time the fire belongs to the previous day's slot.
    let early = Utc.with_ymd_and_hms(2026, 11, 10, 17, 0, 0).unwrap();
    assert!(!fires_within_grace(&daily(&m), "Pacific/Auckland", early));
}

#[test]
fn the_grace_edge_is_exactly_180_minutes() {
    let m = meta(json!({"targetTime":"07:00"}));
    let at = |hour, minute| Utc.with_ymd_and_hms(2026, 1, 15, hour, minute, 0).unwrap();
    assert!(fires_within_grace(&daily(&m), "UTC", at(10, 0)));
    assert!(!fires_within_grace(&daily(&m), "UTC", at(10, 1)));
    assert!(fires_within_grace(&daily(&m), "UTC", at(7, 0)));
    assert!(!fires_within_grace(&daily(&m), "UTC", at(6, 59)));
}

#[test]
fn a_weekly_fire_must_land_on_the_target_weekday_in_the_owner_zone() {
    let m = meta(json!({"targetTime":"09:00","dayOfWeek":0}));
    let weekly = Scheduled { id: "w1", briefing_type: "weekly_review", cadence: "weekly", enabled: true, metadata: &m };
    // Sunday 2026-11-15 09:30 in Tokyo is 00:30 UTC the same day.
    let sunday = Utc.with_ymd_and_hms(2026, 11, 15, 0, 30, 0).unwrap();
    assert!(fires_within_grace(&weekly, "Asia/Tokyo", sunday));
    // The same instant is still Saturday in Los Angeles.
    assert!(!fires_within_grace(&weekly, "America/Los_Angeles", sunday));
}

#[test]
fn daylight_saving_shifts_the_utc_instant_but_not_the_local_slot() {
    let m = meta(json!({"targetTime":"07:00"}));
    // London is UTC+0 in winter and UTC+1 in summer.
    let winter = Utc.with_ymd_and_hms(2026, 1, 15, 7, 30, 0).unwrap();
    let summer = Utc.with_ymd_and_hms(2026, 7, 15, 6, 30, 0).unwrap();
    assert!(fires_within_grace(&daily(&m), "Europe/London", winter));
    assert!(fires_within_grace(&daily(&m), "Europe/London", summer));
    assert!(!fires_within_grace(&daily(&m), "Europe/London", Utc.with_ymd_and_hms(2026, 7, 15, 7, 30, 0).unwrap() + chrono::Duration::hours(3)));
}
