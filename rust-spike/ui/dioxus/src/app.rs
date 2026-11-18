use dioxus::prelude::*;

use crate::model::{self, Group, List, Task};
use crate::{api, dom, icons};

#[component]
pub fn App() -> Element {
    let mut tasks = use_signal(|| None::<Vec<Task>>);
    let mut lists = use_signal(Vec::<List>::new);

    let reload = use_callback(move |focus: Option<u32>| {
        spawn(async move {
            if let Ok(rows) = api::list_tasks().await {
                tasks.set(Some(rows));
                dom::mark("rows-rendered");
            }
            if let Some(index) = focus {
                dom::refocus_checkbox(index).await;
            }
        });
    });
    use_hook(move || {
        spawn(async move {
            if let Ok(rows) = api::list_lists().await {
                lists.set(rows);
            }
        });
        reload.call(None);
    });

    let rows = tasks().unwrap_or_default();
    let lede = tasks().map(|rows| {
        let n = model::open_count(&rows);
        format!("{n} open {}", if n == 1 { "task" } else { "tasks" })
    });
    let groups = model::group_by_priority(&rows);

    rsx! {
        section { class: "tasks-page tasks--comfortable tasks--panels", "aria-label": "Tasks",
            header { class: "jds-masthead jds-masthead--field",
                div { class: "jds-masthead__row",
                    div { class: "jds-masthead__main",
                        h1 { class: "jds-masthead__title",
                            span { "Tasks" }
                            span { class: "jds-masthead__mark", "aria-hidden": "true", "." }
                        }
                        p { class: "jds-masthead__lede", {lede} }
                    }
                    div { class: "jds-masthead__aside",
                        div { class: "jds-segmented jds-segmented--field", role: "group", "aria-label": "View",
                            button { r#type: "button", class: "jds-segmented__opt", "aria-pressed": "true", "List" }
                            button { r#type: "button", class: "jds-segmented__opt", "aria-pressed": "false", disabled: true, "Grid" }
                        }
                    }
                }
            }
            div { class: "tasks-body",
                div { class: "tasks-layout",
                    aside { class: "tasks-index",
                        nav { class: "jds-navindex", "aria-label": "Lists",
                            p { class: "jds-navindex__label", "Lists" }
                            ul { class: "jds-navindex__list",
                                li { class: "jds-navindex__row",
                                    button { r#type: "button", class: "jds-navindex__item", "aria-pressed": "true",
                                        span { class: "jds-navindex__name", "All" }
                                        span { class: "jds-navindex__count", "{model::list_count(&rows, None)}" }
                                    }
                                }
                                for list in lists() {
                                    li { class: "jds-navindex__row", key: "{list.id}",
                                        button { r#type: "button", class: "jds-navindex__item", "aria-pressed": "false",
                                            span { class: "jds-navindex__name", "{list.name}" }
                                            span { class: "jds-navindex__count", "{model::list_count(&rows, Some(&list.id))}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    div { class: "tasks-main",
                        Capture { on_added: move |_| reload.call(None) }
                        div { class: "tasks-groups",
                            for group in groups {
                                GroupView { key: "{group.label}", group, lists, on_changed: reload }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn Capture(on_added: EventHandler<()>) -> Element {
    let mut title = use_signal(String::new);
    let mut pending = use_signal(|| false);
    let mut error = use_signal(|| None::<String>);

    let submit = move |event: FormEvent| {
        event.prevent_default();
        let text = title.peek().trim().to_owned();
        if text.is_empty() || *pending.peek() {
            return;
        }
        pending.set(true);
        spawn(async move {
            match api::create_task(&text).await {
                Ok(()) => {
                    title.set(String::new());
                    error.set(None);
                    on_added.call(());
                }
                Err(message) => error.set(Some(format!("Could not add the task. {message}"))),
            }
            pending.set(false);
        });
    };

    rsx! {
        form { class: "task-capture", "aria-label": "Capture a task", onsubmit: submit,
            div { class: "tk-add",
                span { class: "tk-add__plus", dangerous_inner_html: icons::plus(18) }
                input {
                    r#type: "text",
                    "aria-label": "Task title",
                    placeholder: "Add a task \u{2014} type and press Enter\u{2026}",
                    value: "{title}",
                    oninput: move |event| title.set(event.value()),
                }
                div { class: "tk-add__actions",
                    button { r#type: "button", class: "jds-btn jds-btn--secondary jds-btn--sm",
                        span { class: "jds-btn__icon", dangerous_inner_html: icons::sliders(14) }
                        "Details"
                    }
                    button {
                        r#type: "submit",
                        class: "jds-btn jds-btn--primary jds-btn--sm",
                        disabled: pending() || title().trim().is_empty(),
                        "Add task"
                    }
                }
            }
            if let Some(message) = error() {
                p { class: "jds-hint jds-hint--error", role: "alert", "{message}" }
            }
        }
    }
}

#[component]
fn GroupView(group: Group, lists: Signal<Vec<List>>, on_changed: Callback<Option<u32>>) -> Element {
    let heading = format!("tasks-group-{}", group.value.map_or("none".to_owned(), |v| v.to_string()));
    let count = group.tasks.len();
    let noun = if count == 1 { "task" } else { "tasks" };
    rsx! {
        section { class: "tasks-group", "aria-labelledby": "{heading}",
            div { class: "jds-section-head jds-section-head--rule",
                span { class: "jds-section-head__marker", "aria-hidden": "true",
                    span { class: "tk-panel__dot", style: "--tk-swatch: {model::priority_color(group.value)}" }
                }
                h2 { class: "jds-section-head__title", id: "{heading}", "{group.label}" }
                span { class: "jds-section-head__meta", "{count} {noun}" }
            }
            div { class: "tasks-group__rows",
                for task in group.tasks {
                    TaskRow { key: "{task.id}", task, lists, on_changed }
                }
            }
        }
    }
}

#[component]
fn TaskRow(task: Task, lists: Signal<Vec<List>>, on_changed: Callback<Option<u32>>) -> Element {
    let mut done = use_signal(|| task.status == "done");
    let id = task.id.clone();
    let toggle = move |_| {
        let next = !*done.peek();
        let focus = dom::focused_checkbox_index();
        done.set(next);
        let id = id.clone();
        spawn(async move {
            match api::set_done(&id, next).await {
                Ok(()) => on_changed.call(focus),
                Err(_) => done.set(!next),
            }
        });
    };
    let due = model::due_info(&task);
    let chip = model::list_chip(&lists(), &task.list_id);
    let check_label = format!("{} {}", if done() { "Reopen" } else { "Complete" }, task.title);
    let open_label = format!("Open {}", task.title);
    let extra_tags = task.tags.len().saturating_sub(2);
    rsx! {
        div { class: if done() { "tk-task tk-task--done" } else { "tk-task" },
            span { class: "tk-task__bar", style: "--tk-swatch: {model::priority_color(task.priority)}" }
            span { class: "tk-task__check",
                label { class: "jds-check",
                    input { r#type: "checkbox", checked: done(), "aria-label": "{check_label}", onchange: toggle }
                    span { class: "jds-check__box", dangerous_inner_html: icons::check(13) }
                }
            }
            button { r#type: "button", class: "jds-rowbtn tk-task__main", "aria-label": "{open_label}",
                span { class: "tk-task__title", "{task.title}" }
                span { class: "tk-task__meta",
                    if let Some(due) = &due {
                        if due.show_badge {
                            span { class: if due.tone.is_empty() { "tk-meta-due".to_owned() } else { format!("tk-meta-due tk-meta-due--{}", due.tone) },
                                span {
                                    class: "ic",
                                    dangerous_inner_html: if due.tone == "overdue" { icons::alert(12) } else { icons::calendar(12) },
                                }
                                "{due.label}"
                            }
                        }
                        if let Some(kind) = due.drift {
                            span { class: "jds-drift jds-drift--{kind}",
                                span { class: "jds-drift__dot" }
                                if kind == "overdue" { "Overdue" } else { "At risk" }
                            }
                        }
                    }
                    if let Some((name, color)) = chip {
                        span { class: "tk-listchip",
                            span { class: "tk-listchip__dot", style: "--tk-swatch: {color}" }
                            "{name}"
                        }
                    }
                    for tag in task.tags.iter().take(2) {
                        span { class: "tk-metatag", key: "{tag.id}", "#{tag.name}" }
                    }
                    if extra_tags > 0 {
                        span { class: "tk-metatag", "+{extra_tags}" }
                    }
                }
            }
            div { class: "tk-task__right",
                if let Some(effort) = &task.effort {
                    span {
                        class: "tk-effort-fill",
                        title: "{effort} effort",
                        "aria-label": "{effort} effort",
                        dangerous_inner_html: icons::effort(effort),
                    }
                }
                span { class: "tk-task__open",
                    button {
                        r#type: "button",
                        class: "jds-iconbtn jds-iconbtn--sm",
                        "aria-label": "{open_label}",
                        dangerous_inner_html: icons::panel_right(15),
                    }
                }
            }
        }
    }
}
