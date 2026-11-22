//! Calendar owns Today’s saved plan and review actions.
use crate::{
    model,
    today_model::{self as plan, Item},
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, DisclosureToggle, PlanNote, SectionHead};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=calendarBridge,js_name=today)]
    pub fn is_today() -> bool;
    #[wasm_bindgen(js_namespace=calendarBridge,js_name=request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn present(modal: bool) -> js_sys::Promise;
}
pub(crate) async fn get(path: &str) -> Result<Value, ()> {
    let out = JsFuture::from(bridge_request("GET", path, "null"))
        .await
        .map_err(|_| ())?;
    serde_json::from_str(&out.as_string().ok_or(())?).map_err(|_| ())
}
pub(crate) async fn request(method: &str, path: &str, body: Value) -> Result<Value, u16> {
    let out = JsFuture::from(bridge_request(method, path, &body.to_string()))
        .await
        .map_err(|e| {
            js_sys::Reflect::get(&e, &JsValue::from_str("status"))
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as u16
        })?;
    serde_json::from_str(&out.as_string().ok_or(0u16)?).map_err(|_| 0)
}
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub(crate) display: Value,
    pub(crate) saved: Option<Value>,
    pub(crate) events: Option<Value>,
    automatic: bool,
}
impl Snapshot {
    pub(crate) fn zone(&self) -> chrono_tz::Tz {
        plan::display_zone(&self.display)
    }
    pub(crate) fn twelve(&self) -> bool {
        model::twelve(self.display["dateFormat"].as_str())
    }
    pub(crate) fn day(&self) -> chrono::NaiveDate {
        model::today(
            self.display["now"].as_str().unwrap_or_default(),
            self.zone(),
        )
        .unwrap()
    }
    pub(crate) fn items(&self) -> Vec<Item> {
        plan::items(
            self.saved.as_ref().unwrap_or(&Value::Null),
            self.events.as_ref().unwrap_or(&Value::Null),
            self.day(),
            self.zone(),
            self.twelve(),
        )
    }
    pub(crate) fn name(&self) -> String {
        self.display["assistantName"]
            .as_str()
            .unwrap_or("Moss")
            .to_owned()
    }
    fn count(&self) -> usize {
        self.saved
            .as_ref()
            .and_then(|s| s["plan"]["blocks"].as_array())
            .map(|b| b.iter().filter(|b| !b["taskId"].is_null()).count())
            .unwrap_or_default()
    }
}
#[component]
pub fn Today() -> impl IntoView {
    let state = RwSignal::new(None::<Snapshot>);
    let busy = RwSignal::new(false);
    let failed = RwSignal::new(false);
    let review = RwSignal::new(false);
    let open_failed = RwSignal::new(false);
    let refresh = Callback::new(move |()| {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        spawn_local(async move {
            let result = async {
                let mut display = get("/display-settings").await?;
                if display["now"]
                    .as_str()
                    .and_then(|s| model::today(s, chrono_tz::UTC))
                    .is_none()
                {
                    display["now"] = Value::String(
                        js_sys::Date::new_0()
                            .to_iso_string()
                            .as_string()
                            .ok_or(())?,
                    );
                }
                let zone = plan::display_zone(&display);
                let day = model::today(display["now"].as_str().ok_or(())?, zone).ok_or(())?;
                let saved = get(&format!("/day-plan?date={day}&timeZone={zone}"))
                    .await
                    .ok();
                let events = get("/events").await.ok();
                let automatic = get("/briefing-settings")
                    .await
                    .ok()
                    .is_some_and(|v| v["settings"]["timeBlockMode"] == "auto");
                Ok::<_, ()>(Snapshot {
                    display,
                    saved,
                    events,
                    automatic,
                })
            }
            .await;
            match result {
                Ok(snapshot) => {
                    state.set(Some(snapshot));
                    failed.set(false)
                }
                Err(_) => failed.set(true),
            }
            busy.set(false);
        });
    });
    refresh.run(());
    let close = Callback::new(move |()| {
        review.set(false);
        spawn_local(async move {
            let _ = JsFuture::from(present(false)).await;
        });
    });
    let open = Callback::new(move |_| {
        open_failed.set(false);
        spawn_local(async move {
            match JsFuture::from(present(true)).await {
                Ok(_) => review.set(true),
                Err(_) => open_failed.set(true),
            }
        });
    });
    view! {
        <section class="jds-brief jds-brief--timeline" id="schedule" aria-busy=move||busy.get()>
            <SectionHead title="Your day, laid out" />
            {move|| {
                if let Some(snapshot)=state.get() {
                    let rows=snapshot.items();
                    let proposed=rows.iter().any(|i|matches!(i.state,"proposed"|"pending"));
                    let count=snapshot.count();
                    let name=snapshot.name();
                    let automatic=snapshot.automatic;
                    let notice=match (snapshot.saved.is_none(),snapshot.events.is_none()) {
                        (true,true)=>Some("Calendar and saved plan aren't available right now."),
                        (true,false)=>Some("Saved plan unavailable; showing calendar events only"),
                        (false,true)=>Some("Calendar isn't available right now; showing your saved plan."),
                        _=>None,
                    };
                    view! {
                        {(count>0 || notice.is_some()).then(||view! {<PlanNote>
                            {(count>0).then(||view! {<p class="tl-note__text">
                                <strong>{if proposed {"Your proposed plan."} else {"Your task blocks are on the calendar."}}</strong>" "
                                {if proposed {format!("{count} task {} around your commitments.",if count==1 {"block fits"} else {"blocks fit"})} else {format!("{name} can adjust its blocks when the day changes.")}}
                            </p>})}
                            {notice.map(|text|view! {<p class="cmd-empty" role="status" data-error-code="calendar_today_unavailable">{text}</p>})}
                            {(count>0).then(||view! {<Button on_click=open>{if automatic {"Adjust task blocks"} else {"Review task blocks"}}</Button>})}
                        </PlanNote>})}
                        {notice.map(|_|view! {<Button variant=ButtonVariant::Quiet disabled=busy on_click=Callback::new(move |_|refresh.run(()))>"Try again"</Button>})}
                        {if rows.is_empty() {view! {<p class="cmd-empty">"Nothing on the schedule yet."</p>}.into_any()} else {view! {<Schedule snapshot=snapshot />}.into_any()}}
                    }.into_any()
                } else if failed.get() {view! {<p class="cmd-empty" role="status" data-error-code="calendar_today_unavailable">"Your day plan couldn't load."</p><Button variant=ButtonVariant::Quiet disabled=busy on_click=Callback::new(move |_|refresh.run(()))>"Try again"</Button>}.into_any()}
                else {view! {<p class="agenda-clear" role="status">"Gathering your day plan…"</p>}.into_any()}
            }}
            {move||open_failed.get().then(||view! {<p class="cmd-empty" role="status">"Review couldn't open. Try again."</p>})}
        </section>
        {move||review.get().then(||state.get_untracked().map(|snapshot|view! {<crate::today_review::Review snapshot=snapshot parent=state on_close=close />}))}
    }
}
#[component]
fn Schedule(snapshot: Snapshot) -> impl IntoView {
    let rows = snapshot.items();
    let (gaps, closing) = plan::gaps(&rows);
    let proposed = rows
        .iter()
        .any(|i| matches!(i.state, "proposed" | "pending"));
    let name = snapshot.name();
    let zone = snapshot.zone();
    let twelve = snapshot.twelve();
    view! {
        <div class="tl-legend">
            <span><i class="tl-legend__filled" aria-hidden="true"></i>{if proposed {"Proposed task".into()} else {format!("{name}-planned task")}}</span>
            <span><i class="tl-legend__open" aria-hidden="true"></i>"Calendar commitment"</span>
            {(!gaps.is_empty()).then(||view! {<span><i class="tl-legend__gap" aria-hidden="true"></i>"Open time"</span>})}
        </div>
        <div class="day-list">{rows.into_iter().map(|item| {
            let gap=gaps.iter().find(|g|g.after==item.id);
            view! {<TimelineRow item=item zone=zone twelve=twelve />
                {gap.map(|gap|view! {<div class="tl-slot tl-slot--gap"><div class="day-ev__t tl-time">{plan::clock(gap.start,zone,twelve)}<small>{plan::clock(gap.end,zone,twelve)}</small></div><div class="tl-body">{gap.label}</div></div>})}
            }
        }).collect_view()}</div>
        {closing.map(|end|view! {<p class="tl-closing">{format!("The evening is open. No more commitments after {}.",plan::clock(end,zone,twelve))}</p>})}
    }
}
#[component]
fn TimelineRow(item: Item, zone: chrono_tz::Tz, twelve: bool) -> impl IntoView {
    let event = item.state == "event";
    view! {<div class=format!("{} tl-slot tl-slot--{}",if event {"day-ev"} else {"jds-task"},item.state) data-state=item.state>
        <div class="day-ev__t tl-time">{item.start.map(|at|plan::clock(at,zone,twelve)).unwrap_or_else(||"No time yet".into())}<small>{item.end.map(|at|plan::clock(at,zone,twelve)).unwrap_or_default()}</small></div>
        <div class="tl-body"><div class=if event {"tl-block"} else {"jds-task__main"}>
            <div class=if event {"day-ev__title"} else if item.state=="completed" {"jds-task__title tl-done"} else {"jds-task__title"}>{item.title}</div>
            <div class=if event {"day-ev__where"} else {"jds-task__meta"}>
                <span class="tl-meta-len">{plan::length(item.minutes)}</span>
                {(item.minutes.is_some_and(|m|m>0) && !event).then(||view! {<span class="tl-meta-divider" aria-hidden="true">"·"</span>})}
                <span class="jds-task__source">{item.kind_label}</span>
                {item.reason.map(|reason|view! {<span class="jds-task__source">{reason}</span>})}
                <span class="jds-task__state">{if item.first_proposal {"Proposed"} else {item.label}}</span>
                {item.flexible.then(||view! {<span class="jds-task__source">"Flexible"</span>})}
                {item.unavailable.then(||view! {<span class="jds-task__source">"Task no longer visible"</span>})}
                {item.location.map(|location|view! {<span>{format!(" · {location}")}</span>})}
            </div>
        </div></div>
    </div>}
}
#[component]
pub(crate) fn ReviewSchedule(snapshot: Signal<Snapshot>) -> impl IntoView {
    let zone = snapshot.get_untracked().zone();
    let twelve = snapshot.get_untracked().twelve();
    let schedule_open = RwSignal::new(
        web_sys::window()
            .unwrap()
            .inner_width()
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            > 1080.0,
    );
    view! {                <div class="brief-reader__railwrap">
                    <DisclosureToggle class="brief-reader__schedule-toggle" expanded=schedule_open.into() controls="today-review-schedule" on_click=Callback::new(move |_|schedule_open.update(|v|*v=!*v))>"Today's schedule"</DisclosureToggle>
                    <div class="brief-reader__rail" id="today-review-schedule" hidden=move||!schedule_open.get()>
                        <p class="brief-reader__rail-date">{snapshot.get_untracked().day().format("%A, %B %-d").to_string()}</p><h3 class="brief-reader__rail-heading">"Your day, in order."</h3>
                        <section class="jds-brief brief-snapshot"><div class="day-list">{move||snapshot.get().items().into_iter().map(|item| {
                            let caption=if item.first_proposal {"Proposed"} else if item.state=="committed" {"On calendar"} else if item.state=="event" {"Calendar"} else {item.label};
                            view! {<div class=if item.state=="event" {"day-ev brief-snapshot__row"} else {"jds-task brief-snapshot__row brief-snapshot__row--task"} data-state=item.state>
                                <span class="brief-snapshot__time">{item.start.map(|s|plan::clock(s,zone,twelve)).unwrap_or_else(||"No time yet".into())}</span>
                                <div class="brief-snapshot__main"><span class="jds-task__title">{item.title}</span><small class="jds-task__state">{format!("{}{caption}{}",item.end.map(|e|format!("{} · ",plan::clock(e,zone,twelve))).unwrap_or_default(),if item.unavailable {" · Task no longer visible"} else {""})}</small></div>
                            </div>}
                        }).collect_view()}</div></section>
                    </div>
                </div>
    }
}
