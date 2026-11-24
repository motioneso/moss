//! Catalog controls mirror the public @moss/ui primitives.
use leptos::prelude::*;
#[component]
pub fn Switch(
    #[prop(into)] aria_label: String,
    #[prop(into)] checked: Signal<bool>,
    #[prop(into, default = false.into())] disabled: Signal<bool>,
    on_change: Callback<bool>,
) -> impl IntoView {
    view! {<label class="jds-switch"><input type="checkbox" aria-label=aria_label
        prop:checked=move || checked.get() disabled=move || disabled.get()
        on:change=move |event| on_change.run(event_target_checked(&event))/>
        <span class="jds-switch__track"><span class="jds-switch__thumb"></span></span>
    </label>}
}
#[derive(Clone, Copy, Default)]
pub enum BadgeTone {
    #[default]
    Neutral,
    Forest,
    Amber,
    Red,
}
#[component]
pub fn Badge(#[prop(optional)] tone: BadgeTone, children: Children) -> impl IntoView {
    let class = match tone {
        BadgeTone::Neutral => "jds-badge jds-badge--neutral",
        BadgeTone::Forest => "jds-badge jds-badge--forest",
        BadgeTone::Amber => "jds-badge jds-badge--amber",
        BadgeTone::Red => "jds-badge jds-badge--red",
    };
    view! {<span class=class>{children()}</span>}
}

#[component]
pub fn TabLink(
    #[prop(into)] href: String,
    #[prop(into, default=false.into())] active: Signal<bool>,
    children: Children,
) -> impl IntoView {
    view! {<a class="jds-tab" href=href aria-current=move ||active.get().then_some("page")>{children()}</a>}
}
