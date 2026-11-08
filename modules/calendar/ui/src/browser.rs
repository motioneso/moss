use crate::{
    model::{self, Event},
    views::*,
};
use chrono::{NaiveDate, Timelike};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, EmptyState, Masthead};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=calendarBridge, js_name=request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn settings() -> bool;
    #[wasm_bindgen(js_namespace=calendarBridge, js_name=requestedEvent)]
    fn requested_event() -> js_sys::Promise;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn preserve() -> JsValue;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn restore(saved: &JsValue);
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn navigate(path: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn watch(callback: &js_sys::Function);
}
async fn request(method: &str, path: &str, body: Value) -> Result<Value, ()> {
    let result = JsFuture::from(bridge_request(method, path, &body.to_string()))
        .await
        .map_err(|_| ())?;
    serde_json::from_str(&result.as_string().ok_or(())?).map_err(|_| ())
}

#[derive(Clone, Copy, PartialEq)]
enum Refresh {
    Idle,
    Background,
    Explicit,
}
#[derive(Clone, Copy)]
struct State {
    events: RwSignal<Option<Vec<Event>>>,
    display: RwSignal<Value>,
    briefing: RwSignal<Value>,
    loading: RwSignal<Refresh>,
    failed: RwSignal<bool>,
    view: RwSignal<String>,
    cursor: RwSignal<Option<NaiveDate>>,
    work: RwSignal<bool>,
    saving: RwSignal<bool>,
    unsaved: RwSignal<bool>,
    initialized: RwSignal<bool>,
}
impl State {
    fn zone(self) -> chrono_tz::Tz {
        self.display.get()["timezone"]
            .as_str()
            .and_then(model::zone)
            .unwrap_or(chrono_tz::America::Los_Angeles)
    }
    fn today(self) -> NaiveDate {
        model::today(
            self.display.get()["now"].as_str().unwrap_or(""),
            self.zone(),
        )
        .unwrap_or_else(|| {
            chrono::DateTime::from_timestamp_millis(js_sys::Date::now() as i64)
                .unwrap()
                .with_timezone(&self.zone())
                .date_naive()
        })
    }
    fn day(self) -> NaiveDate {
        self.cursor.get().unwrap_or_else(|| self.today())
    }
    fn twelve(self) -> bool {
        model::twelve(self.display.get()["dateFormat"].as_str())
    }
    fn refresh(self, explicit: bool) {
        if self.loading.get_untracked() != Refresh::Idle {
            return;
        }
        self.loading.set(if explicit {
            Refresh::Explicit
        } else {
            Refresh::Background
        });
        spawn_local(async move {
            let result = async {
                let display = request("GET", "/display-settings", Value::Null).await?;
                let events: Option<Vec<Event>> = if settings() {
                    None
                } else {
                    let result = request("GET", "/events", Value::Null).await?;
                    Some(serde_json::from_value(result["events"].clone()).map_err(|_| ())?)
                };
                let briefing = if settings() {
                    Some(request("GET", "/briefing-settings", Value::Null).await?)
                } else {
                    None
                };
                Ok::<_, ()>((display, events, briefing))
            }
            .await;
            match result {
                Ok((display, events, briefing)) => {
                    if !self.initialized.get_untracked() {
                        self.initialized.set(true);
                        if let Some(view @ ("day" | "week" | "month")) =
                            display["view"]["view"].as_str()
                        {
                            self.view.set(view.into());
                        }
                        self.work.set(display["view"]["workWeek"] == true);
                        if self.view.get_untracked() == "day" {
                            self.cursor.set(
                                display["view"]["cursor"]
                                    .as_str()
                                    .and_then(|d| d.parse().ok()),
                            );
                        }
                    }
                    self.display.set(display);
                    if let Some(events) = events {
                        if self.events.get_untracked().as_ref() != Some(&events) {
                            let saved = preserve();
                            self.events.set(Some(events));
                            restore(&saved);
                        }
                    }
                    if let Some(briefing) = briefing {
                        self.briefing.set(briefing);
                    }
                    self.failed.set(false);
                }
                Err(()) => self.failed.set(true),
            }
            self.loading.set(Refresh::Idle);
        });
    }
    fn persist(self) {
        if self.saving.get_untracked() {
            return;
        }
        self.saving.set(true);
        let body = json!({"view":self.view.get_untracked(),"cursor":self.day().to_string(),"workWeek":self.work.get_untracked()});
        spawn_local(async move {
            self.unsaved
                .set(request("PATCH", "/display-settings", body).await.is_err());
            self.saving.set(false);
        });
    }
}

