//! The proactive-card preference, refresh planning and card placement limits.

use serde_json::{json, Map, Value};

pub const SOURCES: [&str; 4] = ["tasks", "calendar", "email", "notes"];
/// A source scanned within this long ago is skipped by a manual refresh.
pub const REFRESH_COOLDOWN_MS: i64 = 15 * 60 * 1000;
pub const MAX_CARDS_LIMIT: i64 = 20;
const DEFAULT_LIMIT: i64 = 5;

const PREF_KEYS: [&str; 7] = [
    "version",
    "automaticEmailAlerts",
    "enabled",
    "sources",
    "dailyCardCap",
    "quietHours",
    "updatedAt",
];

pub fn default_preference() -> Value {
    let source = json!({"enabled": false, "dailyCardCap": 3});
    json!({
        "version": 1,
        "enabled": false,
        "sources": {"tasks": source, "calendar": source, "email": source, "notes": source},
        "dailyCardCap": 8,
        "quietHours": {"enabled": true, "startLocalTime": "22:00", "endLocalTime": "08:00"},
        "updatedAt": "1970-01-01T00:00:00.000Z",
    })
}

/// A parsed saved preference, merged over the defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct Preference {
    pub value: Value,
    pub has_legacy_email_choice: bool,
}

/// What is stored under the preference key.
#[derive(Clone, Debug, PartialEq)]
pub enum Saved {
    Missing,
    Malformed,
    Parsed(Preference),
}

fn local_time(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|t| {
        let b = t.as_bytes();
        b.len() == 5 && b[2] == b':' && b[..2].iter().chain(&b[3..]).all(u8::is_ascii_digit)
    })
}

fn within(value: Option<&Value>, low: f64, high: f64) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n >= low && n <= high)
}

fn only_keys(map: &Map<String, Value>, allowed: &[&str]) -> bool {
    map.keys().all(|k| allowed.contains(&k.as_str()))
}

fn valid(p: &Map<String, Value>) -> bool {
    if !only_keys(p, &PREF_KEYS) || p.get("version") != Some(&json!(1)) {
        return false;
    }
    if p.get("automaticEmailAlerts").is_some_and(|v| !v.is_boolean()) {
        return false;
    }
    if !p.get("enabled").is_some_and(Value::is_boolean)
        || !within(p.get("dailyCardCap"), 1.0, 20.0)
        || !p.get("updatedAt").is_some_and(Value::is_string)
    {
        return false;
    }
    let Some(sources) = p.get("sources").and_then(Value::as_object) else { return false };
    if !only_keys(sources, &SOURCES) {
        return false;
    }
    for name in SOURCES {
        let Some(s) = sources.get(name).and_then(Value::as_object) else { return false };
        if !only_keys(s, &["enabled", "dailyCardCap"])
            || !s.get("enabled").is_some_and(Value::is_boolean)
            || !within(s.get("dailyCardCap"), 1.0, 5.0)
        {
            return false;
        }
    }
    let Some(q) = p.get("quietHours").and_then(Value::as_object) else { return false };
    only_keys(q, &["enabled", "startLocalTime", "endLocalTime"])
        && q.get("enabled").is_some_and(Value::is_boolean)
        && local_time(q.get("startLocalTime"))
        && local_time(q.get("endLocalTime"))
}

/// Merges a stored record over the defaults and validates it. `None` means malformed.
pub fn parse_preference(raw: &Value) -> Option<Preference> {
    let p = raw.as_object()?;
    if p.get("version") != Some(&json!(1)) {
        return None;
    }
    let defaults = default_preference();
    let defaults = defaults.as_object()?;
    let sources = p.get("sources");
    let quiet = p.get("quietHours");
    if sources.is_some_and(|v| !v.is_object()) || quiet.is_some_and(|v| !v.is_object()) {
        return None;
    }
    let mut merged_sources = defaults["sources"].as_object()?.clone();
    for (name, value) in sources.and_then(Value::as_object).into_iter().flatten() {
        let next = match (value.as_object(), merged_sources.get(name).and_then(Value::as_object)) {
            (Some(over), Some(base)) => {
                let mut m = base.clone();
                m.extend(over.clone());
                Value::Object(m)
            }
            _ => value.clone(),
        };
        merged_sources.insert(name.clone(), next);
    }
    let mut merged_quiet = defaults["quietHours"].as_object()?.clone();
    merged_quiet.extend(quiet.and_then(Value::as_object).cloned().unwrap_or_default());
    let mut merged = defaults.clone();
    merged.extend(p.clone());
    merged.insert("sources".into(), Value::Object(merged_sources));
    merged.insert("quietHours".into(), Value::Object(merged_quiet));
    if !valid(&merged) {
        return None;
    }
    let has_legacy_email_choice = p.contains_key("enabled")
        || sources.and_then(Value::as_object).is_some_and(|s| s.contains_key("email"));
    Some(Preference { value: Value::Object(merged), has_legacy_email_choice })
}

