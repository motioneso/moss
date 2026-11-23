//! Existing report layout with explicit review, confirmation and execution results.
use crate::{
    review_controller::{Action, Controller},
    review_model as model,
    today::{ReviewSchedule, Snapshot},
    today_model::Item,
};
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonSize, ButtonVariant, ReportDialog};
use serde_json::Value;

#[component]
pub(crate) fn Review(ctl: Controller, on_close: Callback<()>) -> impl IntoView {
    let state = ctl.state;
    let snapshot = state.get_untracked().snapshot;
    let busy = Signal::derive(move || state.get().busy);
    let dismiss = on_close;
    let wide = web_sys::window()
        .unwrap()
        .inner_width()
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        > 1080.0;
    let rows = snapshot.items();
    let ordered = model::blocks(state.get_untracked().plan())
        .iter()
        .filter_map(|b| {
            rows.iter()
                .find(|i| i.id == format!("block:{}", b["id"].as_str().unwrap_or_default()))
                .cloned()
        })
        .collect::<Vec<_>>();
    view! {<ReportDialog title="Your day, prepared." on_close=dismiss>
        <div class="brief-reader brief-reader--report" role="document" aria-busy=busy>
            <div class="brief-reader__head">
                <p class="brief-reader__eyebrow">{format!("{} / Morning briefing",snapshot.name())}</p>
                <h2 id="today-review-title" class="brief-reader__title" data-briefing-title tabindex="-1" autofocus>"Your day, prepared."</h2>
                <Button variant=ButtonVariant::Quiet size=ButtonSize::Small aria_label="Close briefing reader" on_click=Callback::new(move |_|dismiss.run(()))>"Close"</Button>
            </div>
            <div class="brief-reader__tabs"><div class="brief-reader__tablist" role="tablist" aria-label="Morning briefing views">
                <button class="brief-reader__tab" type="button" role="tab" aria-selected="false" disabled>"The briefing"</button>
                <button class="brief-reader__tab brief-reader__tab--selected" type="button" role="tab" aria-selected="true" aria-controls="today-review-panel" id="today-review-tab">"Review task blocks"</button>
            </div></div>
            <div class="brief-reader__body"><div class="brief-reader__grid">
                {(!wide).then(||view! {<ReviewSchedule snapshot=Signal::derive(move||state.get().display_snapshot()) />})}
                <div class="brief-reader__report" role="tabpanel" id="today-review-panel" aria-labelledby="today-review-tab" data-briefing-surface="review">
                    <h3 class="brief-reader__headline">"Make the plan fit."</h3>
                    <p class="plan-review__lede">"Meetings, lunch, and travel stay in place. Adjust the task blocks around them."</p>
                    <div class="plan-review__accept"><Button disabled=Signal::derive(move|| {
                        let s=state.get();s.busy || !s.invalid.is_empty() || model::other_edits(s.plan(),&s.choices) || model::selection(s.plan(),&s.choices,true).is_empty()
                    }) on_click=Callback::new(move |_|ctl.run(Action::Accept))>"Accept all time blocks"</Button></div>
                    <ul class="plan-review__rows">{ordered.into_iter().map(|item|view! {<ReviewRow item=item ctl=ctl />}).collect_view()}</ul>
                    <div class="plan-review__changes"><h3 class="plan-review__changes-title">"What will change"</h3>
                        {move|| {
                            let s=state.get();let selected=model::selection(s.plan(),&s.choices,false);
                            if selected.is_empty() {view! {<p class="plan-review__empty">"No changes selected."</p>}.into_any()}
                            else {view! {<ul>{selected.iter().map(|id| {
                                let b=model::blocks(s.plan()).iter().find(|b|b["id"]==*id).unwrap();
                                let item=rows.iter().find(|i|i.id==format!("block:{id}"));
                                let pending=model::pending(b,&s.choices);
                                let at=pending["startsAt"].as_str().map(|at|format!(" at {}",model::local_time(at,s.snapshot.zone()))).unwrap_or_default();
                                let action=match pending["kind"].as_str() {Some("add")=>"Add",Some("move")=>"Move",Some("remove")=>"Remove",_=>"Change"};
                                view! {<li>{format!("{action} {}{at}",item.map(|i|i.title.as_str()).unwrap_or("Task block"))}</li>}
                            }).collect_view()}</ul>}.into_any()}
                        }}
                    </div>
                    {move||state.get().notice.map(|n|view! {<p class="plan-review__status" role="status" data-error-code="calendar_today_review_unavailable">{n}</p>})}
                    {move|| {
                        let s=state.get();(!s.approval.is_null()).then(||view! {
                            <section class="plan-review__confirm" aria-label="Confirm calendar changes">
                                <h3 class="plan-review__changes-title">"Confirm calendar changes"</h3>
                                <ul>{s.approval["changes"].as_array().into_iter().flatten().map(|c|view! {<li>{change_text(c,&s.snapshot)}</li>}).collect_view()}</ul>
                                <p>"The tasks themselves remain on your list."</p>
                                <div class="plan-review__confirm-actions">
                                    <Button disabled=busy on_click=Callback::new(move |_|ctl.run(Action::Confirm))>"Confirm"</Button>
                                    <Button variant=ButtonVariant::Quiet disabled=busy on_click=Callback::new(move |_|state.update(|s|s.approval=Value::Null))>"Keep reviewing"</Button>
                                </div>
                            </section>
                        })
                    }}
                    {move|| {
                        let s=state.get();(!s.report.is_null()).then(||view! {
                            <section class="plan-review__status" aria-label="Calendar changes result">
                                <p role="status">{model::report_text(&s.report)}</p>
                                {(!model::retry_ids(&s.report).is_empty()).then(||view! {<Button disabled=busy on_click=Callback::new(move |_|ctl.run(Action::Retry))>"Retry"</Button>})}
                            </section>
                        })
                    }}
                </div>
                {wide.then(||view! {<ReviewSchedule snapshot=Signal::derive(move||state.get().display_snapshot()) />})}
            </div></div>
            <div class="brief-reader__footer"><div class="brief-reader__footer-actions"><Button disabled=Signal::derive(move||state.get().busy || !state.get().invalid.is_empty() || state.get().choices.is_empty()) on_click=Callback::new(move |_|ctl.run(Action::Save))>"Save changes"</Button></div><div class="brief-reader__footer-back"><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_|dismiss.run(()))>"Back to Today"</Button></div></div>
        </div>
    </ReportDialog>}
}
fn change_text(c: &Value, snapshot: &Snapshot) -> String {
    let title = snapshot
        .items()
        .into_iter()
        .find(|i| i.id == format!("block:{}", c["blockId"].as_str().unwrap_or_default()))
        .map(|i| i.title)
        .unwrap_or_else(|| "Task block".into());
    let kind = match c["kind"].as_str() {
        Some("add") => "Add",
        Some("move") => "Move",
        Some("remove") => "Remove",
        _ => "Change",
    };
    let at = c["startsAt"]
        .as_str()
        .map(|at| format!(" at {}", model::local_time(at, snapshot.zone())))
        .unwrap_or_default();
    format!("{kind} {title}{at}")
}
#[component]
fn ReviewRow(item: Item, ctl: Controller) -> impl IntoView {
    let state = ctl.state;
    let id = item
        .id
        .strip_prefix("block:")
        .unwrap_or_default()
        .to_owned();
    let current = Signal::derive(move || {
        let s = state.get();
        model::blocks(s.plan())
            .iter()
            .find(|b| b["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    });
    let zone = state.get_untracked().snapshot.zone();
    let choice = Signal::derive(move || model::choice(&current.get(), &state.get().choices));
    let on_calendar = Memo::new(move |_| model::on_calendar(&current.get()));
    let key = item.id.replace(':', "-");
    let start_time = Signal::derive(move || {
        let b = current.get();
        let c = choice.get();
        model::local_time(
            c.starts_at
                .as_deref()
                .or_else(|| b["pendingChange"]["startsAt"].as_str())
                .or_else(|| b["actualPlacement"]["startsAt"].as_str())
                .unwrap_or_default(),
            zone,
        )
    });
    let row_id = item.id.clone();
    let unavailable = item.unavailable;
    let meta = move || {
        let s = state.get();
        let block = current.get();
        let saved = s.snapshot.items().into_iter().find(|i| i.id == row_id);
        if unavailable {
            return "No longer available".to_string();
        }
        let pending = model::pending(&block, &s.choices);
        let changed = pending != block["pendingChange"];
        let transient = if changed {
            match pending["kind"].as_str() {
                Some("remove") => Some("Will remove"),
                Some("move") => Some("Time change"),
                Some("add") => Some("To schedule"),
                _ => None,
            }
        } else {
            None
        };
        let reason = transient
            .map(str::to_owned)
            .or_else(|| saved.as_ref().and_then(|i| i.review_reason.clone()))
            .unwrap_or_else(|| saved.map(|i| i.label.to_owned()).unwrap_or_default());
        model::duration(&block)
            .map(|m| format!("{m} minutes · {reason}"))
            .unwrap_or(reason)
    };
    view! {<li class="plan-review__row"><div><div class="plan-review__title">{item.title.clone()}</div><div class="plan-review__meta">{meta}</div>
        {move|| {
            let s=state.get();let b=current.get();let id=b["id"].as_str().unwrap_or_default();
            let mut messages=vec![];
            if let Some(p)=s.preview["blocks"].as_array().and_then(|a|a.iter().find(|p|p["blockId"]==id)) {
                if p["eligible"]==false {messages.push("This task can't be scheduled.".to_string());}
                if p["deadlineRisk"]==true {messages.push("This time is after the task's deadline.".to_string());}
            }
            for c in s.preview["conflicts"].as_array().into_iter().flatten().filter(|c|c["blockId"]==id) {
                messages.push(c["detail"].as_str().unwrap_or("This time conflicts with another block.").into());
            }
            for i in s.report["items"].as_array().into_iter().flatten().filter(|i|i["blockId"]==id) {
                let outcome=match i["outcome"].as_str() {Some("applied")=>"Applied",Some("failed")=>"Failed",Some("pending")=>"Pending",_=>"Needs check"};
                messages.push(if i["outcome"]=="failed" {i["result"]["reason"].as_str().map(|r|format!("Failed: {}",r.replace('-'," "))).unwrap_or_else(||outcome.into())} else {outcome.into()});
            }
            messages.into_iter().map(|m|view! {<p class="plan-review__meta">{m}</p>}).collect_view()
        }}
    </div>
        {(!item.unavailable).then(||view! {<div class="plan-review__fields">
            {item.minutes.is_some().then(||view! {<div class="plan-review__field"><label class="plan-review__label plan-review__label--time" for=format!("{key}-time")>"Time"</label><input class="plan-review__time plan-review__field--time" type="time" id=format!("{key}-time") aria-label=format!("{}: start time",item.title) prop:value=start_time disabled=move||state.get().busy || matches!(choice.get().placement.as_str(),"leave"|"remove") on:change=move|ev| {
                let b=current.get_untracked();let s=state.get_untracked();
                if let Some(at)=model::instant(b["localDay"].as_str().unwrap_or_else(||s.plan()["localDay"].as_str().unwrap_or_default()),&event_target_value(&ev),zone) {
                    ctl.edit(b["id"].as_str().unwrap_or_default().into(),if model::on_calendar(&b) {"move"} else {"add"}.into(),Some(at));
                } else {state.update(|s| {s.invalid.insert(b["id"].as_str().unwrap_or_default().into()); s.approval=Value::Null; s.preview=Value::Null; s.notice=Some("Choose a valid local time for this day.".into());});}
            } /></div>})}
            <div class="plan-review__field plan-review__field--placement"><label class="plan-review__label plan-review__label--placement" for=format!("{key}-placement")>"Placement"</label><select class="jds-select" id=format!("{key}-placement") aria-label=format!("{}: placement",item.title) prop:value=move||choice.get().placement disabled=move||state.get().busy on:change=move|ev| {
                let b=current.get_untracked();let c=choice.get_untracked();let placement=event_target_value(&ev);
                let at=if matches!(placement.as_str(),"add"|"move") {c.starts_at.or_else(||model::start(&b))} else {None};
                ctl.edit(b["id"].as_str().unwrap_or_default().into(),placement,at);
            }>
                {move||if on_calendar.get() {view! {<option value="keep">"Keep as is"</option><option value="move" disabled=move||model::duration(&current.get()).is_none()>"Move"</option><option value="remove">"Remove"</option>}.into_any()} else {view! {<option value="add" disabled=move||model::duration(&current.get()).is_none()>"Add to calendar"</option><option value=move||if current.get()["taskId"].is_null() {"keep"} else {"keep-proposed"}>"Keep proposed"</option><option value="leave">"Leave unscheduled"</option>}.into_any()}}
            </select></div>
        </div>})}
    </li>}
}
