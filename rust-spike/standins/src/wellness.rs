//! Invented Wellness data for tests: check-ins, medicines, dose logs and therapy notes for two
//! made-up people. Nothing here is real, and nothing ships. Rows use the field names the old
//! Wellness routes return, so a later part can post them or compare answers directly.
//!
//! Every private text value (check-in note, medicine name and note, dose, reason, therapy note)
//! holds one marker token that starts with `MKR-`. A leak test plants the rows, then searches
//! every log line, job payload, activity row and export for those tokens.

use serde_json::Value;

/// The fixed "now" the dose logs and check-ins are laid out around (a 30-day window ends here).
pub const REFERENCE_NOW: &str = "2026-03-15T12:00:00.000Z";

pub const ALICE_USER_ID: &str = "aaaaaaaa-0000-4000-8000-000000000001";
pub const BOB_USER_ID: &str = "bbbbbbbb-0000-4000-8000-000000000002";

const CHECKINS: &str = include_str!("../fixtures/wellness/checkins.json");
const MEDICATIONS: &str = include_str!("../fixtures/wellness/medications.json");
const DOSE_LOGS: &str = include_str!("../fixtures/wellness/dose_logs.json");
const THERAPY_NOTES: &str = include_str!("../fixtures/wellness/therapy_notes.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Person {
    Alice,
    Bob,
}

impl Person {
    pub fn user_id(self) -> &'static str {
        match self {
            Person::Alice => ALICE_USER_ID,
            Person::Bob => BOB_USER_ID,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Person::Alice => "alice",
            Person::Bob => "bob",
        }
    }
}

fn rows(file: &str, who: Person) -> Vec<Value> {
    let all: Value = serde_json::from_str(file).expect("wellness fixture is valid JSON");
    all[who.key()].as_array().cloned().expect("wellness fixture has a list per person")
}

pub fn checkins(who: Person) -> Vec<Value> {
    rows(CHECKINS, who)
}

pub fn medications(who: Person) -> Vec<Value> {
    rows(MEDICATIONS, who)
}

pub fn dose_logs(who: Person) -> Vec<Value> {
    rows(DOSE_LOGS, who)
}

pub fn therapy_notes(who: Person) -> Vec<Value> {
    rows(THERAPY_NOTES, who)
}

/// Fields that hold ids or fixed vocabulary. They carry no marker and no personal text.
const PLAIN_FIELDS: &[&str] = &[
    "id", "ownerUserId", "medicationId", "linkedCheckinId", "linkedEmotion", "feelingCore",
    "feelingSecondary", "feelingTertiary", "wheelVersion", "sensations", "identifiedVia",
    "frequencyType", "status", "form", "timeZone", "intervalUnit", "monthKind",
    "monthWeekdayPosition", "dosage",
];

/// String fields that must carry a marker, as `(field, row)` pairs for every row of one kind.
pub fn private_text_fields(row: &Value) -> Vec<(&str, &str)> {
    let Some(map) = row.as_object() else { return vec![] };
    map.iter()
        .filter_map(|(k, v)| {
            let s = v.as_str()?;
            let is_time = k.ends_with("At") || k.ends_with("For") || k.ends_with("Date");
            let is_clock = k == "scheduleTimes";
            (!PLAIN_FIELDS.contains(&k.as_str()) && !is_time && !is_clock).then_some((k.as_str(), s))
        })
        .collect()
}

/// Pulls the `MKR-...` token out of a string, if it has one.
pub fn marker_in(text: &str) -> Option<&str> {
    let start = text.find("MKR-")?;
    let rest = &text[start..];
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Every marker token planted for one person, in file order.
pub fn markers(who: Person) -> Vec<String> {
    let mut out = Vec::new();
    for row in checkins(who).iter().chain(&medications(who)).chain(&dose_logs(who)).chain(&therapy_notes(who)) {
        for (_, text) in private_text_fields(row) {
            if let Some(m) = marker_in(text) {
                out.push(m.to_string());
            }
        }
    }
    out
}

/// Reasons a value looks like real personal data. Empty means it passed. Allowed: addresses at
/// `example.com` or `example.invalid`. Refused: other addresses, web links and long digit runs
/// (phone, card or ID numbers) in any text field that is not an id or timestamp.
pub fn personal_data_problems(row: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(map) = row.as_object() else { return problems };
    for (key, v) in map {
        if matches!(key.as_str(), "id" | "ownerUserId" | "medicationId" | "linkedCheckinId") {
            continue;
        }
        let mut texts = Vec::new();
        match v {
            Value::String(s) => texts.push(s.as_str()),
            Value::Array(a) => texts.extend(a.iter().filter_map(Value::as_str)),
            _ => {}
        }
        for t in texts {
            if let Some(at) = t.find('@') {
                let domain = t[at + 1..].split(|c: char| c.is_whitespace()).next().unwrap_or("");
                if !(domain.ends_with("example.com") || domain.ends_with("example.invalid")) {
                    problems.push(format!("{key}: address outside example.com"));
                }
            }
            if t.contains("http://") || t.contains("https://") || t.contains("www.") {
                problems.push(format!("{key}: web link"));
            }
            let mut run = 0;
            let mut longest = 0;
            for c in t.chars() {
                run = if c.is_ascii_digit() { run + 1 } else { 0 };
                longest = longest.max(run);
            }
            if longest >= 7 {
                problems.push(format!("{key}: digit run of {longest}"));
            }
        }
    }
    problems
}
