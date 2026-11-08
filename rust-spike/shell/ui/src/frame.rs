//! App frame: sidebar navigation, top bar, the page area and the chat drawer slot.
//! Markup and class names follow `apps/web/src/shell/app-shell.tsx` and `shell-nav.tsx`.

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use moss_shell_contract::{NavLink, ShellView};
use wasm_bindgen::{closure::Closure, JsCast};

use crate::{api, chat::ChatDrawer, focus, icons, today::TodayPage};

/// In-app navigation for links rendered below the frame.
#[derive(Clone, Copy)]
pub struct Navigate(pub Callback<String>);

const WIDE_QUERY: &str = "(min-width: 1280px)";
const PHONE_QUERY: &str = "(max-width: 720px)";
const NAV_STORAGE_KEY: &str = "jarvis.nav:v1";

#[component]
pub fn Icon(
    svg: &'static str,
    #[prop(into)] name: String,
    #[prop(default = 24)] size: u32,
) -> impl IntoView {
    view! {
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width=size
            height=size
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class=format!("lucide lucide-{name}")
            aria-hidden="true"
            inner_html=svg
        ></svg>
    }
}

#[component]
pub fn BrandMark(#[prop(default = 24)] size: u32) -> impl IntoView {
    view! {
        <svg viewBox="0 0 24 24" width=size height=size fill="none" aria-hidden="true" inner_html=icons::BRAND_MARK></svg>
    }
}

fn window() -> web_sys::Window {
    web_sys::window().expect("window")
}

/// A signal that follows a CSS media query.
fn media_signal(query: &'static str) -> ReadSignal<bool> {
    let list = window().match_media(query).ok().flatten();
    let (matches, set_matches) = signal(list.as_ref().map(|l| l.matches()).unwrap_or(false));
    if let Some(list) = list {
        let watched = list.clone();
        let on_change = Closure::<dyn Fn()>::new(move || set_matches.set(watched.matches()));
        list.set_onchange(Some(on_change.as_ref().unchecked_ref()));
        on_change.forget();
    }
    matches
}

fn current_url() -> String {
    let location = window().location();
    format!(
        "{}{}",
        location.pathname().unwrap_or_default(),
        location.search().unwrap_or_default()
    )
}

fn current_path() -> String {
    let path = window()
        .location()
        .pathname()
        .unwrap_or_else(|_| "/".into());
    if path == "/" || path.is_empty() {
        let _ = window().history().and_then(|h| {
            h.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some("/today"))
        });
        "/today".into()
    } else {
        path
    }
}

fn load_nav_rail() -> bool {
    window()
        .local_storage()
        .ok()
        .flatten()
        .and_then(|s| s.get_item(NAV_STORAGE_KEY).ok().flatten())
        .is_some_and(|v| v.trim() == "rail")
}

fn save_nav_rail(rail: bool) {
    if let Some(storage) = window().local_storage().ok().flatten() {
        let _ = storage.set_item(NAV_STORAGE_KEY, if rail { "rail" } else { "expanded" });
    }
}

/// "Sat · Nov 7", the shape the current top bar shows under Today.
fn today_subtitle() -> String {
    let now = js_sys::Date::new_0();
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} · {} {}",
        DAYS[now.get_day() as usize],
        MONTHS[now.get_month() as usize],
        now.get_date()
    )
    .to_uppercase()
}

#[component]
pub fn App() -> impl IntoView {
    let shell = RwSignal::new(None::<Result<ShellView, String>>);
    spawn_local(async move { shell.set(Some(api::shell().await)) });

    view! {
        {move || match shell.get() {
            None => view! { <div class="loading-screen" aria-busy="true"></div> }.into_any(),
            Some(Err(error)) => view! {
                <main class="auth-screen">
                    <section class="auth-panel">
                        <h1>"Moss can't reach its server"</h1>
                        <p class="form-error">{error}</p>
                    </section>
                </main>
            }.into_any(),
            Some(Ok(view)) => view! { <Frame shell=view /> }.into_any(),
        }}
    }
}

