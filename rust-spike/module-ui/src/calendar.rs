//! Calendar primitives matching the authored React kit's markup and classes.
use leptos::prelude::*;

#[component]
pub fn EventChip(
    #[prop(into)] title: String,
    #[prop(into)] time: String,
    #[prop(into)] geometry: String,
    #[prop(optional)] block: bool,
    #[prop(optional)] tentative: bool,
    on_pick: Callback<()>,
) -> impl IntoView {
    let variant = if block {
        "cal-ev--block cal-ev--ghost"
    } else if tentative {
        "cal-ev--tentative"
    } else {
        "cal-ev--hard"
    };
    let style = format!(
        "{geometry};--ev:{}",
        if block {
            "var(--accent-fg)"
        } else {
            "var(--steel)"
        }
    );
    view! {<button type="button" class=format!("cal-ev {variant}") style=style on:click=move |_| on_pick.run(())>
        <span class="cal-ev__bar"></span><span class="cal-ev__body"><span class="cal-ev__title"><span class="cal-ev__titletext">{title}</span></span><span class="cal-ev__meta">{time}</span></span>
    </button>}
}
#[component]
pub fn MonthChip(
    #[prop(into)] title: String,
    #[prop(into)] time: String,
    #[prop(optional)] block: bool,
    on_pick: Callback<()>,
) -> impl IntoView {
    view! {<button type="button" class=if block {"cal-mchip is-block"} else {"cal-mchip"}
        style=if block {"--ev:var(--accent-fg)"} else {"--ev:var(--steel)"} on:click=move |_| on_pick.run(())>
        <span class="cal-mchip__dot"></span><span class="cal-mchip__t">{time}</span><span class="cal-mchip__title">{title}</span>
    </button>}
}
#[component]
pub fn AllDayChip(#[prop(into)] title: String, on_pick: Callback<()>) -> impl IntoView {
    view! {<button type="button" class="cal-allchip" style="--ev:var(--steel)" on:click=move |_| on_pick.run(())><span class="cal-allchip__dot"></span>{title}</button>}
}
#[component]
pub fn DayCell(
    #[prop(into)] label: String,
    #[prop(optional)] today: bool,
    #[prop(optional)] outside: bool,
    on_pick: Callback<()>,
    children: Children,
) -> impl IntoView {
    let class = format!(
        "cal-mcell{}{}",
        if today { " is-today" } else { "" },
        if outside { " is-out" } else { "" }
    );
    view! {<div class=class><button type="button" class="cal-mcell__date" on:click=move |_| on_pick.run(())><span class="cal-mcell__dnum">{label}</span></button><div class="cal-mcell__evs">{children()}</div></div>}
}

/// Uses the browser's modal focus containment, inert background, Escape dismissal and
/// focus restoration. It is mounted for one open lifecycle, then removed on close.
#[component]
pub fn PeekPanel(on_close: Callback<()>, children: Children) -> impl IntoView {
    let dialog = NodeRef::<leptos::html::Dialog>::new();
    #[cfg(target_arch = "wasm32")]
    Effect::new(move |_| {
        if let Some(element) = dialog.get() {
            let _ = element.show_modal();
        }
    });
    view! {<dialog node_ref=dialog class="cal-peek cal-native-dialog" aria-label="Event details"
        on:close=move |_| on_close.run(())
        on:click=move |event| {
            if event.target() == event.current_target() {
                #[cfg(target_arch = "wasm32")]
                if let Some(element)=dialog.get() {element.close();}
            }
        }>
        <super::Button variant=super::ButtonVariant::Quiet on_click=Callback::new(move |_| {
            #[cfg(target_arch = "wasm32")]
            if let Some(element)=dialog.get() {element.close();}
            #[cfg(not(target_arch = "wasm32"))]
            on_close.run(());
        })>"Close"</super::Button>
        {children()}
    </dialog>}
}