#[component]
pub fn Calendar() -> impl IntoView {
    let state = State {
        events: RwSignal::new(None),
        display: RwSignal::new(Value::Null),
        briefing: RwSignal::new(Value::Null),
        loading: RwSignal::new(Refresh::Idle),
        failed: RwSignal::new(false),
        view: RwSignal::new("day".into()),
        cursor: RwSignal::new(None),
        work: RwSignal::new(false),
        saving: RwSignal::new(false),
        unsaved: RwSignal::new(false),
        initialized: RwSignal::new(false),
    };
    let scroll_position = RwSignal::new(None::<i32>);
    let zone = Memo::new(move |_| state.zone());
    let twelve = Memo::new(move |_| state.twelve());
    let today = Memo::new(move |_| state.today());
    let cursor = Memo::new(move |_| state.cursor.get().unwrap_or_else(|| today.get()));
    let now = Signal::derive(move || {
        chrono::DateTime::parse_from_rfc3339(state.display.get()["now"].as_str().unwrap_or(""))
            .ok()
            .map(|d| d.with_timezone(&zone.get()))
            .map(|d| d.hour() * 60 + d.minute())
            .unwrap_or(0)
    });
    let peek = RwSignal::new(None::<Event>);
    let opening = StoredValue::new_local(JsValue::NULL);
    let pick = Callback::new(move |event| {
        opening.set_value(preserve());
        peek.set(Some(event));
    });
    let day_pick = Callback::new(move |day| {
        if !state.saving.get_untracked() {
            state.cursor.set(Some(day));
            state.view.set("day".into());
            state.persist();
        }
    });
    let requested = RwSignal::new(None::<String>);
    if !settings() {
        spawn_local(async move {
            if let Ok(id) = JsFuture::from(requested_event()).await {
                requested.set(id.as_string());
            }
        });
        Effect::new(move |_| {
            let Some(events) = state.events.get() else {
                return;
            };
            if let Some(old) = peek.get_untracked() {
                let current = events.iter().find(|e| e.id == old.id).cloned();
                if current.as_ref() != Some(&old) {
                    peek.set(current);
                }
            }
            if let Some(id) = requested.get() {
                if let Some(event) = events.iter().find(|e| e.id == id) {
                    opening.set_value(preserve());
                    peek.set(Some(event.clone()));
                    requested.set(None);
                }
            }
        });
    }
    state.refresh(false);
    let tick = Closure::<dyn Fn()>::new(move || state.refresh(false));
    watch(tick.as_ref().unchecked_ref());
    tick.forget();
    if settings() {
        return view! {<Settings state=state/>}.into_any();
    }
    view! {<main class="cal-wrap" aria-label="Calendar">
        <div class="cal-toolbar"><div class="cal-toolbar__left">
            <Button variant=ButtonVariant::Secondary disabled=Signal::derive(move||state.saving.get() || !state.initialized.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(state.today()));state.persist();})>"Today"</Button>
            <div class="cal-nav"><Button variant=ButtonVariant::Quiet disabled=Signal::derive(move||state.saving.get() || !state.initialized.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(model::navigate(state.day(),&state.view.get(),-1)));state.persist();})>"Previous"</Button>
            <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move||state.saving.get() || !state.initialized.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(model::navigate(state.day(),&state.view.get(),1)));state.persist();})>"Next"</Button></div>
            <h1 class="cal-range">{move||{
                let day=cursor.get();
                match state.view.get().as_str(){"month"=>day.format("%B %Y").to_string(),"week"=>{let days=model::week(day,state.work.get());format!("{} – {}",days[0].format("%b %-d"),days.last().unwrap().format("%b %-d, %Y"))},_=>day.format("%a, %B %-d, %Y").to_string()}
            }}</h1>
        </div><div class="cal-toolbar__right">
            {move||(state.view.get()=="week").then(||view!{<Button variant=ButtonVariant::Secondary disabled=Signal::derive(move||state.saving.get() || !state.initialized.get()) on_click=Callback::new(move |_|{state.work.update(|v|*v=!*v);state.persist();})>{move||if state.work.get(){"Show full week"}else{"Show work week"}}</Button>})}
            <div class="calendar-toolbar-actions" role="group" aria-label="Calendar view">
                {[ ("day","Day"),("week","Week"),("month","Month") ].into_iter().map(|(key,label)|view!{
                    <button type="button" class=move||format!("jds-btn jds-btn--secondary{}",if state.view.get()==key{" jds-btn--active"}else{""}) aria-pressed=move||(state.view.get()==key).to_string() disabled=move||state.saving.get() || !state.initialized.get() on:click=move |_|{if key!="day"{state.cursor.set(Some(state.today()));}state.view.set(key.into());state.persist();}>{label}</button>
                }).collect_view()}
            </div>
        </div></div>
        <div class="cal-legend"><span>"Accepted · Moss holding"</span><span>{move||state.zone().name()}</span></div>
        <div class="cal-notice" aria-live="polite">
            {move||(state.loading.get()!=Refresh::Idle && (state.events.get().is_none() || state.loading.get()==Refresh::Explicit)).then(||view!{<p role="status">{if state.events.get().is_some(){"Refreshing calendar…"}else{"Loading calendar…"}}</p>})}
            {move||state.failed.get().then(||view!{<ReadFailure retained=state.events.get().is_some() on_retry=Callback::new(move |_|state.refresh(true))/>})}
            {move||state.unsaved.get().then(||view!{<p role="status">"Your view choice could not be saved. It will last for this visit."</p>})}
        </div>
        <div class="cal-body" tabindex="0" aria-label="Calendar days">{move||state.events.get().map(|events|{
            let empty=events.is_empty();
            let groups=model::group(&events,zone.get());
            view!{
                {empty.then(||view!{<EmptyState title="No events yet" description="Events from your connected calendars will appear here."/>})}
                {if state.view.get()=="month" {
                    view!{<Month cursor=cursor.get() today=today.get() events=groups twelve=twelve.get() on_day=day_pick on_event=pick/>}.into_any()
                }else{
                    let days=if state.view.get()=="week" {model::week(cursor.get(),state.work.get())}else{vec![cursor.get()]};
                    view!{<TimeGrid days=days today=today.get() now_min=now events=groups twelve=twelve.get() on_event=pick scroll_position=scroll_position/>}.into_any()
                }}
            }
        })}</div>
        {move||peek.get().map(|event|view!{<EventDetails event=event timezone=zone.get().name().into() twelve=twelve.get() on_close=Callback::new(move |_|{peek.set(None);restore(&opening.get_value());})/>})}
    </main>}.into_any()
}

