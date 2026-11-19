//! Calendar owns Today’s saved plan. This screen only issues reads.
use crate::{
    model,
    today_model::{self as plan, Item},
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{
    Button, ButtonSize, ButtonVariant, DisclosureToggle, PlanNote, ReportDialog, SectionHead,
};
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
async fn get(path: &str) -> Result<Value, ()> {
    let out = JsFuture::from(bridge_request("GET", path, "null"))
        .await
        .map_err(|_| ())?;
    serde_json::from_str(&out.as_string().ok_or(())?).map_err(|_| ())
}
#[derive(Clone)]
struct Snapshot {
    display: Value,
    saved: Option<Value>,
    events: Option<Value>,
    automatic: bool,
}
impl Snapshot {
    fn zone(&self) -> chrono_tz::Tz {
        self.display["timezone"]
            .as_str()
            .and_then(model::zone)
            .unwrap_or(chrono_tz::America::Los_Angeles)
    }
    fn twelve(&self) -> bool {
        model::twelve(self.display["dateFormat"].as_str())
    }
    fn day(&self) -> chrono::NaiveDate {
        model::today(
            self.display["now"].as_str().unwrap_or_default(),
            self.zone(),
        )
        .unwrap()
    }
    fn items(&self) -> Vec<Item> {
        plan::items(
            self.saved.as_ref().unwrap_or(&Value::Null),
            self.events.as_ref().unwrap_or(&Value::Null),
            self.day(),
            self.zone(),
            self.twelve(),
        )
    }
    fn name(&self) -> String {
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
                let zone = display["timezone"]
                    .as_str()
                    .and_then(model::zone)
                    .ok_or(())?;
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
                            {(count>0 && proposed).then(||view! {<Button on_click=open>{if automatic {"Adjust task blocks"} else {"Review task blocks"}}</Button>})}
                        </PlanNote>})}
                        {notice.map(|_|view! {<Button variant=ButtonVariant::Quiet disabled=busy on_click=Callback::new(move |_|refresh.run(()))>"Try again"</Button>})}
                        {if rows.is_empty() {view! {<p class="cmd-empty">"Nothing on the schedule yet."</p>}.into_any()} else {view! {<Schedule snapshot=snapshot />}.into_any()}}
                    }.into_any()
                } else if failed.get() {view! {<p class="cmd-empty" role="status" data-error-code="calendar_today_unavailable">"Your day plan couldn't load."</p><Button variant=ButtonVariant::Quiet disabled=busy on_click=Callback::new(move |_|refresh.run(()))>"Try again"</Button>}.into_any()}
                else {view! {<p class="agenda-clear" role="status">"Gathering your day plan…"</p>}.into_any()}
            }}
            {move||open_failed.get().then(||view! {<p class="cmd-empty" role="status">"Review couldn't open. Try again."</p>})}
        </section>
        {move||review.get().then(||state.get().map(|snapshot|view! {<Review snapshot=snapshot on_close=close />}))}
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
fn Review(snapshot: Snapshot, on_close: Callback<()>) -> impl IntoView {
    let rows = snapshot.items();
    let zone = snapshot.zone();
    let twelve = snapshot.twelve();
    let wide = web_sys::window()
        .unwrap()
        .inner_width()
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        > 1080.0;
    let ordered = snapshot
        .saved
        .as_ref()
        .and_then(|s| s["plan"]["blocks"].as_array())
        .cloned()
        .unwrap_or_default();
    let pending = rows.iter().any(|i| i.first_proposal);
    view! {<ReportDialog title="Your day, prepared." on_close=on_close>
        <div class="brief-reader brief-reader--report" role="document">
            <div class="brief-reader__head">
                <p class="brief-reader__eyebrow">{format!("{} / Morning briefing",snapshot.name())}</p>
                <h2 id="today-review-title" class="brief-reader__title" data-briefing-title tabindex="-1" autofocus>"Your day, prepared."</h2>
                <Button variant=ButtonVariant::Quiet size=ButtonSize::Small aria_label="Close briefing reader" on_click=Callback::new(move |_|on_close.run(()))>"Close"</Button>
            </div>
            <div class="brief-reader__tabs"><div class="brief-reader__tablist" role="tablist" aria-label="Morning briefing views">
                <button class="brief-reader__tab" type="button" role="tab" aria-selected="false" disabled>"The briefing"</button>
                <button class="brief-reader__tab brief-reader__tab--selected" type="button" role="tab" aria-selected="true" aria-controls="today-review-panel" id="today-review-tab">"Review task blocks"</button>
            </div></div>
            <div class="brief-reader__body"><div class="brief-reader__grid">
                {(!wide).then(||view! {<ReviewSchedule snapshot=snapshot.clone() />})}
                <div class="brief-reader__report" role="tabpanel" id="today-review-panel" aria-labelledby="today-review-tab" data-briefing-surface="review">
                    <h3 class="brief-reader__headline">"Make the plan fit."</h3>
                    <p class="plan-review__lede">"Meetings, lunch, and travel stay in place. Adjust the task blocks around them."</p>
                    {pending.then(||view! {<div class="plan-review__accept"><Button disabled=true>"Accept all time blocks"</Button></div>})}
                    <ul class="plan-review__rows">{ordered.into_iter().filter_map(|b|rows.iter().find(|i|i.id==format!("block:{}",b["id"].as_str().unwrap_or_default())).cloned()).map(|item|view! {<ReviewRow item=item zone=zone twelve=twelve />}).collect_view()}</ul>
                    <div class="plan-review__changes"><h3 class="plan-review__changes-title">"What will change"</h3><p class="plan-review__empty">"No changes selected."</p></div>
                </div>
                {wide.then(||view! {<ReviewSchedule snapshot=snapshot.clone() />})}
            </div></div>
            <div class="brief-reader__footer"><div class="brief-reader__footer-actions"><Button disabled=true>"Save changes"</Button></div><div class="brief-reader__footer-back"><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_|on_close.run(()))>"Back to Today"</Button></div></div>
        </div>
    </ReportDialog>}
}
#[component]
fn ReviewSchedule(snapshot: Snapshot) -> impl IntoView {
    let rows = snapshot.items();
    let zone = snapshot.zone();
    let twelve = snapshot.twelve();
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
                        <p class="brief-reader__rail-date">{snapshot.day().format("%A, %B %-d").to_string()}</p><h3 class="brief-reader__rail-heading">"Your day, in order."</h3>
                        <section class="jds-brief brief-snapshot"><div class="day-list">{rows.into_iter().map(|item| {
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
#[component]
fn ReviewRow(item: Item, zone: chrono_tz::Tz, twelve: bool) -> impl IntoView {
    let time = item
        .start
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|t| t.with_timezone(&zone).format("%H:%M").to_string())
        .unwrap_or_default();
    let id = item.id.replace(':', "-");
    let label = if item.unavailable {
        "No longer available"
    } else {
        item.label
    };
    let meta = if item.minutes.is_some() && !item.unavailable {
        format!("{} minutes · {label}", item.minutes.unwrap())
    } else {
        label.to_owned()
    };
    let _ = twelve;
    view! {<li class="plan-review__row"><div><div class="plan-review__title">{item.title.clone()}</div><div class="plan-review__meta">{meta}</div></div>
        {(!item.unavailable).then(||view! {<div class="plan-review__fields">
            {item.minutes.is_some().then(||view! {<div class="plan-review__field"><label class="plan-review__label plan-review__label--time" for=format!("{id}-time")>"Time"</label><input class="plan-review__time plan-review__field--time" type="time" id=format!("{id}-time") aria-label=format!("{}: start time",item.title) value=time disabled /></div>})}
            <div class="plan-review__field"><label class="plan-review__label" for=format!("{id}-placement")>"Placement"</label><select class="jds-select" id=format!("{id}-placement") aria-label=format!("{}: placement",item.title) disabled><option>{if item.flexible {"Keep as is"} else if item.first_proposal {"Keep proposed"} else {"Leave unscheduled"}}</option></select></div>
        </div>})}
    </li>}
}
