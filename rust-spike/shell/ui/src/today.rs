//! Today: hero, section links, quick actions and the day timeline.
//! Markup and class names follow `apps/web/src/today/` (today-hero, today-timeline,
//! today-quick-actions, today-quiet-line) as the current app renders them.

use leptos::prelude::*;
use leptos::task::spawn_local;
use moss_shell_contract::{
    QuickActionControl, QuickActionGroup, SlotKind, TimelineSlot, TodayHero, TodayView,
};

use crate::api;
use crate::frame::Navigate;

const WEATHER_SETTINGS: &str = "/settings?section=profile";

#[component]
pub fn TodayPage() -> impl IntoView {
    let today = RwSignal::new(None::<Result<TodayView, String>>);
    spawn_local(async move { today.set(Some(api::today().await)) });

    move || match today.get() {
        None => view! { <section class="today-hero" aria-busy="true"></section> }.into_any(),
        Some(Err(error)) => view! {
            <p class="cmd-empty" role="status">{format!("Today couldn't load. {error}")}</p>
        }
        .into_any(),
        Some(Ok(view)) => view! { <Today view=view /> }.into_any(),
    }
}

#[component]
fn Today(view: TodayView) -> impl IntoView {
    let has_actions = view.quick_actions.is_some();
    view! {
        <Hero hero=view.hero />
        <nav class="cmd-sections today-hero__sections" aria-label="Sections">
            <span class="today-hero__sections-label">"In this briefing"</span>
            <a href="#start-here">"Your day & preparation"</a>
            {has_actions.then(|| view! { <a href="#needs-you">"Quick actions"</a> })}
        </nav>
        <div class="cmd-wrap">
            <div class="cmd-grid" data-mode="day">
                {view.quick_actions.map(|group| view! { <QuickActions group=group /> })}
                <div class="cmd-main">
                    <Timeline slots=view.timeline closing=view.timeline_closing />
                    {view.quiet_line.map(|line| view! {
                        <section class="today-quiet-line" id="start-here" aria-label="Your day so far">
                            <p class="cmd-empty today-quiet-line__text" role="status">{line}</p>
                        </section>
                    })}
                    <div id="needs-you"></div>
                </div>
                <aside class="cmd-aside" aria-label="Today widgets">
                    <div class="cmd-aside__inner"></div>
                </aside>
            </div>
        </div>
    }
}

#[component]
fn Hero(hero: TodayHero) -> impl IntoView {
    view! {
        <section class="today-hero" data-mode="day">
            <p class="jds-eyebrow jds-eyebrow--strong jds-eyebrow--hero today-hero__eyebrow">{hero.greeting}</p>
            <h1 class="today-hero__title">
                <span>{hero.headline}</span>
                " "
                <span class="today-hero__accent">{hero.headline_accent}</span>
            </h1>
            <div class="today-hero__summary" id="assessment"><span>{hero.summary}</span></div>
            <hr class="today-hero__hairline" />
            {hero.weather_note.map(|note| view! {
                <div class="today-hero__weather" id="weather">
                    <p class="cmd-empty" role="status">{note} " " <a
                        href=WEATHER_SETTINGS
                        on:click=move |event: leptos::ev::MouseEvent| {
                            if let Some(Navigate(go)) = use_context::<Navigate>() {
                                event.prevent_default();
                                go.run(WEATHER_SETTINGS.to_string());
                            }
                        }
                    >"Weather settings"</a></p>
                </div>
            })}
            <div class="today-hero__prepared">
                <span class="today-hero__not-ready">{hero.briefing_note}</span>
            </div>
        </section>
    }
}

#[component]
fn QuickActions(group: QuickActionGroup) -> impl IntoView {
    view! {
        <section class="cmd-dock" aria-label="Quick actions">
            <div class="well">
                <div class="well__head">
                    <span class="jds-eyebrow jds-eyebrow--strong jds-eyebrow--accent well__eyebrow">"Quick actions"</span>
                    <span class="well__title">{group.title}</span>
                </div>
                {group.actions.into_iter().map(|action| view! {
                    <div class="well__row">
                        <div class="well__rowtext">
                            <div class="well__label">{action.label}</div>
                            {action.sub.map(|sub| view! { <div class="well__sub">{sub}</div> })}
                        </div>
                        {match action.control {
                            QuickActionControl::Add { label } => view! {
                                <button type="button" class="jds-iconbtn jds-iconbtn--sm" aria-label=label>"+"</button>
                            }.into_any(),
                            QuickActionControl::Button { text } => view! {
                                <button type="button" class="jds-btn jds-btn--primary jds-btn--sm">{text}</button>
                            }.into_any(),
                        }}
                    </div>
                }).collect_view()}
            </div>
        </section>
    }
}

#[component]
fn Timeline(slots: Vec<TimelineSlot>, closing: Option<String>) -> impl IntoView {
    view! {
        <section class="jds-brief jds-brief--timeline" id="schedule">
            <div class="jds-section-head jds-section-head--center tl-head">
                <span class="jds-section-head__number">"01"</span>
                <h2 class="jds-section-head__title tl-title">"Your day, laid out"</h2>
            </div>
            <div class="tl-legend">
                <span><i class="tl-legend__filled" aria-hidden="true"></i>"Moss-planned task"</span>
                <span><i class="tl-legend__open" aria-hidden="true"></i>"Calendar commitment"</span>
            </div>
            <div class="day-list">
                {slots.into_iter().map(|slot| view! { <DaySlot item=slot /> }).collect_view()}
            </div>
            {closing.map(|line| view! { <p class="tl-closing">{line}</p> })}
        </section>
    }
}

/// Matches the current app's wording: "45 min", "90 min", "1 hour", "2 hours".
fn length_label(minutes: u32) -> String {
    match minutes {
        m if m % 60 != 0 => format!("{m} min"),
        60 => "1 hour".into(),
        m => format!("{} hours", m / 60),
    }
}

#[component]
fn DaySlot(item: TimelineSlot) -> impl IntoView {
    let slot = item;
    let time = view! {
        <div class="day-ev__t tl-time">{slot.start}<small>{slot.end}</small></div>
    };
    match slot.kind {
        SlotKind::Event => view! {
            <div class="day-ev tl-slot tl-slot--event">
                {time}
                <div class="tl-body">
                    <div class="tl-block">
                        <div class="day-ev__title">{slot.title}</div>
                        <div class="day-ev__where">
                            {length_label(slot.duration_minutes)}
                            {slot.detail.map(|d| format!(" · {d}"))}
                        </div>
                    </div>
                </div>
            </div>
        }
        .into_any(),
        kind => {
            let (state, state_text) = match kind {
                SlotKind::Proposed => ("proposed", "Proposed"),
                _ => ("committed", "Planned"),
            };
            view! {
                <div class=format!("jds-task tl-slot tl-slot--{state}") data-state=state>
                    {time}
                    <div class="tl-body">
                        <div class="jds-task__main">
                            <div class="jds-task__title">{slot.title}</div>
                            <div class="jds-task__meta">
                                <span class="tl-meta-len">{length_label(slot.duration_minutes)}</span>
                                <span class="tl-meta-divider" aria-hidden="true">"·"</span>
                                {slot.detail.map(|d| view! { <span class="jds-task__source">{d}</span> })}
                                <span class="jds-task__state">{state_text}</span>
                            </div>
                        </div>
                    </div>
                </div>
            }
            .into_any()
        }
    }
}
