//! The invented Wellness data holds together: right shapes, the old database rules, one marker per
//! private text value, and nothing that looks like a real person.
use moss_standins::wellness::*;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};

const PEOPLE: [Person; 2] = [Person::Alice, Person::Bob];

const CHECKIN_KEYS: &[&str] = &["id", "ownerUserId", "checkedInAt", "feelingCore", "feelingSecondary", "feelingTertiary", "wheelVersion", "sensations", "intensity", "energy", "note", "identifiedVia", "createdAt"];
const MEDICATION_KEYS: &[&str] = &["id", "ownerUserId", "name", "dosage", "form", "frequencyType", "timesPerDay", "intervalHours", "weekdays", "scheduleTimes", "cycleDaysOn", "cycleDaysOff", "cycleAnchorDate", "active", "notes", "scheduleStartDate", "scheduleEndDate", "timeZone", "intervalUnit", "intervalCount", "monthKind", "monthDay", "monthDayIsLast", "monthWeekdayPosition", "monthWeekday", "remindersEnabled", "createdAt", "updatedAt"];
const LOG_KEYS: &[&str] = &["id", "medicationId", "status", "dose", "prnReason", "scheduledFor", "loggedAt"];
const NOTE_KEYS: &[&str] = &["id", "ownerUserId", "body", "linkedCheckinId", "linkedEmotion", "createdAt", "updatedAt"];
const CORES: &[&str] = &["happy", "sad", "fear", "anger", "disgust", "surprise"];

fn keys(row: &Value) -> BTreeSet<&str> {
    row.as_object().unwrap().keys().map(String::as_str).collect()
}

fn s<'a>(row: &'a Value, k: &str) -> Option<&'a str> {
    row[k].as_str()
}

fn all_rows(who: Person) -> Vec<Value> {
    let mut v = checkins(who);
    v.extend(medications(who));
    v.extend(dose_logs(who));
    v.extend(therapy_notes(who));
    v
}

#[test]
fn rows_have_exactly_the_old_route_fields() {
    for who in PEOPLE {
        for (rows, want) in [(checkins(who), CHECKIN_KEYS), (medications(who), MEDICATION_KEYS), (dose_logs(who), LOG_KEYS), (therapy_notes(who), NOTE_KEYS)] {
            assert!(!rows.is_empty());
            for r in rows {
                assert_eq!(keys(&r), want.iter().copied().collect::<BTreeSet<_>>(), "{r}");
            }
        }
    }
}

#[test]
fn rows_follow_the_old_database_rules() {
    for who in PEOPLE {
        let meds = medications(who);
        let checkin_ids: HashSet<String> = checkins(who).iter().map(|c| s(c, "id").unwrap().to_string()).collect();
        for c in checkins(who) {
            assert_eq!(s(&c, "ownerUserId"), Some(who.user_id()));
            assert!(CORES.contains(&s(&c, "feelingCore").unwrap()));
            for f in ["intensity", "energy"] {
                if let Some(n) = c[f].as_i64() {
                    assert!((1..=5).contains(&n), "{f}");
                }
            }
            assert!(matches!(s(&c, "identifiedVia"), Some("wheel" | "assisted")));
            assert!(c["feelingTertiary"].is_null() || !c["feelingSecondary"].is_null());
        }
        for m in &meds {
            assert_eq!(s(m, "ownerUserId"), Some(who.user_id()));
            assert!(!s(m, "name").unwrap().trim().is_empty());
            let count = |k: &str| m[k].as_array().map_or(0, Vec::len);
            let ft = s(m, "frequencyType").unwrap();
            match ft {
                "once_daily" | "specific_weekdays" | "cyclical" => assert!(count("scheduleTimes") >= 1, "{ft}"),
                "times_per_day" => assert_eq!(count("scheduleTimes") as i64, m["timesPerDay"].as_i64().unwrap()),
                "as_needed" => {
                    for k in ["scheduleTimes", "timesPerDay", "intervalHours", "weekdays", "cycleAnchorDate", "cycleDaysOn", "cycleDaysOff"] {
                        assert!(m[k].is_null(), "as_needed must not set {k}");
                    }
                    assert_eq!(m["remindersEnabled"], json!(false));
                }
                other => panic!("fixture uses an unexpected frequency {other}"),
            }
            if ft == "specific_weekdays" {
                assert!(m["weekdays"].as_array().unwrap().iter().all(|d| (1..=7).contains(&d.as_i64().unwrap())));
            }
            if ft == "cyclical" {
                assert!(!m["cycleAnchorDate"].is_null() && !m["cycleDaysOn"].is_null());
            }
        }
        let mut seen = HashSet::new();
        for l in dose_logs(who) {
            let med = meds.iter().find(|m| m["id"] == l["medicationId"]).expect("log belongs to this person's medicine");
            let status = s(&l, "status").unwrap();
            assert!(matches!(status, "taken" | "skipped" | "prn"));
            if status == "prn" {
                assert!(s(&l, "prnReason").is_some_and(|r| !r.trim().is_empty()));
                assert_eq!(s(med, "frequencyType"), Some("as_needed"));
            } else {
                assert!(!l["scheduledFor"].is_null());
            }
            if let Some(at) = s(&l, "scheduledFor") {
                assert!(seen.insert((s(&l, "medicationId").unwrap().to_string(), at.to_string())), "one log per dose slot");
            }
        }
        for n in therapy_notes(who) {
            assert_eq!(s(&n, "ownerUserId"), Some(who.user_id()));
            assert!(!s(&n, "body").unwrap().trim().is_empty());
            if let Some(id) = s(&n, "linkedCheckinId") {
                assert!(checkin_ids.contains(id), "linked check-in belongs to the same person");
            }
            assert!(n["linkedEmotion"].is_null() || CORES.contains(&s(&n, "linkedEmotion").unwrap()));
        }
    }
}

