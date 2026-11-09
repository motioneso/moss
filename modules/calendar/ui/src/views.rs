use crate::model::{self, Event, Segment};
use chrono::{Datelike, NaiveDate};
use leptos::prelude::*;
use moss_module_ui::{calendar::*, Button, ButtonVariant, EmptyState};
use std::collections::BTreeMap;

#[component]
pub fn CalendarLegend(
    view: String,
    day: NaiveDate,
    today: NaiveDate,
    held: usize,
    #[prop(default = "Moss".into())] assistant_name: String,
) -> impl IntoView {
    // Use the authored Calendar swatch hooks from the shared kit; no local styling.
    (view != "month").then(|| view! {
        <div class="cal-legend">
            <span class="cal-legend__item"><span aria-hidden="true" class="cal-legend__sw cal-legend__sw--hard"></span>"Accepted"</span>
            <span class="cal-legend__item"><span aria-hidden="true" class="cal-legend__sw cal-legend__sw--hold"></span>{format!("{assistant_name} holding")}</span>
            {(view == "day" && day == today && held > 0).then(|| view! {
                <span class="cal-legend__note">{format!("{assistant_name} is holding {held} flexible block{} today.", if held == 1 {""} else {"s"})}</span>
            })}
        </div>
    })
}

#[component]
pub fn Month(
    cursor: NaiveDate,
    today: NaiveDate,
    events: BTreeMap<NaiveDate, Vec<Segment>>,
    twelve: bool,
    on_day: Callback<NaiveDate>,
    on_event: Callback<Event>,
) -> impl IntoView {
    view! {<div class="cal-month"><div class="cal-month__head">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].into_iter().map(|name| view!{<div class="cal-month__dow">{name}</div>}).collect_view()}</div>
    <div class="cal-month__grid">{model::month(cursor).into_iter().map(|day| {
        let mut entries = events.get(&day).cloned().unwrap_or_default();
        entries.sort_by_key(|e| (!e.event.all_day,e.start_min));
        let extra = entries.len().saturating_sub(3);
        view! {<DayCell focus_key=day.to_string() label=day.day().to_string() today=day==today outside=day.month()!=cursor.month() on_pick=Callback::new(move |_| on_day.run(day))>
            {entries.into_iter().take(3).map(|segment| {
                let e = segment.event;
                let time = if e.all_day || !segment.first_day {String::new()} else {model::time(segment.start_min,twelve)};
                let pick = e.clone();
                view! {<MonthChip focus_key=format!("{}:{}",day,e.id) title=e.title time=time block=e.is_moss_block on_pick=Callback::new(move |_|on_event.run(pick.clone()))/>}
            }).collect_view()}
            {(extra > 0).then(||view!{<button type="button" data-cal-focus=format!("{day}:more") class="cal-mmore" on:click=move |_|on_day.run(day)>{format!("{extra} more")}</button>})}
        </DayCell>}
    }).collect_view()}</div></div>}
}

#[component]
pub fn TimeGrid(
    days: Vec<NaiveDate>,
    today: NaiveDate,
    now_min: Signal<u32>,
    events: BTreeMap<NaiveDate, Vec<Segment>>,
    twelve: bool,
    on_event: Callback<Event>,
    scroll_position: RwSignal<Option<i32>>,
) -> impl IntoView {
    let template = format!(
        "grid-template-columns:60px repeat({},minmax(144px,1fr));min-width:{}px",
        days.len(),
        if days.len() > 1 {
            60 + days.len() * 144
        } else {
            0
        }
    );
    let any_all = days.iter().any(|day| {
        events
            .get(day)
            .is_some_and(|e| e.iter().any(|e| e.event.all_day))
    });
    let all = events.clone();
    let headings = days.clone();
    let scroll = NodeRef::<leptos::html::Div>::new();
    #[cfg(target_arch = "wasm32")]
    Effect::new(move |_| {
        if let Some(el) = scroll.get() {
            el.set_scroll_top(scroll_position.get_untracked().unwrap_or_else(|| {
                (now_min.get_untracked() as f64 * 58.0 / 60.0 - 180.0).max(0.0) as i32
            }));
        }
    });
    view! {<div class="cal-tg">
        <div class="cal-tg__head" style=template.clone()><div class="cal-tg__corner"></div>{headings.into_iter().map(|day|view!{
            <div class=if day==today {"cal-tg__dayhd is-today"} else {"cal-tg__dayhd"}><span class="cal-tg__dow">{day.format("%a").to_string()}</span><span class="cal-tg__dnum">{day.day()}</span></div>
        }).collect_view()}</div>
        {any_all.then(||view!{<div class="cal-tg__allday" style=template.clone()><div class="cal-tg__allday-lbl">"all-day"</div>{days.iter().map(|day|view!{<div class="cal-tg__allday-cell">{all.get(day).cloned().unwrap_or_default().into_iter().filter(|s|s.event.all_day).map(|s|{let e=s.event;let pick=e.clone();view!{<AllDayChip focus_key=format!("{}:{}",day,e.id) title=e.title on_pick=Callback::new(move |_|on_event.run(pick.clone()))/>}}).collect_view()}</div>}).collect_view()}</div>})}
        <div class="cal-tg__scroll" node_ref=scroll on:scroll=move |_|{if let Some(el)=scroll.get(){scroll_position.set(Some(el.scroll_top()));}}><div class="cal-tg__body" style=format!("{template};height:1392px")>
            <div class="cal-tg__gutter">{(1..24).map(|h|view!{<span class="cal-tg__hr" style=format!("top:{}px",h*58)>{model::time(h*60,twelve)}</span>}).collect_view()}</div>
            {days.into_iter().map(|day|{
                let packed=model::pack(events.get(&day).map(Vec::as_slice).unwrap_or(&[]));
                view!{<div class=if day==today {"cal-tg__col is-today"} else {"cal-tg__col"}>
                    {packed.into_iter().map(|s|{
                        let width=100.0/s.columns as f64;
                        let geometry=format!("top:{}px;height:{}px;left:calc({}% + 2px);width:calc({width}% - 4px)",s.start_min as f64*58.0/60.0,((s.end_min as f64-s.start_min as f64)*58.0/60.0).max(28.0),s.column as f64*width);
                        let e=s.event;let pick=e.clone();
                        let tentative=matches!(e.status.as_deref(),Some("tentative"|"needsAction"));
                        view!{<EventChip focus_key=format!("{}:{}",day,e.id) title=e.title time=model::time(s.start_min,twelve) geometry=geometry block=e.is_moss_block tentative=tentative on_pick=Callback::new(move |_|on_event.run(pick.clone()))/>}
                    }).collect_view()}
                    {(day==today).then(||view!{<div class="cal-now" style=move||format!("top:{}px",now_min.get() as f64*58.0/60.0) aria-hidden="true"><span class="cal-now__line"></span><span class="cal-now__dot"></span></div>})}
                </div>}
            }).collect_view()}
        </div></div>
    </div>}
}

