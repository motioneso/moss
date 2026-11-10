use crate::{
    model::{self, Event},
    views::*,
};
use chrono::{NaiveDate, Timelike};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, EmptyState, Field, FormLabel, Masthead};
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
    #[wasm_bindgen(js_namespace=calendarBridge, js_name=restoreFocus)]
    fn restore_focus(saved: &JsValue);
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn navigate(path: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_namespace=calendarBridge)]
    fn watch(callback: &js_sys::Function);
    #[wasm_bindgen(js_namespace=calendarBridge, js_name=revealToday)]
    fn reveal_today();
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
    briefing_saving: RwSignal<bool>,
    briefing_failed: RwSignal<bool>,
    briefing_saved: RwSignal<bool>,
    loading: RwSignal<Refresh>,
    failed: RwSignal<bool>,
    view: RwSignal<String>,
    cursor: RwSignal<Option<NaiveDate>>,
    work: RwSignal<bool>,
    saving: RwSignal<bool>,
    unsaved: RwSignal<bool>,
    initialized: RwSignal<bool>,
    scroll_position: RwSignal<Option<i32>>,
}
impl State {
    fn save_briefing(self, body: Value) {
        if self.briefing_saving.get_untracked() || self.loading.get_untracked() != Refresh::Idle {
            return;
        }
        let focused = preserve();
        self.briefing_saving.set(true);
        self.briefing_failed.set(false);
        self.briefing_saved.set(false);
        spawn_local(async move {
            match request("PATCH", "/briefing-settings", body).await {
                Ok(mut saved) => {
                    // The settings response carries no switches; keep the ones on screen.
                    saved["sources"] = self.briefing.get_untracked()["sources"].clone();
                    self.briefing.set(saved);
                    self.briefing_saved.set(true);
                }
                Err(_) => {
                    self.briefing_failed.set(true);
                    // Reapply confirmed values, including the select changed by the browser.
                    self.briefing.set(self.briefing.get_untracked());
                }
            }
            self.briefing_saving.set(false);
            restore(&focused);
        });
    }
    fn save_source(self, body: Value) {
        if self.briefing_saving.get_untracked() || self.loading.get_untracked() != Refresh::Idle {
            return;
        }
        let focused = preserve();
        self.briefing_saving.set(true);
        self.briefing_failed.set(false);
        self.briefing_saved.set(false);
        spawn_local(async move {
            match request("PATCH", "/source-behaviors", body).await {
                Ok(saved) => {
                    let mut current = self.briefing.get_untracked();
                    current["sources"] = saved;
                    self.briefing.set(current);
                    self.briefing_saved.set(true);
                }
                Err(_) => {
                    self.briefing_failed.set(true);
                    self.briefing.set(self.briefing.get_untracked());
                }
            }
            self.briefing_saving.set(false);
            restore(&focused);
        });
    }
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
    fn assistant_name(self) -> String {
        self.display.get()["assistantName"]
            .as_str()
            .unwrap_or("Moss")
            .to_string()
    }
    fn twelve(self) -> bool {
        model::twelve(self.display.get()["dateFormat"].as_str())
    }
    fn refresh(self, explicit: bool) {
        if self.loading.get_untracked() != Refresh::Idle || self.briefing_saving.get_untracked() {
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
                    let mut briefing = request("GET", "/briefing-settings", Value::Null).await?;
                    // A failed switch read shows both as on rather than failing the screen.
                    briefing["sources"] = request("GET", "/source-behaviors", Value::Null)
                        .await
                        .unwrap_or(Value::Null);
                    Some(briefing)
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
                    let previous_zone = self.zone();
                    self.display.set(display);
                    if self.zone() != previous_zone {
                        self.scroll_position.set(None);
                    }
                    if let Some(events) = events {
                        if self.events.get_untracked().as_ref() != Some(&events) {
                            let saved = preserve();
                            self.events.set(Some(events));
                            restore(&saved);
                        }
                    }
                    if let Some(briefing) = briefing {
                        self.briefing.set(briefing);
                        self.briefing_saved.set(false);
                        self.briefing_failed.set(false);
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
        let focused = preserve();
        self.saving.set(true);
        let body = json!({"view":self.view.get_untracked(),"cursor":self.day().to_string(),"workWeek":self.work.get_untracked()});
        spawn_local(async move {
            self.unsaved
                .set(request("PATCH", "/display-settings", body).await.is_err());
            self.saving.set(false);
            restore_focus(&focused);
        });
    }
}

#[component]
pub fn Calendar() -> impl IntoView {
    let state = State {
        events: RwSignal::new(None),
        display: RwSignal::new(Value::Null),
        briefing: RwSignal::new(Value::Null),
        briefing_saving: RwSignal::new(false),
        briefing_failed: RwSignal::new(false),
        briefing_saved: RwSignal::new(false),
        loading: RwSignal::new(Refresh::Idle),
        failed: RwSignal::new(false),
        view: RwSignal::new("day".into()),
        cursor: RwSignal::new(None),
        work: RwSignal::new(false),
        saving: RwSignal::new(false),
        unsaved: RwSignal::new(false),
        initialized: RwSignal::new(false),
        scroll_position: RwSignal::new(None),
    };
    let zone = Memo::new(move |_| state.zone());
    let assistant_name = Memo::new(move |_| state.assistant_name());
    let twelve = Memo::new(move |_| state.twelve());
    let today = Memo::new(move |_| state.today());
    let held_today = Memo::new(move |_| {
        model::group(&state.events.get().unwrap_or_default(), zone.get())
            .get(&today.get())
            .map(|items| items.iter().filter(|s| s.event.is_moss_block).count())
            .unwrap_or(0)
    });
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
    let has_calendar = Memo::new(move |_| state.events.get().is_some());
    Effect::new(move |_| {
        let _ = (cursor.get(), state.view.get(), state.work.get(), zone.get());
        if has_calendar.get() {
            reveal_today();
        }
    });
    state.refresh(false);
    let tick = Closure::<dyn Fn()>::new(move || state.refresh(false));
    watch(tick.as_ref().unchecked_ref());
    tick.forget();
    if settings() {
        return view! {<Settings state=state/>}.into_any();
    }
    view! {<main class="cal-wrap" aria-label="Calendar">
        <crate::toolbar::Toolbar view=state.view.into() work=state.work.into() day=cursor.into()
            disabled=Signal::derive(move||state.saving.get() || !state.initialized.get())
            on_today=Callback::new(move |_|{state.cursor.set(Some(state.today()));state.persist();})
            on_navigate=Callback::new(move |direction|{state.cursor.set(Some(model::navigate(state.day(),&state.view.get(),direction)));state.persist();})
            on_view=Callback::new(move |key: String|{if key!="day"{state.cursor.set(Some(state.today()));}state.view.set(key);state.persist();})
            on_work=Callback::new(move |work|{state.work.set(work);state.persist();})/>
        {move||view!{<CalendarLegend view=state.view.get() day=cursor.get() today=today.get() held=held_today.get() assistant_name=assistant_name.get()/>}}
        {move||(state.view.get()=="week").then(||view!{<p class="cal-scroll-hint jds-caption" id="calendar-scroll-hint">"Scroll sideways to see more days, or choose Day for a closer look."</p>})}
        <div class="cal-notice" aria-live="polite">
            {move||(state.loading.get()!=Refresh::Idle && (state.events.get().is_none() || state.loading.get()==Refresh::Explicit)).then(||view!{<p role="status">{if state.events.get().is_some(){"Refreshing calendar…"}else{"Loading calendar…"}}</p>})}
            {move||state.failed.get().then(||view!{<ReadFailure retained=state.events.get().is_some() on_retry=Callback::new(move |_|state.refresh(true))/>})}
            {move||state.unsaved.get().then(||view!{<p role="status">"Your view choice could not be saved. It will last for this visit."</p>})}
        </div>
        <div class="cal-body" role="region" tabindex=move||if state.view.get()=="day"{None}else{Some("0")} aria-label=move||format!("Calendar {}",state.view.get()) aria-describedby=move||(state.view.get()=="week").then_some("calendar-scroll-hint")>{move||state.events.get().map(|events|{
            let empty=events.is_empty();
            let groups=model::group(&events,zone.get());
            view!{
                {empty.then(||view!{<EmptyState title="No events yet" description="Events from your connected calendars will appear here."/>})}
                {if state.view.get()=="month" {
                    view!{<Month cursor=cursor.get() today=today.get() events=groups twelve=twelve.get() on_day=day_pick on_event=pick/>}.into_any()
                }else{
                    let days=if state.view.get()=="week" {model::week(cursor.get(),state.work.get())}else{vec![cursor.get()]};
                    view!{<TimeGrid days=days today=today.get() now_min=now events=groups twelve=twelve.get() on_event=pick scroll_position=state.scroll_position/>}.into_any()
                }}
            }
        })}</div>
        {move||peek.get().map(|event|view!{<EventDetails event=event timezone=zone.get().name().into() twelve=twelve.get() assistant_name=assistant_name.get() on_close=Callback::new(move |_|{peek.set(None);restore(&opening.get_value());})/>})}
    </main>}.into_any()
}

#[component]
fn Settings(state: State) -> impl IntoView {
    let disabled =
        Signal::derive(move || state.briefing_saving.get() || state.loading.get() != Refresh::Idle);
    view! {<main class="calendar-settings">{move||view!{<Masthead title="Calendar" eyebrow="Settings" lede=format!("How {} helps you plan your days",state.assistant_name())/>}}
        {move||(state.loading.get()!=Refresh::Idle && (state.briefing.get()==Value::Null || state.loading.get()==Refresh::Explicit)).then(||view!{<p role="status">{if state.briefing.get()==Value::Null {"Loading settings…"}else{"Refreshing settings…"}}</p>})}
        {move||state.failed.get().then(||view!{<ReadFailure settings_page=true retained=state.briefing.get()!=Value::Null on_retry=Callback::new(move |_|state.refresh(true))/>})}
        {move||(state.briefing.get()!=Value::Null).then(||view!{
            <section class="calendar-settings-section" aria-label="Briefings">
                <h2>"Briefings"</h2>
                <Field><FormLabel control_id="calendar-lookahead">"Look ahead"</FormLabel>
                    <p class="jds-hint" id="lookahead-help">"Let the briefing flag prep-needed meetings coming up soon."</p>
                    <span class="jds-selectwrap"><select id="calendar-lookahead" data-cal-focus="calendar-lookahead" class="jds-select" aria-describedby="lookahead-help"
                        disabled=move||disabled.get()
                        prop:value=move||state.briefing.get()["settings"]["lookaheadDays"].to_string()
                        on:change=move|event|{if let Ok(days)=event_target_value(&event).parse::<u8>() {state.save_briefing(json!({"lookaheadDays":days}));}}>
                        <option value="0">"Today only"</option><option value="1">"One day"</option><option value="2">"Two days"</option>
                    </select></span>
                </Field>
            </section>
            <section class="calendar-settings-section" aria-label="What your assistant may use">
                <h2>"What your assistant may use"</h2>
                <SourceSwitch state=state field="briefings" label="Include in briefings" help="Show today's events in your morning reading."/>
                <SourceSwitch state=state field="planning" label="Use for planning" help="Let scheduled briefings turn your meetings into saved day-plan blocks."/>
            </section>
            <section class="calendar-settings-section" aria-label="Follow-through">
                <h2>"Follow-through"</h2>
                <ModeSetting state=state field="prepTaskMode" label="Prep tasks"/>
                <ModeSetting state=state field="timeBlockMode" label="Time blocks"/>
                <p class="jds-hint">"Auto gives Moss permission to act without asking, including in the existing app. This version saves your choices but does not run automatic actions."</p>
            </section>
            <p class="jds-hint">{move||format!("Timezone: {}",state.zone().name())}</p>
        })}
        {move||state.briefing_saving.get().then(||view!{<p role="status">"Saving settings…"</p>})}
        {move||state.briefing_saved.get().then(||view!{<p role="status">"Settings saved."</p>})}
        {move||state.briefing_failed.get().then(||view!{<p class="jds-hint jds-hint--error" role="alert">"Could not save calendar briefing settings. Your last confirmed settings are shown. Check the connection and try again."</p>})}
        <Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|{let _=navigate("/calendar");})>"Open Calendar"</Button>
    </main>}
}

#[component]
fn ModeSetting(state: State, field: &'static str, label: &'static str) -> impl IntoView {
    let id = format!("calendar-{field}");
    let help = format!("{id}-help");
    view! {<Field><FormLabel control_id=id.clone()>{label}</FormLabel>
        <p class="jds-hint" id=help.clone()>{move||match state.briefing.get()["settings"][field].as_str() {
            Some("off")=>"Do not create suggestions or actions.",
            Some("auto") if field=="timeBlockMode"=>"Create time blocks automatically, both when your assistant proposes them in chat and unattended in the background.",
            Some("auto")=>"Create automatically without asking again.",
            _=>"Offer suggestions for you to review.",
        }}</p>
        <span class="jds-selectwrap"><select id=id.clone() data-cal-focus=id class="jds-select" aria-describedby=help
            disabled=move||state.briefing_saving.get() || state.loading.get()!=Refresh::Idle
            prop:value=move||state.briefing.get()["settings"][field].as_str().unwrap_or("suggest").to_string()
            on:change=move|event|state.save_briefing(json!({(field):event_target_value(&event)}))>
            <option value="off">"Off"</option><option value="suggest">"Suggest"</option><option value="auto">"Auto"</option>
        </select></span>
    </Field>}
}

#[component]
fn SourceSwitch(
    state: State,
    field: &'static str,
    label: &'static str,
    help: &'static str,
) -> impl IntoView {
    let id = format!("calendar-source-{field}");
    let help_id = format!("{id}-help");
    view! {<Field><FormLabel control_id=id.clone()>{label}</FormLabel>
        <p class="jds-hint" id=help_id.clone()>{help}</p>
        <span class="jds-selectwrap"><select id=id.clone() data-cal-focus=id class="jds-select" aria-describedby=help_id
            disabled=move||state.briefing_saving.get() || state.loading.get()!=Refresh::Idle
            prop:value=move||if state.briefing.get()["sources"][field] == false {"off"} else {"on"}
            on:change=move|event|state.save_source(json!({(field):event_target_value(&event)=="on"}))>
            <option value="on">"On"</option><option value="off">"Off"</option>
        </select></span>
    </Field>}
}