#[test]
fn the_data_covers_the_cases_later_parts_need() {
    let a = Person::Alice;
    let cores: BTreeSet<_> = checkins(a).iter().map(|c| s(c, "feelingCore").unwrap().to_string()).collect();
    assert_eq!(cores.len(), 6, "every core feeling appears");
    assert!(checkins(a).iter().any(|c| c["note"].is_null()) && checkins(a).iter().any(|c| c["intensity"].as_i64().is_some()));
    assert!(checkins(a).iter().any(|c| c["intensity"].is_null() && c["energy"].is_null()), "a check-in with no numbers");
    let kinds: BTreeSet<_> = medications(a).iter().map(|m| s(m, "frequencyType").unwrap().to_string()).collect();
    assert_eq!(kinds.len(), 5);
    assert!(medications(a).iter().any(|m| m["active"] == json!(false)));
    let statuses: BTreeSet<_> = dose_logs(a).iter().map(|l| s(l, "status").unwrap().to_string()).collect();
    assert_eq!(statuses.len(), 3);
    let note_kinds = therapy_notes(a);
    assert!(note_kinds.iter().any(|n| !n["linkedCheckinId"].is_null()) && note_kinds.iter().any(|n| !n["linkedEmotion"].is_null()) && note_kinds.iter().any(|n| n["linkedCheckinId"].is_null() && n["linkedEmotion"].is_null()));
    assert!(!dose_logs(Person::Bob).is_empty() && !therapy_notes(Person::Bob).is_empty());
}

#[test]
fn every_row_sits_inside_the_thirty_day_window() {
    let now = chrono::DateTime::parse_from_rfc3339(REFERENCE_NOW).unwrap();
    for who in PEOPLE {
        for row in all_rows(who) {
            for k in ["checkedInAt", "loggedAt", "scheduledFor", "createdAt"] {
                if let Some(t) = s(&row, k) {
                    let t = chrono::DateTime::parse_from_rfc3339(t).unwrap();
                    let age = (now - t).num_days();
                    assert!((0..=45).contains(&age) || k == "createdAt" && age <= 60, "{k} {t} is outside the window");
                }
            }
        }
    }
}

#[test]
fn ids_are_unique_and_owned_by_the_right_person() {
    let is_uuid = |t: &str| {
        let parts: Vec<_> = t.split('-').collect();
        parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && t.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
    };
    assert!(is_uuid(Person::Alice.user_id()) && is_uuid(Person::Bob.user_id()));
    let mut ids = HashSet::new();
    for who in PEOPLE {
        for row in all_rows(who) {
            let id = s(&row, "id").unwrap();
            assert!(is_uuid(id), "{id} is not a valid uuid");
            assert!(ids.insert(id.to_string()), "duplicate id");
            for k in ["ownerUserId", "medicationId", "linkedCheckinId"] {
                if let Some(v) = s(&row, k) {
                    assert!(is_uuid(v), "{k} {v} is not a valid uuid");
                }
            }
        }
    }
    assert_ne!(Person::Alice.user_id(), Person::Bob.user_id());
}

#[test]
fn every_private_text_value_carries_one_unique_marker() {
    let mut all = HashSet::new();
    for who in PEOPLE {
        let mut count = 0;
        for row in all_rows(who) {
            for (field, text) in private_text_fields(&row) {
                let m = marker_in(text).unwrap_or_else(|| panic!("{field} has private text with no marker: {text}"));
                assert!(all.insert(m.to_string()), "marker {m} is used twice");
                count += 1;
            }
        }
        assert_eq!(markers(who).len(), count);
        assert!(count >= 10, "enough private values to search for");
    }
    let (a, b) = (markers(Person::Alice).join(" "), markers(Person::Bob).join(" "));
    assert!(!a.contains("-B-") && !b.contains("-A-"), "markers name their owner");
    for row in all_rows(Person::Bob) {
        assert!(!row.to_string().contains("-A-0"), "no Alice marker inside Bob's rows");
    }
}

#[test]
fn nothing_looks_like_real_personal_data() {
    for who in PEOPLE {
        for row in all_rows(who) {
            assert_eq!(personal_data_problems(&row), Vec::<String>::new(), "{row}");
        }
    }
}

#[test]
fn the_personal_data_check_catches_planted_real_looking_values() {
    let hits = |v: Value| personal_data_problems(&v).len();
    assert_eq!(hits(json!({"note": "call me at 5551234567"})), 1);
    assert_eq!(hits(json!({"note": "mail a.person@gmail.com"})), 1);
    assert_eq!(hits(json!({"body": "see https://clinic.test/page"})), 1);
    assert_eq!(hits(json!({"body": "mail a.person@example.com"})), 0);
    assert_eq!(hits(json!({"id": "c1a00000-0000-4000-8000-000000000001"})), 0);
}
