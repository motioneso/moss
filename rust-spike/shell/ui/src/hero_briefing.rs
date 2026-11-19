//! Reads the caller's Briefings records and turns them into the Today hero note.
//! The rule itself lives in `moss_shell_contract::hero_note` so it tests natively.

use moss_shell_contract::hero_note::{
    hero_note, parse_local_stamp, BriefingDefinition, BriefingRun,
};
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue};

use crate::api;

#[derive(Deserialize)]
struct Definitions {
    definitions: Vec<BriefingDefinition>,
}

#[derive(Deserialize)]
struct Runs {
    runs: Vec<BriefingRun>,
}

/// The browser's local day key and minutes for an instant in `zone`, or the browser zone
/// when `zone` is missing or not valid. `instant` is `None` for now.
fn local_stamp(instant: Option<&str>, zone: Option<&str>) -> Option<(u32, u32)> {
    let date = match instant {
        Some(text) => js_sys::Date::new(&JsValue::from_str(text)),
        None => js_sys::Date::new_0(),
    };
    if date.get_time().is_nan() {
        return None;
    }
    let format = |zone: Option<&str>| -> Option<String> {
        let options = js_sys::Object::new();
        let set = |k: &str, v: &str| {
            let _ = js_sys::Reflect::set(&options, &k.into(), &v.into());
        };
        if let Some(zone) = zone {
            set("timeZone", zone);
        }
        for key in ["year", "month", "day", "hour", "minute"] {
            set(key, if key == "year" { "numeric" } else { "2-digit" });
        }
        set("hourCycle", "h23");
        // Called through a Function so an invalid zone comes back as an error, not a trap.
        let method = js_sys::Reflect::get(&date, &"toLocaleString".into())
            .ok()?
            .dyn_into::<js_sys::Function>()
            .ok()?;
        method
            .call2(&date, &"en-US".into(), &options)
            .ok()?
            .as_string()
    };
    parse_local_stamp(&format(zone).or_else(|| format(None))?)
}

/// The note to show under the hero, or `None` to show nothing. A Briefings package that does
/// not answer shows nothing. An answered-but-empty list shows nothing as well.
pub async fn load_note() -> Option<String> {
    let defs = api::get_json::<Definitions>("/api/m/briefings/definitions")
        .await
        .ok()?
        .definitions;
    let morning = defs.iter().find(|d| d.briefing_type == "morning")?;
    let zone = morning.schedule_metadata.timezone.clone();
    let (today, now_minutes) = local_stamp(None, zone.as_deref())?;
    let latest = if morning.enabled {
        let runs = api::get_json::<Runs>(&format!(
            "/api/m/briefings/definitions/{}/runs",
            morning.id
        ))
        .await
        .map(|r| r.runs)
        .unwrap_or_default();
        runs.into_iter()
            .filter(|r| local_stamp(Some(&r.created_at), zone.as_deref()).map(|s| s.0) == Some(today))
            .max_by_key(|r| js_sys::Date::parse(&r.created_at) as i64)
    } else {
        None
    };
    hero_note(&defs, latest.as_ref(), now_minutes)
}
