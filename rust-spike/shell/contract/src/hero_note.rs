//! The Today hero's briefing note, computed from the caller's saved Briefings records.
//!
//! Pure rules with no clock or network, so they test natively. The browser supplies the
//! local time. Wording follows `apps/web/src/today/today-hero.tsx` (`morningNotReadyReason`).

use serde::Deserialize;

pub const OFF_NOTE: &str = "Your morning briefing is switched off.";
pub const FAILED_NOTE: &str = "Today's briefing failed to run.";
pub const BLOCKED_NOTE: &str = "Today's briefing was blocked.";
pub const GATHERING_NOTE: &str = "Gathering your morning briefing\u{2026}";
const DEFAULT_TARGET: &str = "07:00";

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleMetadata {
    #[serde(default)]
    pub target_time: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

/// One row of `GET /api/m/briefings/definitions`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefingDefinition {
    pub id: String,
    pub briefing_type: String,
    pub enabled: bool,
    #[serde(default)]
    pub schedule_metadata: ScheduleMetadata,
}

/// One row of `GET /api/m/briefings/definitions/:id/runs`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefingRun {
    pub status: String,
    #[serde(default)]
    pub summary_text: String,
    pub created_at: String,
}

/// `HH:MM` to minutes after midnight. Anything else is `None`.
pub fn parse_target_minutes(value: &str) -> Option<u32> {
    let (hours, minutes) = value.trim().split_once(':')?;
    if minutes.len() != 2 || hours.is_empty() || hours.len() > 2 {
        return None;
    }
    let (h, m): (u32, u32) = (hours.parse().ok()?, minutes.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// "7:00 AM" for a minutes-after-midnight value.
fn clock_label(minutes: u32) -> String {
    let (h, m) = (minutes / 60, minutes % 60);
    let suffix = if h < 12 { "AM" } else { "PM" };
    let hour = match h % 12 {
        0 => 12,
        other => other,
    };
    format!("{hour}:{m:02} {suffix}")
}

/// The morning definition's target time in minutes after midnight (07:00 when unset).
pub fn morning_target_minutes(defs: &[BriefingDefinition]) -> u32 {
    let raw = defs
        .iter()
        .find(|d| d.briefing_type == "morning")
        .and_then(|d| d.schedule_metadata.target_time.as_deref())
        .filter(|t| !t.is_empty())
        .unwrap_or(DEFAULT_TARGET);
    parse_target_minutes(raw)
        .or_else(|| parse_target_minutes(DEFAULT_TARGET))
        .unwrap_or(420)
}

/// The note under the hero, or `None` when nothing should show.
///
/// `latest` is the newest morning run made today, if any. No morning schedule shows nothing.
/// A readable run (non-empty summary) hides the note.
pub fn hero_note(
    defs: &[BriefingDefinition],
    latest: Option<&BriefingRun>,
    now_local_minutes: u32,
) -> Option<String> {
    let morning = defs.iter().find(|d| d.briefing_type == "morning")?;
    if !morning.enabled {
        return Some(OFF_NOTE.into());
    }
    if latest.is_some_and(|r| !r.summary_text.trim().is_empty()) {
        return None;
    }
    match latest.map(|r| r.status.as_str()) {
        Some("failed") => return Some(FAILED_NOTE.into()),
        Some("blocked") => return Some(BLOCKED_NOTE.into()),
        Some("pending" | "running" | "queued") => return Some(GATHERING_NOTE.into()),
        _ => {}
    }
    let target = morning_target_minutes(defs);
    let time = clock_label(target);
    Some(if now_local_minutes >= target {
        format!("It should have run at {time}.")
    } else {
        format!("It runs at {time}.")
    })
}

/// Splits a `en-US` numeric stamp such as `11/19/2026, 07:05` into a day key
/// (`year * 10000 + month * 100 + day`) and minutes after midnight.
pub fn parse_local_stamp(stamp: &str) -> Option<(u32, u32)> {
    let nums: Vec<u32> = stamp
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let [month, day, year, hour, minute, ..] = nums[..] else {
        return None;
    };
    Some((year * 10_000 + month * 100 + day, (hour % 24) * 60 + minute))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(kind: &str, enabled: bool, target: Option<&str>) -> BriefingDefinition {
        BriefingDefinition {
            id: "d1".into(),
            briefing_type: kind.into(),
            enabled,
            schedule_metadata: ScheduleMetadata {
                target_time: target.map(str::to_owned),
                timezone: None,
            },
        }
    }

    fn run(status: &str, summary: &str) -> BriefingRun {
        BriefingRun {
            status: status.into(),
            summary_text: summary.into(),
            created_at: "2026-11-19T07:00:00Z".into(),
        }
    }

    #[test]
    fn no_schedule_shows_nothing() {
        assert_eq!(hero_note(&[], None, 600), None);
        assert_eq!(hero_note(&[def("evening", true, None)], None, 600), None);
    }

    #[test]
    fn switched_off_says_so() {
        let note = hero_note(&[def("morning", false, Some("07:00"))], None, 600);
        assert_eq!(note.as_deref(), Some(OFF_NOTE));
    }

    #[test]
    fn switched_off_wins_over_a_run() {
        let r = run("succeeded", "A summary");
        let note = hero_note(&[def("morning", false, None)], Some(&r), 600);
        assert_eq!(note.as_deref(), Some(OFF_NOTE));
    }

    #[test]
    fn failed_run_says_failed() {
        let r = run("failed", "");
        let note = hero_note(&[def("morning", true, Some("07:00"))], Some(&r), 600);
        assert_eq!(note.as_deref(), Some(FAILED_NOTE));
    }

    #[test]
    fn blocked_run_says_blocked() {
        let r = run("blocked", "  ");
        let note = hero_note(&[def("morning", true, Some("07:00"))], Some(&r), 600);
        assert_eq!(note.as_deref(), Some(BLOCKED_NOTE));
    }

    #[test]
    fn run_in_progress_says_gathering() {
        for status in ["pending", "running", "queued"] {
            let r = run(status, "");
            let note = hero_note(&[def("morning", true, Some("07:00"))], Some(&r), 600);
            assert_eq!(note.as_deref(), Some(GATHERING_NOTE));
        }
    }

    #[test]
    fn before_target_says_it_runs_at() {
        let note = hero_note(&[def("morning", true, Some("07:30"))], None, 6 * 60);
        assert_eq!(note.as_deref(), Some("It runs at 7:30 AM."));
    }

    #[test]
    fn after_target_says_it_should_have_run() {
        let note = hero_note(&[def("morning", true, Some("07:30"))], None, 8 * 60);
        assert_eq!(note.as_deref(), Some("It should have run at 7:30 AM."));
    }

    #[test]
    fn missing_target_uses_seven() {
        let note = hero_note(&[def("morning", true, None)], None, 0);
        assert_eq!(note.as_deref(), Some("It runs at 7:00 AM."));
    }

    #[test]
    fn readable_run_hides_the_note() {
        let r = run("succeeded", "Your day looks light.");
        assert_eq!(hero_note(&[def("morning", true, Some("07:00"))], Some(&r), 600), None);
    }

    #[test]
    fn empty_summary_run_is_not_readable() {
        let r = run("succeeded", "");
        let note = hero_note(&[def("morning", true, Some("07:00"))], Some(&r), 600);
        assert_eq!(note.as_deref(), Some("It should have run at 7:00 AM."));
    }

    #[test]
    fn noon_and_midnight_labels() {
        assert_eq!(clock_label(0), "12:00 AM");
        assert_eq!(clock_label(12 * 60), "12:00 PM");
        assert_eq!(clock_label(19 * 60 + 5), "7:05 PM");
    }

    #[test]
    fn stamp_parses_day_and_minutes() {
        assert_eq!(parse_local_stamp("11/19/2026, 07:05"), Some((20261119, 425)));
        assert_eq!(parse_local_stamp("11/19/2026, 24:00:00"), Some((20261119, 0)));
        assert_eq!(parse_local_stamp("garbage"), None);
    }

    #[test]
    fn definitions_decode_from_the_route_shape() {
        let json = r#"{"id":"a","ownerUserId":"u","briefingType":"morning","enabled":true,
            "scheduleMetadata":{"targetTime":"06:45","timezone":"UTC"},"title":"x"}"#;
        let d: BriefingDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(d.schedule_metadata.target_time.as_deref(), Some("06:45"));
    }
}
