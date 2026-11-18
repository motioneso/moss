//! What the Outlook calendar shows, read from rendered labels. Ported from the old source tests.
use moss_connectors::outlook_source::{display_time_zone, normalize_label as normalize, parse_week_header};

const ZONE: &str = "America/Los_Angeles";

#[test]
fn identity_comes_from_the_occurrence_key_not_title_or_time() {
    let a = normalize("source-occurrence", "Invented meeting, 10:30 PM to 11:00 PM, Wednesday, October 21, 2026, Busy", ZONE).unwrap();
    let b = normalize("source-occurrence", "Edited meeting, 9:30 PM to 10:00 PM, Wednesday, October 21, 2026, Busy", ZONE).unwrap();
    assert_eq!(a.occurrence_key, b.occurrence_key);
    assert_eq!(a.starts_at, "2026-10-22T05:30:00.000Z");
    assert_eq!(b.starts_at, "2026-10-22T04:30:00.000Z");
}

#[test]
fn simultaneous_events_stay_distinct() {
    let label = "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy";
    assert_ne!(normalize("a", label, ZONE).unwrap().occurrence_key, normalize("b", label, ZONE).unwrap().occurrence_key);
}

#[test]
fn commas_in_titles_stay_and_a_charm_prefix_goes() {
    let a = normalize("a", "Exam icon, Invented, meeting, 12 PM to 1 PM, Wednesday, October 21, 2026, Busy", ZONE).unwrap();
    assert_eq!(a.title, "Invented, meeting");
    assert_eq!(a.starts_at, "2026-10-21T19:00:00.000Z");
}

#[test]
fn all_day_labels_become_exclusive_end_dates() {
    let a = normalize("a", "Invented day, all day event, Wednesday, October 21, 2026, Free", ZONE).unwrap();
    let b = normalize("b", "Invented days, all day event, Wednesday, October 21, 2026 to Friday, October 23, 2026, Free", ZONE).unwrap();
    assert_eq!((a.starts_at.as_str(), a.ends_at.as_str()), ("2026-10-21T00:00:00.000Z", "2026-10-22T00:00:00.000Z"));
    assert_eq!(b.ends_at, "2026-10-24T00:00:00.000Z");
    assert!(b.all_day);
    let dst = normalize("a", "Invented days, all day event, Saturday, October 31, 2026 to Monday, November 2, 2026, Busy", ZONE).unwrap();
    assert_eq!((dst.starts_at.as_str(), dst.ends_at.as_str()), ("2026-10-31T00:00:00.000Z", "2026-11-03T00:00:00.000Z"));
}

#[test]
fn the_confirmed_zone_decides_the_offset() {
    assert_eq!(display_time_zone("(UTC-08:00) Pacific Time (US & Canada)"), Ok(ZONE));
    let event = normalize("a", "Invented meeting, 10 AM to 11 AM, Monday, November 2, 2026, Busy", ZONE).unwrap();
    assert_eq!(event.starts_at, "2026-11-02T18:00:00.000Z");
    assert_eq!(display_time_zone("Unknown zone").unwrap_err().code, "source-changed");
}

#[test]
fn ambiguous_or_unsupported_timing_is_refused_without_echoing_content() {
    for label in [
        "Invented meeting, 1:30 AM to 2:30 AM, Sunday, November 1, 2026, Busy",
        "Invented meeting, 2:30 AM to 3:30 AM, Sunday, March 8, 2026, Busy",
        "Invented meeting, 13 PM to 2 PM, Wednesday, October 21, 2026, Busy",
        "Invented meeting, 11 PM to 1 AM, Wednesday, October 21, 2026, Busy",
        "Invented meeting, 10 AM to 11 AM, Monday, February 30, 2026, Busy",
        "Unsupported label",
        "Invented, 10 AM to 11 AM, Wednesday, October 21, 2026, 1 PM to 2 PM, Wednesday, October 21, 2026, Busy",
        "Invented, all day event, Thursday, October 21, 2026, Busy",
    ] {
        let error = normalize("a", label, ZONE).unwrap_err();
        assert_eq!(error.code, "partial", "{label}");
        assert!(!format!("{error:?}").contains("Invented"));
    }
    assert_eq!(normalize("", "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy", ZONE).unwrap_err().code, "partial");
    assert_eq!(normalize("a", "Invented, all day event, Wednesday, October 21, 2026, Busy", "Unknown/Zone").unwrap_err().code, "partial");
}

#[test]
fn the_week_header_is_checked_exactly() {
    let tail = ", Jump to a specific date or date range.";
    let week = |text: &str| parse_week_header(&format!("{text}{tail}"));
    assert_eq!(week("October 18\u{2013}24, 2026"), Ok(("2026-10-18".into(), "2026-10-25".into())));
    assert_eq!(week("November 29 \u{2013} December 5, 2026"), Ok(("2026-11-29".into(), "2026-12-06".into())));
    assert_eq!(week("December 27, 2026 \u{2013} January 2, 2027"), Ok(("2026-12-27".into(), "2027-01-03".into())));
    assert_eq!(week("October 18\u{2013}23, 2026").unwrap_err().code, "source-changed");
    assert_eq!(parse_week_header("Something else").unwrap_err().code, "source-changed");
}
