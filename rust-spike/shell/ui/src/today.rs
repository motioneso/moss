//! Today: hero, section links, quick actions and the day timeline.
//! Markup and class names follow `apps/web/src/today/` (today-hero, today-timeline,
//! today-quick-actions, today-quiet-line) as the current app renders them.

use leptos::prelude::*;
use leptos::task::spawn_local;
use moss_shell_contract::{QuickActionControl, QuickActionGroup, TodayHero, TodayView};

use crate::api;
use crate::email_refresh::EmailRefresh;

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
                    <EmailRefresh />
                    <div data-module-section="calendar" data-screen-path="/today"></div>
                    {view.quiet_line.map(|line| view! {
                        <section class="today-quiet-line" id="start-here" aria-label="Your day so far">
                            <p class="cmd-empty today-quiet-line__text" role="status">{line}</p>
                        </section>
                    })}
                    <div data-module-section="commitments" data-screen-path="/today"></div>
                    <div id="needs-you"></div>
                    <div id="goals"><moss-goals-today></moss-goals-today></div>
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
            <crate::weather::HeroWeather />
            <div class="today-hero__prepared">
                <HeroNote />
                <HeroBriefing />
            </div>
        </section>
    }
}

/// Why there is no morning briefing yet, from the caller's saved Briefings records.
/// Hidden while loading, when Briefings is not installed, or when a readable run exists.
#[component]
fn HeroNote() -> impl IntoView {
    let note = RwSignal::new(None::<String>);
    spawn_local(async move { note.set(crate::hero_briefing::load_note().await) });
    move || {
        note.get().map(|text| {
            view! { <span class="today-hero__not-ready" role="status">{text}</span> }
        })
    }
}

/// Link to the Briefings reader, shown only when the Briefings package answers.
#[component]
fn HeroBriefing() -> impl IntoView {
    let available = RwSignal::new(false);
    spawn_local(async move { available.set(api::briefings_available().await) });
    move || {
        available.get().then(|| {
            view! {
                <a class="today-hero__briefing-link" href="/module-frame?module=briefings&path=%2Fbriefing">
                    "Read your briefing"
                </a>
            }
        })
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
