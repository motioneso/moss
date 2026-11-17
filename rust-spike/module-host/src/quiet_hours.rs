//! The one quiet-hours schedule an account follows, read from its preferences.
//!
//! Mirrors the settings module's authority rules. A Profile schedule governs when it is marked
//! canonical, when no older alert schedule exists, or when both mean the same thing. A conflict
//! or a malformed value means no deferral, as in the Node server.
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::Value;
use uuid::Uuid;

const PROFILE_KEY: &str = "quiet-hours";
const ALERTS_KEY: &str = "proactive.monitoring.v1";
const LOCALE_KEY: &str = "locale";
const DEFAULT_ZONE: &str = "America/Los_Angeles";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Window {
    pub start: String,
    pub end: String,
    pub zone: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Schedule {
    enabled: bool,
    start: String,
    end: String,
    zone: Option<String>,
}

enum Side {
    Absent,
    Malformed,
    Present(Schedule),
}

fn local_time(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let b = text.as_bytes();
    let ok = b.len() == 5
        && b[2] == b':'
        && matches!((b[0], b[1]), (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit();
    ok.then(|| text.to_owned())
}

fn profile_side(value: Option<&Value>, zone_ok: &dyn Fn(&str) -> bool) -> Side {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Side::Absent;
    };
    let Some(map) = value.as_object() else {
        return Side::Malformed;
    };
    let (Some(enabled), Some(start), Some(end)) = (
        map.get("enabled").and_then(Value::as_bool),
        local_time(map.get("start")),
        local_time(map.get("end")),
    ) else {
        return Side::Malformed;
    };
    let zone = match map.get("timezone") {
        None | Some(Value::Null) => None,
        Some(Value::String(z)) if z.is_empty() => None,
        Some(Value::String(z)) if zone_ok(z) => Some(z.clone()),
        Some(_) => return Side::Malformed,
    };
    Side::Present(Schedule { enabled, start, end, zone })
}

fn alerts_side(value: Option<&Value>) -> Side {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Side::Absent;
    };
    let Some(map) = value.as_object() else {
        return Side::Malformed;
    };
    let Some(quiet) = map.get("quietHours") else {
        return Side::Absent;
    };
    let Some(quiet) = quiet.as_object() else {
        return Side::Malformed;
    };
    let (Some(start), Some(end)) = (
        local_time(quiet.get("startLocalTime")),
        local_time(quiet.get("endLocalTime")),
    ) else {
        return Side::Malformed;
    };
    Side::Present(Schedule {
        enabled: quiet.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        start,
        end,
        zone: None,
    })
}

/// The window alerts are held back in, or `None` when nothing is deferred.
pub(crate) fn classify(
    profile: Option<&Value>,
    alerts: Option<&Value>,
    locale: Option<&Value>,
    zone_ok: &dyn Fn(&str) -> bool,
) -> Option<Window> {
    let owner = locale
        .and_then(|v| v.get("timezone"))
        .and_then(Value::as_str)
        .filter(|z| z.len() <= 100 && zone_ok(z))
        .unwrap_or(DEFAULT_ZONE)
        .to_owned();
    let marker = match profile.and_then(Value::as_object).and_then(|m| m.get("authority")) {
        None => None,
        Some(Value::String(s)) if s == "canonical" || s == "unresolved" => Some(s.as_str()),
        Some(_) => return None,
    };
    let profile = profile_side(profile, zone_ok);
    let alerts = alerts_side(alerts);
    let chosen = match (marker, profile, alerts) {
        (_, Side::Malformed, _) => return None,
        (Some("canonical"), Side::Present(p), _) => p,
        (Some("unresolved"), ..) => return None,
        (_, _, Side::Malformed) => return None,
        (_, Side::Absent, Side::Absent) => return None,
        (_, Side::Absent, Side::Present(a)) => a,
        (_, Side::Present(p), Side::Absent) => p,
        (_, Side::Present(p), Side::Present(a)) => {
            let same = p.enabled == a.enabled
                && p.start == a.start
                && p.end == a.end
                && p.zone.as_deref().unwrap_or(&owner) == owner;
            if !same {
                return None;
            }
            p
        }
    };
    chosen.enabled.then(|| Window {
        zone: chosen.zone.unwrap_or(owner),
        start: chosen.start,
        end: chosen.end,
    })
}

/// Reads the actor's three preference rows and returns their quiet window.
pub(crate) async fn window(cx: &DataContext, actor: Uuid) -> Result<Option<Window>> {
    let rows = cx
        .db()
        .query(
            "SELECT key, value_json FROM app.preferences WHERE owner_user_id=$1 AND key=ANY($2)",
            &[&actor, &vec![PROFILE_KEY, ALERTS_KEY, LOCALE_KEY]],
        )
        .await?;
    let find = |key: &str| {
        rows.iter()
            .find(|r| r.get::<_, String>(0) == key)
            .map(|r| r.get::<_, Value>(1))
    };
    let (profile, alerts, locale) = (find(PROFILE_KEY), find(ALERTS_KEY), find(LOCALE_KEY));
    let mut zones: Vec<String> = Vec::new();
    for value in [&profile, &locale].into_iter().flatten() {
        if let Some(z) = value.get("timezone").and_then(Value::as_str) {
            zones.push(z.to_owned());
        }
    }
    let known: Vec<String> = cx
        .db()
        .query("SELECT name FROM pg_timezone_names WHERE name=ANY($1)", &[&zones])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    Ok(classify(
        profile.as_ref(),
        alerts.as_ref(),
        locale.as_ref(),
        &|zone| known.iter().any(|k| k == zone),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all(_: &str) -> bool {
        true
    }

    #[test]
    fn nothing_saved_means_no_deferral() {
        assert_eq!(classify(None, None, None, &all), None);
    }

    #[test]
    fn profile_window_uses_its_own_zone_else_the_owner_zone() {
        let profile = json!({"enabled":true,"start":"22:00","end":"07:00","timezone":"Europe/London"});
        let w = classify(Some(&profile), None, None, &all).unwrap();
        assert_eq!((w.start.as_str(), w.zone.as_str()), ("22:00", "Europe/London"));
        let profile = json!({"enabled":true,"start":"22:00","end":"07:00"});
        let locale = json!({"timezone":"Asia/Tokyo"});
        assert_eq!(classify(Some(&profile), None, Some(&locale), &all).unwrap().zone, "Asia/Tokyo");
        assert_eq!(classify(Some(&profile), None, None, &all).unwrap().zone, DEFAULT_ZONE);
    }

    #[test]
    fn disabled_means_no_deferral() {
        let profile = json!({"enabled":false,"start":"22:00","end":"07:00"});
        assert_eq!(classify(Some(&profile), None, None, &all), None);
    }

    #[test]
    fn older_alert_schedule_applies_when_profile_is_absent() {
        let alerts = json!({"quietHours":{"enabled":true,"startLocalTime":"21:30","endLocalTime":"06:00"}});
        assert_eq!(classify(None, Some(&alerts), None, &all).unwrap().start, "21:30");
    }

    #[test]
    fn conflicting_schedules_defer_nothing_until_profile_is_canonical() {
        let profile = json!({"enabled":true,"start":"22:00","end":"07:00"});
        let alerts = json!({"quietHours":{"enabled":true,"startLocalTime":"21:30","endLocalTime":"06:00"}});
        assert_eq!(classify(Some(&profile), Some(&alerts), None, &all), None);
        let marked = json!({"enabled":true,"start":"22:00","end":"07:00","authority":"canonical"});
        assert_eq!(classify(Some(&marked), Some(&alerts), None, &all).unwrap().end, "07:00");
        let frozen = json!({"enabled":true,"start":"22:00","end":"07:00","authority":"unresolved"});
        assert_eq!(classify(Some(&frozen), Some(&alerts), None, &all), None);
    }

    #[test]
    fn malformed_values_defer_nothing() {
        for bad in [
            json!({"enabled":true,"start":"25:00","end":"07:00"}),
            json!({"enabled":"yes","start":"22:00","end":"07:00"}),
            json!({"enabled":true,"start":"22:00","end":"07:00","timezone":"Nowhere/Land"}),
            json!("text"),
        ] {
            let known = |z: &str| z != "Nowhere/Land";
            assert_eq!(classify(Some(&bad), None, None, &known), None, "{bad}");
        }
    }
}