pub fn saved_from(stored: Option<&Value>) -> Saved {
    match stored {
        None => Saved::Missing,
        Some(raw) => parse_preference(raw).map_or(Saved::Malformed, Saved::Parsed),
    }
}

/// The preference in force: the saved one, or the defaults when none or a malformed one is stored.
pub fn effective(saved: &Saved) -> Value {
    match saved {
        Saved::Parsed(p) => p.value.clone(),
        _ => default_preference(),
    }
}

/// Email alerts follow their own switch. No saved record means on, a malformed one means off,
/// and a record from before the switch keeps its master and email choices.
pub fn automatic_email_alerts(saved: &Saved) -> bool {
    match saved {
        Saved::Missing => true,
        Saved::Malformed => false,
        Saved::Parsed(p) => match p.value.get("automaticEmailAlerts").and_then(Value::as_bool) {
            Some(flag) => flag,
            None if p.has_legacy_email_choice => {
                p.value["enabled"] == json!(true) && p.value["sources"]["email"]["enabled"] == json!(true)
            }
            None => true,
        },
    }
}

pub fn source_enabled(saved: &Saved, source: &str) -> bool {
    if source == "email" {
        return automatic_email_alerts(saved);
    }
    let pref = effective(saved);
    pref["enabled"] == json!(true) && pref["sources"][source]["enabled"] == json!(true)
}

/// One scan the refresh route asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scan {
    pub source: &'static str,
    pub idempotency_key: String,
}

/// The scans a manual refresh enqueues. `age_ms` gives how long ago a source was last checked.
pub fn plan_refresh(
    saved: &Saved,
    registered: &[String],
    age_ms: &dyn Fn(&str) -> Option<i64>,
    now_ms: i64,
    actor: &str,
) -> Vec<Scan> {
    let slot = now_ms.div_euclid(REFRESH_COOLDOWN_MS);
    SOURCES
        .into_iter()
        .filter(|s| source_enabled(saved, s))
        .filter(|s| registered.iter().any(|r| r == s))
        .filter(|s| age_ms(s).map_or(true, |age| age >= REFRESH_COOLDOWN_MS))
        .map(|source| Scan {
            source,
            idempotency_key: format!("manual-refresh:{actor}:{source}:{slot}"),
        })
        .collect()
}

/// The card count a request asks for. Reads like the old server's parse, but a negative count
/// takes the default because it can never be a useful request.
pub fn parse_limit(raw: Option<&str>) -> i64 {
    let text = raw.unwrap_or("5").trim_start();
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    let n = digits[..end].parse::<i64>().unwrap_or(0) * sign;
    if n < 1 {
        DEFAULT_LIMIT
    } else {
        n.min(MAX_CARDS_LIMIT)
    }
}

/// Why a candidate card is held back, or `None` when it may be placed.
pub struct Counts {
    pub total_today: i64,
    pub source_today: i64,
    pub source_last_hour: i64,
}

pub fn placement_refusal(
    dismissed_recently: bool,
    counts: &Counts,
    pref: &Value,
    source: &str,
) -> Option<&'static str> {
    let global = pref["dailyCardCap"].as_f64().unwrap_or(8.0);
    let per_source = pref["sources"][source]["dailyCardCap"].as_f64().unwrap_or(3.0);
    if dismissed_recently {
        Some("dismissed_stable_key_suppressed")
    } else if counts.total_today as f64 >= global {
        Some("global_daily_cap")
    } else if counts.source_today as f64 >= per_source {
        Some("source_daily_cap")
    } else if counts.source_last_hour >= 1 {
        Some("source_hourly_cap")
    } else {
        None
    }
}
