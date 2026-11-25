//! Authored briefing report modal, using the browser's focus and Escape lifecycle.
use leptos::prelude::*;

#[component]
pub fn ReportDialog(
    #[prop(into)] title: String,
    on_close: Callback<()>,
    children: Children,
) -> impl IntoView {
    let dialog = NodeRef::<leptos::html::Dialog>::new();
    #[cfg(target_arch = "wasm32")]
    Effect::new(move |_| {
        if let Some(element) = dialog.get() {
            let _ = element.show_modal();
            on_cleanup(move || element.close());
        }
    });
    view! {<dialog node_ref=dialog class="brief-reader__scrim module-report-dialog"
        aria-label=title on:close=move |_|on_close.run(())>
        {children()}
    </dialog>}
}

#[component]
pub fn SectionHead(#[prop(into)] title: String) -> impl IntoView {
    view! {<div class="jds-section-head jds-section-head--center tl-head">
        <span class="jds-section-head__number">"01"</span>
        <h2 class="jds-section-head__title tl-title">{title}</h2>
    </div>}
}
#[component]
pub fn PlanNote(children: Children) -> impl IntoView {
    view! {<div class="jds-note jds-note--plan tl-note">{children()}</div>}
}

/// Native modal lifecycle with the shared Park Press dialog surface.
#[component]
pub fn Dialog(
    #[prop(into)] title: String,
    on_close: Callback<()>,
    children: Children,
) -> impl IntoView {
    let dialog = NodeRef::<leptos::html::Dialog>::new();
    #[cfg(target_arch = "wasm32")]
    Effect::new(move |_| {
        if let Some(element) = dialog.get() {
            let _ = element.show_modal();
            let _ = element.focus();
            on_cleanup(move || element.close());
        }
    });
    view! {<dialog node_ref=dialog class="jds-dialog module-native-dialog" tabindex="-1" aria-label=title on:close=move |_|on_close.run(())>{children()}</dialog>}
}