#[component]
pub fn EventDetails(
    event: Event,
    timezone: String,
    twelve: bool,
    on_close: Callback<()>,
) -> impl IntoView {
    let zone = model::zone(&timezone).unwrap_or(chrono_tz::UTC);
    let starts = chrono::DateTime::parse_from_rfc3339(&event.starts_at)
        .ok()
        .map(|d| d.with_timezone(&zone));
    let ends = chrono::DateTime::parse_from_rfc3339(&event.ends_at)
        .ok()
        .map(|d| d.with_timezone(&zone));
    use chrono::Timelike;
    let time = if event.all_day {
        "All day".into()
    } else {
        match (starts, ends) {
            (Some(a), Some(b)) => format!(
                "{} – {} · {}",
                model::time(a.hour() * 60 + a.minute(), twelve),
                model::time(b.hour() * 60 + b.minute(), twelve),
                model::duration(((b - a).num_milliseconds() as f64 / 60000.0 + 0.5).floor() as i64)
            ),
            _ => "Time unavailable".into(),
        }
    };
    let dates = model::date_range(&event, zone);
    let state = if event.is_moss_block {
        "Moss is holding this"
    } else if event.unconfirmed {
        "Needs verification in Outlook"
    } else if matches!(event.status.as_deref(), Some("tentative" | "needsAction")) {
        "Awaiting RSVP"
    } else {
        "On your calendar"
    };
    let detail_status = if event.is_moss_block {
        "Moss focus block"
    } else if event.read_only {
        if event.unconfirmed {
            "Needs verification"
        } else {
            "Observed in Outlook"
        }
    } else if matches!(event.status.as_deref(), Some("tentative" | "needsAction")) {
        "Pending RSVP"
    } else {
        "Accepted"
    };
    view! {<PeekPanel on_close=on_close>
        <div class="cal-peek__head"><span class="cal-peek__kind">{state}</span></div>
        <h2 class="cal-peek__title">{event.title}</h2>
        {event.read_only.then(||view!{<p>"Outlook · Read only. Check or change this event in Outlook."</p>})}
        <div class="cal-peek__rows"><p>{time}</p><p>{dates}</p><p>{timezone}</p>
            {event.location.map(|where_|view!{<p>{where_}</p>})}
            {(event.attendee_count>0.0).then(||view!{<p>{format!("{} {}",event.attendee_count,if event.attendee_count==1.0 {"person"}else{"people"})}</p>})}
            <p>{detail_status}</p>
        </div>
        {event.is_moss_block.then(||view!{<p class="cal-held-banner">"Moss can move or shorten this block when your day changes. Hard events always come first."</p>})}
    </PeekPanel>}
}

#[component]
pub fn ReadFailure(
    retained: bool,
    on_retry: Callback<()>,
    #[prop(optional)] settings_page: bool,
) -> impl IntoView {
    let name = if settings_page {
        "settings"
    } else {
        "calendar"
    };
    view! {<div role="alert">
        {if retained {view!{<p class="jds-hint jds-hint--error">{if settings_page {"Could not refresh your settings. Previously loaded settings are still shown."} else {"Could not refresh your calendar. Previously loaded events are still shown."}}</p>}.into_any()} else {view!{<EmptyState title=format!("Could not load your {name}") description=format!("Try again to load your {name}.")/>}.into_any()}}
        <Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|on_retry.run(()))>"Try again"</Button>
    </div>}
}
