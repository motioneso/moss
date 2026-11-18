use leptos::ev::SubmitEvent;
use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::model::{self, Group, List, Task};
use crate::{api, dom, icons};

#[component]
pub fn App() -> impl IntoView {
    let tasks = RwSignal::new(None::<Vec<Task>>);
    let lists = RwSignal::new(Vec::<List>::new());

    let reload = move |focus: Option<u32>| {
        spawn_local(async move {
            if let Ok(rows) = api::list_tasks().await {
                tasks.set(Some(rows));
                dom::mark("rows-rendered");
            }
            if let Some(index) = focus {
                dom::refocus_checkbox(index).await;
            }
        });
    };
    spawn_local(async move {
        if let Ok(rows) = api::list_lists().await {
            lists.set(rows);
        }
    });
    reload(None);

    let lede = move || {
        tasks.get().map(|rows| {
            let n = model::open_count(&rows);
            format!("{n} open {}", if n == 1 { "task" } else { "tasks" })
        })
    };
    let groups = move || tasks.get().map(|rows| model::group_by_priority(&rows)).unwrap_or_default();

    view! {
        <section class="tasks-page tasks--comfortable tasks--panels" aria-label="Tasks">
            <header class="jds-masthead jds-masthead--field">
                <div class="jds-masthead__row">
                    <div class="jds-masthead__main">
                        <h1 class="jds-masthead__title">
                            <span>"Tasks"</span>
                            <span class="jds-masthead__mark" aria-hidden="true">"."</span>
                        </h1>
                        <p class="jds-masthead__lede">{lede}</p>
                    </div>
                    <div class="jds-masthead__aside">
                        <div class="jds-segmented jds-segmented--field" role="group" aria-label="View">
                            <button type="button" class="jds-segmented__opt" aria-pressed="true">"List"</button>
                            <button type="button" class="jds-segmented__opt" aria-pressed="false" disabled>"Grid"</button>
                        </div>
                    </div>
                </div>
            </header>
            <div class="tasks-body">
                <div class="tasks-layout">
                    <aside class="tasks-index">
                        <nav class="jds-navindex" aria-label="Lists">
                            <p class="jds-navindex__label">"Lists"</p>
                            <ul class="jds-navindex__list">
                                <li class="jds-navindex__row">
                                    <button type="button" class="jds-navindex__item" aria-pressed="true">
                                        <span class="jds-navindex__name">"All"</span>
                                        <span class="jds-navindex__count">
                                            {move || model::list_count(&tasks.get().unwrap_or_default(), None)}
                                        </span>
                                    </button>
                                </li>
                                {move || {
                                    lists
                                        .get()
                                        .into_iter()
                                        .map(|list| {
                                            let id = list.id.clone();
                                            view! {
                                                <li class="jds-navindex__row">
                                                    <button type="button" class="jds-navindex__item" aria-pressed="false">
                                                        <span class="jds-navindex__name">{list.name}</span>
                                                        <span class="jds-navindex__count">
                                                            {move || model::list_count(&tasks.get().unwrap_or_default(), Some(&id))}
                                                        </span>
                                                    </button>
                                                </li>
                                            }
                                        })
                                        .collect_view()
                                }}
                            </ul>
                        </nav>
                    </aside>
                    <div class="tasks-main">
                        <Capture on_added=move || reload(None) />
                        <div class="tasks-groups">
                            {move || {
                                groups()
                                    .into_iter()
                                    .map(|group| view! { <GroupView group lists on_changed=reload /> })
                                    .collect_view()
                            }}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    }
}

#[component]
fn Capture(on_added: impl Fn() + Copy + 'static) -> impl IntoView {
    let title = RwSignal::new(String::new());
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    let submit = move |event: SubmitEvent| {
        event.prevent_default();
        let text = title.get_untracked().trim().to_owned();
        if text.is_empty() || pending.get_untracked() {
            return;
        }
        pending.set(true);
        spawn_local(async move {
            match api::create_task(&text).await {
                Ok(()) => {
                    title.set(String::new());
                    error.set(None);
                    on_added();
                }
                Err(message) => error.set(Some(format!("Could not add the task. {message}"))),
            }
            pending.set(false);
        });
    };

    view! {
        <form class="task-capture" aria-label="Capture a task" on:submit=submit>
            <div class="tk-add">
                <span class="tk-add__plus" inner_html=icons::plus(18)></span>
                <input
                    type="text"
                    aria-label="Task title"
                    placeholder="Add a task \u{2014} type and press Enter\u{2026}"
                    prop:value=move || title.get()
                    on:input:target=move |event| title.set(event.target().value())
                />
                <div class="tk-add__actions">
                    <button type="button" class="jds-btn jds-btn--secondary jds-btn--sm">
                        <span class="jds-btn__icon" inner_html=icons::sliders(14)></span>
                        "Details"
                    </button>
                    <button
                        type="submit"
                        class="jds-btn jds-btn--primary jds-btn--sm"
                        disabled=move || pending.get() || title.get().trim().is_empty()
                    >
                        "Add task"
                    </button>
                </div>
            </div>
            <Show when=move || error.get().is_some()>
                <p class="jds-hint jds-hint--error" role="alert">{move || error.get()}</p>
            </Show>
        </form>
    }
}

