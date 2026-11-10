//! Authored compact controls, using the same classes and button semantics as @moss/ui.
use crate::ButtonSize;
use leptos::prelude::*;

#[component]
pub fn Segmented(
    #[prop(into)] aria_label: String,
    value: Signal<String>,
    options: Vec<(String, String)>,
    on_change: Callback<String>,
    #[prop(into, default = false.into())] disabled: Signal<bool>,
) -> impl IntoView {
    view! {
        <div class="jds-segmented" role="group" aria-label=aria_label>
            {options.into_iter().map(|(key, label)| {
                let selected = key.clone();
                view! {
                    <button type="button" class="jds-segmented__opt"
                        aria-pressed=move || (value.get() == selected).to_string()
                        disabled=move || disabled.get()
                        on:click=move |_| on_change.run(key.clone())>{label}</button>
                }
            }).collect_view()}
        </div>
    }
}

#[component]
pub fn IconButton(
    #[prop(into)] aria_label: String,
    #[prop(optional)] size: ButtonSize,
    #[prop(into, default = false.into())] disabled: Signal<bool>,
    on_click: Callback<leptos::ev::MouseEvent>,
    children: Children,
) -> impl IntoView {
    let class = match size {
        ButtonSize::Small => "jds-iconbtn jds-iconbtn--sm",
        ButtonSize::Medium => "jds-iconbtn",
        ButtonSize::Large => "jds-iconbtn jds-iconbtn--lg",
    };
    view! {
        <button type="button" class=class aria-label=aria_label
            disabled=move || disabled.get() on:click=move |event| on_click.run(event)>
            {children()}
        </button>
    }
}
