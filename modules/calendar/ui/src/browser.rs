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

#[derive(Clone, Copy)]
struct State {
    events: RwSignal<Option<Vec<Event>>>,
    display: RwSignal<Value>,
    briefing: RwSignal<Value>,
    loading: RwSignal<bool>,
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
        self.display.get()["dateFormat"] != "24"
    }
    fn refresh(self) {
        if self.loading.get_untracked() {
            return;
        }
        self.loading.set(true);
        spawn_local(async move {
            let result = async {
                let display = request("GET", "/display-settings", Value::Null).await?;
                let result = request("GET", "/events", Value::Null).await?;
                let events: Vec<Event> =
                    serde_json::from_value(result["events"].clone()).map_err(|_| ())?;
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
                    self.events.set(Some(events));
                    if let Some(briefing) = briefing {
                        self.briefing.set(briefing);
                    }
                    self.failed.set(false);
                }
                Err(()) => self.failed.set(true),
            }
            self.loading.set(false);
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
        loading: RwSignal::new(false),
        failed: RwSignal::new(false),
        view: RwSignal::new("day".into()),
        cursor: RwSignal::new(None),
        work: RwSignal::new(false),
        saving: RwSignal::new(false),
        unsaved: RwSignal::new(false),
        initialized: RwSignal::new(false),
    };
    let scroll_position = RwSignal::new(None::<i32>);
    let peek = RwSignal::new(None::<Event>);
    let pick = Callback::new(move |event| peek.set(Some(event)));
    let day_pick = Callback::new(move |day| {
        if !state.saving.get_untracked() {
            state.cursor.set(Some(day));
            state.view.set("day".into());
            state.persist();
        }
    });
    state.refresh();
    let tick = Closure::<dyn Fn()>::new(move || state.refresh());
    watch(tick.as_ref().unchecked_ref());
    tick.forget();
    if settings() {
        return view! {<Settings state=state/>}.into_any();
    }
    view! {<main class="cal-wrap" aria-label="Calendar">
        <div class="cal-toolbar"><div class="cal-toolbar__left">
            <Button variant=ButtonVariant::Secondary disabled=Signal::derive(move||state.saving.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(state.today()));state.persist();})>"Today"</Button>
            <div class="cal-nav"><Button variant=ButtonVariant::Quiet disabled=Signal::derive(move||state.saving.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(model::navigate(state.day(),&state.view.get(),-1)));state.persist();})>"Previous"</Button>
            <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move||state.saving.get()) on_click=Callback::new(move |_|{state.cursor.set(Some(model::navigate(state.day(),&state.view.get(),1)));state.persist();})>"Next"</Button></div>
            <h1 class="cal-range">{move||{
                let day=state.day();
                match state.view.get().as_str(){"month"=>day.format("%B %Y").to_string(),"week"=>{let days=model::week(day,state.work.get());format!("{} – {}",days[0].format("%b %-d"),days.last().unwrap().format("%b %-d, %Y"))},_=>day.format("%a, %B %-d, %Y").to_string()}
            }}</h1>
        </div><div class="cal-toolbar__right">
            {move||(state.view.get()=="week").then(||view!{<Button variant=ButtonVariant::Secondary disabled=Signal::derive(move||state.saving.get()) on_click=Callback::new(move |_|{state.work.update(|v|*v=!*v);state.persist();})>{move||if state.work.get(){"Show full week"}else{"Show work week"}}</Button>})}
            <div class="calendar-toolbar-actions" role="group" aria-label="Calendar view">
                {[ ("day","Day"),("week","Week"),("month","Month") ].into_iter().map(|(key,label)|view!{
                    <button type="button" class=move||format!("jds-btn jds-btn--secondary{}",if state.view.get()==key{" jds-btn--active"}else{""}) aria-pressed=move||state.view.get()==key disabled=move||state.saving.get() on:click=move |_|{if key!="day"{state.cursor.set(Some(state.today()));}state.view.set(key.into());state.persist();}>{label}</button>
                }).collect_view()}
            </div>
        </div></div>
        <div class="cal-legend"><span>"Accepted · Moss holding"</span><span>{move||state.zone().name()}</span></div>
        <div class="cal-notice" aria-live="polite">
            {move||state.loading.get().then(||view!{<p role="status">"Loading calendar…"</p>})}
            {move||state.failed.get().then(||view!{<ReadFailure retained=state.events.get().is_some() on_retry=Callback::new(move |_|state.refresh())/>})}
            {move||state.unsaved.get().then(||view!{<p role="status">"Your view choice could not be saved. It will last for this visit."</p>})}
        </div>
        {move||state.events.get().map(|events|{
            let empty=events.is_empty();
            let groups=model::group(&events,state.zone());
            view!{
                {empty.then(||view!{<EmptyState title="No events yet" description="Events from your connected calendars will appear here."/>})}
                <div class="cal-body" tabindex="0" aria-label="Calendar days">{if state.view.get()=="month" {
                    view!{<Month cursor=state.day() today=state.today() events=groups twelve=state.twelve() on_day=day_pick on_event=pick/>}.into_any()
                }else{
                    let days=if state.view.get()=="week" {model::week(state.day(),state.work.get())}else{vec![state.day()]};
                    let now=chrono::DateTime::parse_from_rfc3339(state.display.get()["now"].as_str().unwrap_or("")).ok().map(|d|d.with_timezone(&state.zone())).map(|d|d.hour()*60+d.minute()).unwrap_or(0);
                    view!{<TimeGrid days=days today=state.today() now_min=now events=groups twelve=state.twelve() on_event=pick scroll_position=scroll_position/>}.into_any()
                }}</div>
            }
        })}
        {move||peek.get().map(|event|view!{<EventDetails event=event timezone=state.zone().name().into() twelve=state.twelve() on_close=Callback::new(move |_|peek.set(None))/>})}
    </main>}.into_any()
}

#[component]
fn Settings(state: State) -> impl IntoView {
    view! {<main class="calendar-settings"><Masthead title="Calendar" eyebrow="Settings" lede="How Moss helps you plan your days"/>
        {move||state.loading.get().then(||view!{<p role="status">"Loading settings…"</p>})}
        {move||state.failed.get().then(||view!{<ReadFailure retained=state.briefing.get()!=Value::Null on_retry=Callback::new(move |_|state.refresh())/>})}
        {move||(state.briefing.get()!=Value::Null).then(||{
            let s=state.briefing.get()["settings"].clone();
            view!{<dl><dt>"Look ahead"</dt><dd>{format!("{} days",s["lookaheadDays"])}</dd><dt>"Prep tasks"</dt><dd>{s["prepTaskMode"].as_str().unwrap_or("suggest").to_string()}</dd><dt>"Time blocks"</dt><dd>{s["timeBlockMode"].as_str().unwrap_or("suggest").to_string()}</dd><dt>"Timezone"</dt><dd>{state.zone().name()}</dd></dl>}
        })}
        <p>"Automation settings are currently view-only."</p>
        <Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|{let _=navigate("/calendar");})>"Open Calendar"</Button>
    </main>}
}
