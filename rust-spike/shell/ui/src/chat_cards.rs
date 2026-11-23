//! The TypeScript action-request-card markup, using the stylesheet already shipped by the shell.
use leptos::prelude::*;
use leptos::task::spawn_local;
use moss_shell_contract::{
    ApprovalKind, ApprovalState, ApprovalView, ChatThread, CompletedWrite, Decision,
};

#[component]
pub fn ApprovalCard(card: ApprovalView, on_thread: Callback<ChatThread>) -> impl IntoView {
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let root = NodeRef::<leptos::html::Div>::new();
    let outcome = match card.state {
        ApprovalState::Pending => None,
        ApprovalState::Approved | ApprovalState::Used => Some("Approved"),
        ApprovalState::Declined => Some("You declined"),
        ApprovalState::TimedOut => Some("Timed out"),
        ApprovalState::Voided => Some("Approval no longer available. Ask Moss again."),
    };
    if let Some(outcome) = outcome {
        request_animation_frame(move || {
            if let Some(el) = root.get_untracked() {
                let _ = el.focus();
            }
        });
        return view! {
            <div class="action-request-outcome" tabindex="-1" node_ref=root data-action-request-id=card.id>
                <p class="chatd-status" role="status">{format!("{outcome} · {}", card.title)}</p>
            </div>
        }.into_any();
    }
    let complete =
        !card.target.trim().is_empty() && card.fields.iter().all(|f| !f.label.trim().is_empty());
    let id = StoredValue::new(card.id.clone());
    let resolve = move |decision| {
        if busy.get_untracked() || (decision == Decision::Approve && !complete) {
            return;
        }
        busy.set(true);
        error.set(None);
        spawn_local(async move {
            match crate::api::decide_approval(&id.get_value(), decision).await {
                Ok(t) => on_thread.run(t),
                Err(e) => error.set(Some(e)),
            }
            busy.set(false);
            request_animation_frame(move || {
                if let Some(el) = root.get_untracked() {
                    let _ = el.focus();
                }
            });
        });
    };
    let permission = card.kind == ApprovalKind::Permission;
    view! {
        <div class="action-request-card" role="region" aria-label="Action request"
            aria-busy=move || busy.get().to_string() data-action-request-id=card.id tabindex="-1" node_ref=root>
            <div class="jds-card jds-card--pad-sm" aria-label=card.title.clone()>
                <div class="action-request-stack">
                    <h2 class="action-request-title">{card.title.clone()}</h2>
                    {if complete {
                        view! {
                            <p class=if permission { "action-request-target action-request-summary" } else { "action-request-target" }>{card.target}</p>
                            <div class=if permission { "" } else { "action-request-details" }
                                role="region" aria-label="Complete action details" tabindex="0">
                            <dl class="action-request-fields">
                                {card.fields.into_iter().map(|field| view! {
                                    <div class="action-request-field">
                                        <dt>{field.label.clone()}</dt>
                                        <dd>{
                                            if permission && field.label == "Details" {
                                                view! { <pre class="action-request-arguments">{field.value}</pre> }.into_any()
                                            } else { field.value.into_any() }
                                        }</dd>
                                    </div>
                                }).collect_view()}
                            </dl>
                            {card.content.map(|content| view! {
                                <div class="action-request-preview">
                                    <dl class="action-request-preview__meta">
                                        <div class="action-request-preview__row">
                                            <dt class="action-request-preview__label">"Content"</dt>
                                            <dd class="action-request-preview__value">"Review before approving"</dd>
                                        </div>
                                    </dl>
                                    <p class="action-request-preview__body">{content}</p>
                                </div>
                            })}
                            </div>
                        }.into_any()
                    } else {
                        view! { <p class="jds-hint action-request-notice" role="status">"Details for this request aren’t available. Reject it and ask Moss again."</p> }.into_any()
                    }}
                    <div class="action-request-actions">
                        {complete.then(|| view! {
                            <button type="button" class=if card.danger { "jds-btn jds-btn--danger" } else { "jds-btn jds-btn--primary" }
                                disabled=move || busy.get() on:click=move |_| resolve(Decision::Approve)>{if card.batch { "Approve entire batch" } else { "Approve" }}</button>
                        })}
                        <button type="button" class="jds-btn jds-btn--secondary" disabled=move || busy.get()
                            on:click=move |_| resolve(Decision::Reject)>{if card.batch { "Reject entire batch" } else { "Reject" }}</button>
                    </div>
                    <Show when=move || busy.get()><p class="jds-hint" role="status">"Resolving…"</p></Show>
                    {move || error.get().map(|e| view! { <p class="form-error" role="status">{e}</p> })}
                </div>
            </div>
        </div>
    }.into_any()
}

#[component]
pub fn DoneRow(done: CompletedWrite) -> impl IntoView {
    view! {
        <div class="action-request-outcome" data-completed-write-id=done.id>
            <p class="chatd-status" role="status">"Done"</p>
            <dl class="action-request-fields">
                {done.changed.into_iter().map(|f| view! {
                    <div class="action-request-field">
                        <dt>{f.label}</dt>
                        <dd>{format!("{} → {}", f.before, f.after)}</dd>
                    </div>
                }).collect_view()}
            </dl>
        </div>
    }
}