#[component]
fn GroupView(
    group: Group,
    lists: RwSignal<Vec<List>>,
    on_changed: impl Fn(Option<u32>) + Copy + 'static,
) -> impl IntoView {
    let heading = format!("tasks-group-{}", group.value.map_or("none".to_owned(), |v| v.to_string()));
    let heading2 = heading.clone();
    let count = group.tasks.len();
    let swatch = format!("--tk-swatch: {}", model::priority_color(group.value));
    view! {
        <section class="tasks-group" aria-labelledby=heading>
            <div class="jds-section-head jds-section-head--rule">
                <span class="jds-section-head__marker" aria-hidden="true">
                    <span class="tk-panel__dot" style=swatch></span>
                </span>
                <h2 class="jds-section-head__title" id=heading2>{group.label}</h2>
                <span class="jds-section-head__meta">
                    {format!("{count} {}", if count == 1 { "task" } else { "tasks" })}
                </span>
            </div>
            <div class="tasks-group__rows">
                {group
                    .tasks
                    .into_iter()
                    .map(|task| view! { <TaskRow task lists on_changed /> })
                    .collect_view()}
            </div>
        </section>
    }
}

#[component]
fn TaskRow(
    task: Task,
    lists: RwSignal<Vec<List>>,
    on_changed: impl Fn(Option<u32>) + Copy + 'static,
) -> impl IntoView {
    let done = RwSignal::new(task.status == "done");
    let id = task.id.clone();
    let toggle = move |_| {
        let next = !done.get_untracked();
        let focus = dom::focused_checkbox_index();
        done.set(next);
        let id = id.clone();
        spawn_local(async move {
            match api::set_done(&id, next).await {
                Ok(()) => on_changed(focus),
                Err(_) => done.set(!next),
            }
        });
    };
    let due = model::due_info(&task);
    let title = task.title.clone();
    let open_label = format!("Open {title}");
    let check_label = move || format!("{} {}", if done.get() { "Reopen" } else { "Complete" }, task.title);
    let chip = move || {
        model::list_chip(&lists.get(), &task.list_id).map(|(name, color)| {
            view! {
                <span class="tk-listchip">
                    <span class="tk-listchip__dot" style=format!("--tk-swatch: {color}")></span>
                    {name}
                </span>
            }
        })
    };
    let badge = due.as_ref().filter(|d| d.show_badge).map(|d| {
        let icon = if d.tone == "overdue" { icons::alert(12) } else { icons::calendar(12) };
        let class = match d.tone {
            "" => "tk-meta-due".to_owned(),
            tone => format!("tk-meta-due tk-meta-due--{tone}"),
        };
        view! { <span class=class><span class="ic" inner_html=icon></span>{d.label.clone()}</span> }
    });
    let drift = due.as_ref().and_then(|d| d.drift).map(|kind| {
        view! {
            <span class=format!("jds-drift jds-drift--{kind}")>
                <span class="jds-drift__dot"></span>
                {if kind == "overdue" { "Overdue" } else { "At risk" }}
            </span>
        }
    });
    let tag_names: Vec<String> = task.tags.iter().map(|t| format!("#{}", t.name)).collect();
    let extra_tags = task.tags.len().saturating_sub(2);
    view! {
        <div class="tk-task" class:tk-task--done=move || done.get()>
            <span class="tk-task__bar" style=format!("--tk-swatch: {}", model::priority_color(task.priority))></span>
            <span class="tk-task__check">
                <label class="jds-check">
                    <input
                        type="checkbox"
                        prop:checked=move || done.get()
                        aria-label=check_label
                        on:change=toggle
                    />
                    <span class="jds-check__box" inner_html=icons::check(13)></span>
                </label>
            </span>
            <button type="button" class="jds-rowbtn tk-task__main" aria-label=open_label.clone()>
                <span class="tk-task__title">{title}</span>
                <span class="tk-task__meta">
                    {badge} {drift} {chip}
                    {tag_names.into_iter().take(2).map(|t| view! { <span class="tk-metatag">{t}</span> }).collect_view()}
                    {(extra_tags > 0).then(|| view! { <span class="tk-metatag">{format!("+{extra_tags}")}</span> })}
                </span>
            </button>
            <div class="tk-task__right">
                {task.effort.as_deref().map(|e| {
                    let label = format!("{} effort", e[..1].to_uppercase() + &e[1..]);
                    view! { <span class="tk-effort-fill" title=label.clone() aria-label=label inner_html=icons::effort(e)></span> }
                })}
                <span class="tk-task__open">
                    <button type="button" class="jds-iconbtn jds-iconbtn--sm" aria-label=open_label inner_html=icons::panel_right(15)></button>
                </span>
            </div>
        </div>
    }
}
