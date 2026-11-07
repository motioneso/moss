//! Chat drawer: header, thread, waiting indicator and composer.
//! Markup and class names follow `apps/web/src/chat/chat-drawer.tsx`, `message-row.tsx`,
//! `chat-waiting-indicator.tsx` and `composer.tsx`.

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use moss_shell_contract::{ChatMessage, ChatRole, ChatThread};

use crate::frame::{BrandMark, Icon};
use crate::{api, icons};

#[component]
pub fn ChatDrawer(
    assistant_name: String,
    open: RwSignal<bool>,
    #[prop(into)] docked: Signal<bool>,
    #[prop(into)] expanded: Signal<bool>,
    #[prop(into)] phone: Signal<bool>,
    on_toggle_expanded: Callback<()>,
    on_close: Callback<()>,
) -> impl IntoView {
    let thread = RwSignal::new(None::<ChatThread>);
    let messages = RwSignal::new(Vec::<ChatMessage>::new());
    let load_error = RwSignal::new(None::<String>);
    let send_error = RwSignal::new(None::<String>);
    let waiting = RwSignal::new(false);
    let draft = RwSignal::new(String::new());
    let input_ref = NodeRef::<html::Textarea>::new();
    let body_ref = NodeRef::<html::Div>::new();

    // Load the thread the first time the drawer opens, and focus the composer on every open.
    Effect::new(move |_| {
        if !open.get() {
            return;
        }
        if thread.get_untracked().is_none() {
            spawn_local(async move {
                match api::chat_thread().await {
                    Ok(t) => {
                        messages.set(t.messages.clone());
                        thread.set(Some(t));
                    }
                    Err(e) => load_error.set(Some(e)),
                }
            });
        }
        request_animation_frame(move || {
            if let Some(input) = input_ref.get_untracked() {
                let _ = input.focus();
            }
        });
    });

    // Keep the newest message in view.
    Effect::new(move |_| {
        messages.track();
        waiting.track();
        request_animation_frame(move || {
            if let Some(body) = body_ref.get_untracked() {
                body.set_scroll_top(body.scroll_height());
            }
        });
    });

    let escape = window_event_listener(ev::keydown, move |event| {
        if event.key() == "Escape" && open.get_untracked() && !docked.get_untracked() {
            on_close.run(());
        }
    });
    on_cleanup(move || escape.remove());

    let send = move || {
        let text = draft.get_untracked().trim().to_string();
        if text.is_empty() || waiting.get_untracked() {
            return;
        }
        draft.set(String::new());
        send_error.set(None);
        waiting.set(true);
        messages.update(|m| {
            m.push(ChatMessage { id: format!("local-{}", m.len()), role: ChatRole::User, text: text.clone() })
        });
        spawn_local(async move {
            match api::send_message(text).await {
                Ok(reply) => messages.update(|m| m.push(reply)),
                Err(_) => send_error.set(Some("Your message didn't send. Try again.".into())),
            }
            waiting.set(false);
        });
    };

    let status = move || {
        thread.get().map(|t| t.status).unwrap_or_else(|| "Here when you need me".into())
    };
    let model_label = move || thread.get().map(|t| t.model_label).unwrap_or_default();
    let name = assistant_name.clone();
    let thinking_label = format!("{assistant_name} is thinking");

    let thinking_label = StoredValue::new(thinking_label);
    let assistant_name = StoredValue::new(assistant_name);
    let name = StoredValue::new(name);
    view! {
        <Show when=move || open.get()>
        <aside
            class=move || {
                let mut class = String::from("chatd");
                if docked.get() { class.push_str(" chatd--docked"); }
                if expanded.get() { class.push_str(" chatd--expanded"); }
                class
            }
            role="dialog"
            aria-modal=move || phone.get().then_some("true")
            aria-label=format!("Chat with {}", assistant_name.get_value())
        >
            <div class="chatd__head">
                <div class="chatd-overlay-background">
                    <span class="chatd__mark"><BrandMark size=16 /></span>
                    <div class="chatd__id">
                        <div class="chatd__name">{name.get_value()}</div>
                        <div class="chatd__status">{status}</div>
                    </div>
                    <Show when=move || docked.get() && !phone.get()>
                        <button
                            type="button"
                            class="jds-iconbtn"
                            aria-label=move || if expanded.get() { "Shrink chat" } else { "Expand chat" }
                            title=move || if expanded.get() { "Shrink chat" } else { "Expand chat" }
                            on:click=move |_| on_toggle_expanded.run(())
                        >
                            {move || if expanded.get() {
                                view! { <Icon svg=icons::MINIMIZE2 name="minimize2" /> }
                            } else {
                                view! { <Icon svg=icons::MAXIMIZE2 name="maximize2" /> }
                            }}
                        </button>
                    </Show>
                </div>
                <div class="chatd-conversations">
                    <button type="button" class="jds-iconbtn" aria-expanded="false" aria-label="Open conversations" disabled>
                        <Icon svg=icons::MENU name="menu" />
                    </button>
                </div>
                <div class="chatd-overlay-background">
                    <div class="jds-menu">
                        <button type="button" class="jds-menu__trigger" aria-label="More chat options" aria-expanded="false" disabled>
                            <Icon svg=icons::ELLIPSIS name="ellipsis" size=15 />
                        </button>
                    </div>
                    <button type="button" class="jds-iconbtn" aria-label="Close chat" title="Close chat" on:click=move |_| on_close.run(())>
                        <Icon svg=icons::X name="x" />
                    </button>
                </div>
            </div>

            <div class="chatd__body-wrap">
                <div class="chatd__body" node_ref=body_ref>
                    {move || load_error.get().map(|e| view! { <p class="form-error">{format!("Chat couldn't load. {e}")}</p> })}
                    <div class="chatd-thread">
                        <For each=move || messages.get() key=|m| m.id.clone() let:message>
                            <MessageRow message=message />
                        </For>
                        <Show when=move || waiting.get()>
                            <div class="chatd-loading" aria-live="polite" aria-label=thinking_label.get_value()>
                                <span class="chatd-msg__av"><BrandMark size=14 /></span>
                                <svg class="chatd-loading__bar" xmlns="http://www.w3.org/2000/svg" viewBox="0 14 32 4"
                                    fill="currentColor" preserveAspectRatio="none" aria-hidden="true"
                                    inner_html=LOADING_BAR></svg>
                            </div>
                        </Show>
                    </div>
                </div>
            </div>

            <div class="chatd-overlay-background">
                <div class="chatd__composer">
                    <div class="chatd__modelrow">
                        <div class="chatd-model chatd-model--locked">
                            <Icon svg=icons::LOCK name="lock" size=13 />
                            {model_label}
                        </div>
                    </div>
                    {move || send_error.get().map(|e| view! { <p class="form-error">{e}</p> })}
                    <div class="chatd-input">
                        <textarea
                            aria-label=format!("Message {}", assistant_name.get_value())
                            placeholder=format!("Message {}…", assistant_name.get_value())
                            rows="1"
                            node_ref=input_ref
                            prop:value=move || draft.get()
                            on:input=move |event| draft.set(event_target_value(&event))
                            on:keydown=move |event: ev::KeyboardEvent| {
                                if event.key() == "Enter" && !event.shift_key() && !event.is_composing() {
                                    event.prevent_default();
                                    send();
                                }
                            }
                        ></textarea>
                        <button type="button" class="jds-iconbtn" aria-label="Attach files" title="Attachments arrive with the chat port" disabled>
                            <Icon svg=icons::PAPERCLIP name="paperclip" />
                        </button>
                        <button type="button" class="jds-iconbtn" aria-label="Record voice message" title="Voice arrives with the chat port" disabled>
                            <Icon svg=icons::MIC name="mic" />
                        </button>
                        <button
                            class="chatd-send"
                            aria-label="Send"
                            type="button"
                            disabled=move || draft.get().trim().is_empty() || waiting.get()
                            on:click=move |_| send()
                        >
                            <Icon svg=icons::ARROW_UP name="arrow-up" size=17 />
                        </button>
                    </div>
                </div>
            </div>
        </aside>
        </Show>
    }
}

const LOADING_BAR: &str = r##"<path opacity="0.8" d="M2 14 V18 H6 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"></animateTransform></path><path opacity="0.5" d="M0 14 V18 H8 V14z"><animateTransform attributeName="transform" type="translate" values="0 0; 24 0; 0 0" dur="2s" begin="0.1s" repeatCount="indefinite" keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8" calcMode="spline"></animateTransform></path>"##;

#[component]
fn MessageRow(message: ChatMessage) -> impl IntoView {
    match message.role {
        ChatRole::User => view! {
            <div class="chatd-msg chatd-msg--me">
                <div class="chatd-bubble">{message.text}</div>
            </div>
        }
        .into_any(),
        ChatRole::Assistant => view! {
            <div class="chatd-msg">
                <span class="chatd-msg__av"><BrandMark size=14 /></span>
                <div class="chatd-bubble">
                    <div class="chatd-md"><p>{message.text}</p></div>
                </div>
            </div>
        }
        .into_any(),
    }
}