#[component]
fn Frame(shell: ShellView) -> impl IntoView {
    let wide = media_signal(WIDE_QUERY);
    let phone = media_signal(PHONE_QUERY);
    let path = RwSignal::new(current_path());
    let rail = RwSignal::new(load_nav_rail());
    let mobile_nav_open = RwSignal::new(false);
    let chat_open = RwSignal::new(false);
    let chat_expanded_wish = RwSignal::new(false);
    let chat_unread = RwSignal::new(shell.chat_unread);

    let dock_chat = Memo::new(move |_| wide.get());
    let expanded = Memo::new(move |_| {
        chat_expanded_wish.get() && dock_chat.get() && chat_open.get() && !phone.get()
    });

    let on_pop = Closure::<dyn Fn()>::new(move || path.set(current_path()));
    window().set_onpopstate(Some(on_pop.as_ref().unchecked_ref()));
    on_pop.forget();

    let nav_ref = NodeRef::<html::Aside>::new();
    let open_nav_button = NodeRef::<html::Button>::new();

    let navigate = move |to: String| {
        let route = to.split('?').next().unwrap_or_default().to_string();
        if current_url() != to {
            let _ = window()
                .history()
                .and_then(|h| h.push_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&to)));
        }
        path.set(route);
        if mobile_nav_open.get_untracked() {
            if let Some(button) = open_nav_button.get_untracked() {
                let _ = button.focus();
            }
        }
        mobile_nav_open.set(false);
        chat_expanded_wish.set(false);
    };

    provide_context(Navigate(Callback::new(navigate)));

    let chat_button = NodeRef::<html::Button>::new();

    // Closing the phone navigation by hand returns focus to the menu button.
    let close_nav = move || {
        mobile_nav_open.set(false);
        if let Some(button) = open_nav_button.get_untracked() {
            let _ = button.focus();
        }
    };
    Effect::new(move |_| {
        if mobile_nav_open.get() {
            request_animation_frame(move || {
                if let Some(nav) = nav_ref.get_untracked() {
                    focus::focus_first(&nav);
                }
            });
        }
    });
    let on_nav_keydown = move |event: ev::KeyboardEvent| {
        if !mobile_nav_open.get_untracked() {
            return;
        }
        match event.key().as_str() {
            "Escape" => {
                event.prevent_default();
                event.stop_propagation();
                close_nav();
            }
            "Tab" => {
                if let Some(nav) = nav_ref.get_untracked() {
                    focus::trap_tab(&event, &nav);
                }
            }
            _ => {}
        }
    };

    let nav = shell.nav.clone();
    let all_links: Vec<NavLink> = nav.iter().flat_map(|s| s.links.clone()).collect();
    let title = move || {
        let current = path.get();
        all_links
            .iter()
            .find(|l| l.path == current)
            .map(|l| l.label.clone())
            .unwrap_or_else(|| "Moss".into())
    };
    let subtitle = move || {
        let mut text = if path.get() == "/today" {
            today_subtitle()
        } else {
            String::new()
        };
        if shell.sample_data {
            if !text.is_empty() {
                text.push_str(" · ");
            }
            text.push_str("SAMPLE DATA");
        }
        text
    };
    let assistant_name = shell.assistant_name.clone();
    let chat_label = format!("Chat with {assistant_name}");
    let account = shell.account.clone();
    let account_label = if account.unread_notifications > 0 {
        format!(
            "Account menu, {} unread notifications",
            account.unread_notifications
        )
    } else {
        "Account menu".to_string()
    };
    let initial = account
        .display_name
        .chars()
        .next()
        .unwrap_or('?')
        .to_string();

    let on_toggle_chat = move |_| {
        if chat_open.get_untracked() {
            chat_open.set(false);
            chat_expanded_wish.set(false);
        } else {
            chat_open.set(true);
            chat_unread.set(0);
        }
    };

    view! {
        <div
            class="app-frame"
            data-nav=move || if rail.get() { "rail" } else { "expanded" }
            data-chat-expanded=move || expanded.get().then_some("true")
        >
            <aside
                id="moss-main-navigation"
                class=move || if mobile_nav_open.get() { "sidebar open" } else { "sidebar" }
                role=move || mobile_nav_open.get().then_some("dialog")
                aria-modal=move || mobile_nav_open.get().then_some("true")
                aria-label=move || mobile_nav_open.get().then_some("Navigation")
                node_ref=nav_ref
                on:keydown=on_nav_keydown
            >
                <div class="brand-row">
                    <div class="brand-lockup">
                        <span class="brand-mark"><BrandMark /></span>
                        <span class="brand-wordmark">{assistant_name.clone()}</span>
                    </div>
                    <Show when=move || mobile_nav_open.get()>
                        <span class="sidebar-mobile-close">
                            <button
                                type="button"
                                class="jds-iconbtn"
                                aria-label="Close navigation"
                                on:click=move |_| close_nav()
                            >
                                <Icon svg=icons::X name="x" />
                            </button>
                        </span>
                    </Show>
                    <span class="nav-collapse">
                        <button
                            type="button"
                            class="jds-iconbtn"
                            aria-expanded=move || if rail.get() { "false" } else { "true" }
                            aria-label=move || if rail.get() { "Expand navigation" } else { "Collapse navigation" }
                            title=move || if rail.get() { "Expand navigation" } else { "Collapse navigation" }
                            on:click=move |_| {
                                let next = !rail.get_untracked();
                                rail.set(next);
                                save_nav_rail(next);
                            }
                        >
                            {move || if rail.get() {
                                view! { <Icon svg=icons::CHEVRONS_RIGHT name="chevrons-right" /> }
                            } else {
                                view! { <Icon svg=icons::CHEVRONS_LEFT name="chevrons-left" /> }
                            }}
                        </button>
                    </span>
                </div>
                <nav class="module-nav" aria-label="Main">
                    {nav.into_iter().map(|section| view! {
                        <div class="nav-group">
                            {section.label.map(|label| view! { <p class="nav-group__label">{label}</p> })}
                            {section.links.into_iter().map(|link| {
                                let href = link.path.clone();
                                let target = link.path.clone();
                                let active = {
                                    let p = link.path.clone();
                                    move || path.get() == p
                                };
                                let active_class = active.clone();
                                view! {
                                    <a
                                        href=href
                                        class=move || if active_class() { "module-link active" } else { "module-link" }
                                        aria-current=move || active().then_some("page")
                                        title=link.label.clone()
                                        on:click=move |event: ev::MouseEvent| {
                                            if event.ctrl_key() || event.meta_key() || event.shift_key() { return; }
                                            event.prevent_default();
                                            navigate(target.clone());
                                        }
                                    >
                                        <Icon svg=icons::by_name(&link.icon) name=link.icon.clone() size=17 />
                                        <span class="module-link__label">{link.label.clone()}</span>
                                        {(link.unread > 0).then(|| view! { <span class="jds-badge-count">{link.unread}</span> })}
                                    </a>
                                }
                            }).collect_view()}
                        </div>
                    }).collect_view()}
                </nav>
                <div class="rail-foot">
                    <div class="jds-menu jds-menu--content shell-account-menu">
                        <button
                            type="button"
                            class="jds-menu__trigger jds-menu__trigger--content"
                            aria-label=account_label
                            title="Open account and sharing settings"
                            on:click=move |_| { let _ = window().location().set_href("/settings/sharing"); }
                        >
                            <span class="jds-avatar jds-avatar--sm" aria-hidden="true">{initial}</span>
                            <span class="jds-usermenu__id">
                                <span class="jds-usermenu__nm">{account.display_name.clone()}</span>
                            </span>
                            {(account.unread_notifications > 0).then(|| view! {
                                <span class="jds-badge-count" aria-hidden="true">{account.unread_notifications}</span>
                            })}
                            <Icon svg=icons::CHEVRON_UP name="chevron-up" size=16 />
                        </button>
                    </div>
                </div>
            </aside>
            <Show when=move || mobile_nav_open.get()>
                <div aria-hidden="true" class="sidebar-scrim" on:click=move |_| close_nav()></div>
            </Show>

            <div class="workspace-area">
                <header class="topbar" hidden=move || expanded.get()>
                    <button
                        aria-label="Open navigation"
                        aria-controls="moss-main-navigation"
                        aria-expanded=move || if mobile_nav_open.get() { "true" } else { "false" }
                        class="icon-button mobile-only"
                        title="Open navigation"
                        type="button"
                        node_ref=open_nav_button
                        on:click=move |_| mobile_nav_open.set(true)
                    >
                        <Icon svg=icons::MENU name="menu" size=20 />
                    </button>
                    <div class="topbar-titles">
                        <div class="topbar-title-row">
                            <span class="topbar-title">{title}</span>
                        </div>
                        <span class="topbar-subtitle">{subtitle}</span>
                    </div>
                    <div class="topbar-actions">
                        <button
                            aria-label=chat_label
                            aria-pressed=move || if chat_open.get() { "true" } else { "false" }
                            class=move || if chat_open.get() { "icon-button chat-unread-button active" } else { "icon-button chat-unread-button" }
                            title=format!("Ask {}", shell.assistant_name)
                            type="button"
                            node_ref=chat_button
                            on:click=on_toggle_chat
                        >
                            <Icon svg=icons::MESSAGE_SQUARE name="message-square" size=19 />
                            {move || (!chat_open.get() && chat_unread.get() > 0).then(|| view! {
                                <span class="chat-unread-button__badge">
                                    <span aria-hidden="true">
                                        <span class="jds-badge jds-badge--solid-pine jds-badge--pill">{chat_unread.get()}</span>
                                    </span>
                                </span>
                            })}
                        </button>
                        {move || (!chat_open.get() && chat_unread.get() > 0).then(|| {
                            let n = chat_unread.get();
                            view! {
                                <span class="jds-sr-only">
                                    {format!("{n} unread {}", if n == 1 { "message" } else { "messages" })}
                                </span>
                            }
                        })}
                    </div>
                </header>

                <div class=move || {
                    let mut class = String::from("workspace-body");
                    if dock_chat.get() && chat_open.get() { class.push_str(" workspace-body--docked"); }
                    if expanded.get() { class.push_str(" workspace-body--expanded"); }
                    class
                }>
                    <main class="content-surface" hidden=move || expanded.get()>
                        {move || if path.get() == "/today" {
                            view! { <TodayPage /> }.into_any()
                        } else {
                            view! { <NotPortedYet /> }.into_any()
                        }}
                    </main>
                    <ChatDrawer
                        assistant_name=shell.assistant_name.clone()
                        open=chat_open
                        docked=dock_chat
                        expanded=expanded
                        phone=phone
                        on_toggle_expanded=Callback::new(move |_| chat_expanded_wish.update(|v| *v = !*v))
                        on_close=Callback::new(move |_| {
                            chat_open.set(false);
                            chat_expanded_wish.set(false);
                            if let Some(button) = chat_button.get_untracked() {
                                let _ = button.focus();
                            }
                        })
                    />
                </div>
            </div>
        </div>
    }
}

#[component]
fn NotPortedYet() -> impl IntoView {
    view! {
        <div class="jds-empty">
            <div class="jds-empty__title">"Not built in the Rust app yet"</div>
            <div class="jds-empty__sub">"Today and the chat are the first screens. This one comes in a later phase."</div>
        </div>
    }
}
