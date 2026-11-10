use crate::model;
use chrono::NaiveDate;
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonSize, ButtonVariant, IconButton, Segmented};

#[component]
pub fn Toolbar(
    view: Signal<String>,
    work: Signal<bool>,
    day: Signal<NaiveDate>,
    disabled: Signal<bool>,
    on_today: Callback<()>,
    on_navigate: Callback<i32>,
    on_view: Callback<String>,
    on_work: Callback<bool>,
) -> impl IntoView {
    view! {
        <div class="cal-toolbar">
            <div class="cal-toolbar__left">
                <Button variant=ButtonVariant::Secondary size=ButtonSize::Small disabled=disabled
                    on_click=Callback::new(move |_| on_today.run(()))>"Today"</Button>
                <div class="cal-nav">
                    <IconButton aria_label="Previous" size=ButtonSize::Small disabled=disabled
                        on_click=Callback::new(move |_| on_navigate.run(-1))>
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
                    </IconButton>
                    <IconButton aria_label="Next" size=ButtonSize::Small disabled=disabled
                        on_click=Callback::new(move |_| on_navigate.run(1))>
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                    </IconButton>
                </div>
                <h2 class="cal-range">{move || {
                    let day = day.get();
                    view! {
                        {(view.get() == "day").then(|| view! {<span class="cal-range__dow">{day.format("%a").to_string()}</span>})}
                        {model::range_label(day, &view.get(), work.get())}
                    }
                }}</h2>
            </div>
            <div class="cal-toolbar__right">
                {move || (view.get() == "week").then(|| view! {
                    <Segmented aria_label="Week type" disabled=disabled
                        value=Signal::derive(move || if work.get() {"work"} else {"full"}.into())
                        options=vec![("work".into(), "Work week".into()), ("full".into(), "Full week".into())]
                        on_change=Callback::new(move |key: String| on_work.run(key == "work"))/>
                })}
                <Segmented aria_label="View" value=view disabled=disabled
                    options=vec![("day".into(), "Day".into()), ("week".into(), "Week".into()), ("month".into(), "Month".into())]
                    on_change=on_view/>
            </div>
        </div>
    }
}