#[component]
fn Settings(state: State) -> impl IntoView {
    view! {<main class="calendar-settings"><Masthead title="Calendar" eyebrow="Settings" lede="How Moss helps you plan your days"/>
        {move||(state.loading.get()!=Refresh::Idle && (state.briefing.get()==Value::Null || state.loading.get()==Refresh::Explicit)).then(||view!{<p role="status">{if state.briefing.get()==Value::Null {"Loading settings…"}else{"Refreshing settings…"}}</p>})}
        {move||state.failed.get().then(||view!{<ReadFailure settings_page=true retained=state.briefing.get()!=Value::Null on_retry=Callback::new(move |_|state.refresh(true))/>})}
        {move||(state.briefing.get()!=Value::Null).then(||{
            let s=state.briefing.get()["settings"].clone();
            view!{<dl><dt>"Look ahead"</dt><dd>{format!("{} days",s["lookaheadDays"])}</dd><dt>"Prep tasks"</dt><dd>{s["prepTaskMode"].as_str().unwrap_or("suggest").to_string()}</dd><dt>"Time blocks"</dt><dd>{s["timeBlockMode"].as_str().unwrap_or("suggest").to_string()}</dd><dt>"Timezone"</dt><dd>{state.zone().name()}</dd></dl>}
        })}
        <p>"These settings are read only."</p>
        <Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|{let _=navigate("/calendar");})>"Open Calendar"</Button>
    </main>}
}
