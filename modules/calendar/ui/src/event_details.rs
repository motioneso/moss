//! Event details retain the authored Calendar structure and shared modal lifecycle.
use crate::model::{self, Event};
use chrono::Timelike;
use leptos::prelude::*;
use moss_module_ui::calendar::PeekPanel;

#[derive(Clone, Copy)]
enum Icon {
    Calendar,
    Block,
    Clock,
    Location,
    People,
}

// The same Lucide outlines used by the existing Calendar screen, with decorative SVGs
// kept out of the accessible name. No provider data or HTML enters these paths.
#[component]
fn DetailIcon(icon: Icon, #[prop(default = 15)] size: u16) -> impl IntoView {
    let shapes = match icon {
        Icon::Calendar => view! {
            <path d="M8 2v4m8-4v4M3 10h18"/>
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <path d="m9 16 2 2 4-4"/>
        }.into_any(),
        Icon::Block => view! {
            <circle cx="12" cy="12" r="3"/><path d="M3 12h6m6 0h6"/>
        }.into_any(),
        Icon::Clock => view! {
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
        }.into_any(),
        Icon::Location => view! {
            <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/>
            <circle cx="12" cy="10" r="3"/>
        }.into_any(),
        Icon::People => view! {
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
            <circle cx="9" cy="7" r="4"/>
        }.into_any(),
    };
    view! {<svg width=size height=size viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{shapes}</svg>}
}

#[component]
pub fn EventDetails(
    event: Event,
    timezone: String,
    twelve: bool,
    on_close: Callback<()>,
    #[prop(default = "Moss".to_string())] assistant_name: String,
) -> impl IntoView {
    let zone = model::zone(&timezone).unwrap_or(chrono_tz::UTC);
    let starts = chrono::DateTime::parse_from_rfc3339(&event.starts_at)
        .ok()
        .map(|d| d.with_timezone(&zone));
    let ends = chrono::DateTime::parse_from_rfc3339(&event.ends_at)
        .ok()
        .map(|d| d.with_timezone(&zone));
    let (time, duration) = if event.all_day {
        ("All day".into(), None)
    } else {
        match (starts, ends) {
            (Some(a), Some(b)) => (
                format!(
                    "{} – {}",
                    model::time(a.hour() * 60 + a.minute(), twelve),
                    model::time(b.hour() * 60 + b.minute(), twelve)
                ),
                Some(model::duration(
                    ((b - a).num_milliseconds() as f64 / 60000.0 + 0.5).floor() as i64,
                )),
            ),
            _ => ("Time unavailable".into(), None),
        }
    };
    let dates = model::date_range(&event, zone);
    let tentative = matches!(event.status.as_deref(), Some("tentative" | "needsAction"));
    let state = if event.is_moss_block {
        format!("{assistant_name} is holding this")
    } else if event.unconfirmed {
        "Needs verification in Outlook".into()
    } else if tentative {
        "Awaiting RSVP".into()
    } else {
        "On your calendar".into()
    };
    let detail_status = if event.is_moss_block {
        format!("{assistant_name} focus block")
    } else if event.read_only {
        if event.unconfirmed {
            "Needs verification".into()
        } else {
            "Observed in Outlook".into()
        }
    } else if tentative {
        "Pending RSVP".into()
    } else {
        "Accepted".into()
    };
    let icon = if event.is_moss_block {
        Icon::Block
    } else {
        Icon::Calendar
    };
    let color = if event.is_moss_block {
        "--ev:var(--accent-fg)"
    } else {
        "--ev:var(--steel)"
    };
    view! {<PeekPanel on_close=on_close>
        <div class="cal-peek__head"><span class=if event.is_moss_block {"cal-peek__kind cal-peek__kind--block"} else {"cal-peek__kind"}><DetailIcon icon=icon size=13/>{state}</span></div>
        <div class="cal-peek__titlewrap"><span class="cal-peek__mark" style=color><DetailIcon icon=icon size=18/></span><h2 class="cal-peek__title">{event.title}</h2></div>
        {event.read_only.then(||view!{<p>"Outlook · Read only. Check or change this event in Outlook."</p>})}
        <div class="cal-peek__rows">
            <div class="cal-peek__row"><span class="ic"><DetailIcon icon=Icon::Clock/></span><div>
                <div class="cal-peek__rowmain">{time}{duration.map(|value|view!{<span class="cal-peek__dur">{format!(" · {value}")}</span>})}</div>
                <div class="cal-peek__rowsub">{dates}</div>
                <div class="cal-peek__rowsub">{timezone}</div>
            </div></div>
            {event.location.filter(|value|!value.is_empty()).map(|where_|view!{
                <div class="cal-peek__row"><span class="ic"><DetailIcon icon=Icon::Location/></span><div class="cal-peek__rowmain">{where_}</div></div>
            })}
            {(event.attendee_count>0.0).then(||view!{
                <div class="cal-peek__row"><span class="ic"><DetailIcon icon=Icon::People/></span><div class="cal-peek__rowmain">{format!("{} {}",event.attendee_count,if event.attendee_count==1.0 {"person"}else{"people"})}</div></div>
            })}
            <div class="cal-peek__row"><span class="ic"><span class="cal-peek__catdot" style=format!("background:{}", if event.is_moss_block {"var(--accent-fg)"} else {"var(--steel)"}) aria-hidden="true"></span></span><div class="cal-peek__rowmain">{detail_status}</div></div>
        </div>
        {event.is_moss_block.then(||view!{<div class="cal-peek__held"><DetailIcon icon=Icon::Block size=14/><span>{format!("{assistant_name} can move or shorten this block when your day changes. Hard events always come first.")}</span></div>})}
    </PeekPanel>}
}
