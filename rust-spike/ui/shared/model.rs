//! Task data, grouping and due-date wording. Written once; both UI candidates use this file.

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub list_id: String,
    pub parent_task_id: Option<String>,
    pub title: String,
    pub status: String,
    pub priority: Option<u8>,
    pub due_at: Option<String>,
    pub effort: Option<String>,
    pub source: String,
    #[serde(default)]
    pub tags: Vec<Tag>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct List {
    pub id: String,
    pub name: String,
}

const LEVELS: [(u8, &str); 5] =
    [(5, "Critical"), (4, "High"), (3, "Medium"), (2, "Low"), (1, "Someday")];

const LIST_COLORS: [&str; 6] = [
    "var(--accent-fg)",
    "var(--steel)",
    "var(--amber)",
    "var(--red)",
    "var(--ink-3)",
    "var(--accent-fg-hover)",
];

pub fn priority_color(value: Option<u8>) -> &'static str {
    match value {
        Some(5) => "var(--priority-urgent)",
        Some(4) => "var(--priority-high)",
        Some(3) => "var(--priority-medium)",
        Some(2) => "var(--priority-low)",
        Some(1) => "var(--priority-minimal)",
        _ => "var(--priority-none)",
    }
}

/// A list's name and its stable dot colour (lists carry no colour of their own).
pub fn list_chip(lists: &[List], list_id: &str) -> Option<(String, &'static str)> {
    let index = lists.iter().position(|list| list.id == list_id)?;
    Some((lists[index].name.clone(), LIST_COLORS[index % LIST_COLORS.len()]))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub value: Option<u8>,
    pub label: &'static str,
    pub tasks: Vec<Task>,
}

fn due_ms(task: &Task) -> f64 {
    task.due_at.as_deref().map_or(f64::MAX, js_sys::Date::parse)
}

fn by_due_then_title(left: &Task, right: &Task) -> std::cmp::Ordering {
    due_ms(left)
        .total_cmp(&due_ms(right))
        .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
}

/// Open top-level tasks grouped 5 to 1 then "No priority"; empty groups are dropped.
pub fn group_by_priority(tasks: &[Task]) -> Vec<Group> {
    let open: Vec<&Task> =
        tasks.iter().filter(|t| t.parent_task_id.is_none() && t.status == "todo").collect();
    let mut groups: Vec<Group> = LEVELS
        .iter()
        .map(|(value, label)| (Some(*value), *label))
        .chain([(None, "No priority")])
        .map(|(value, label)| {
            let mut rows: Vec<Task> =
                open.iter().filter(|t| t.priority == value).map(|t| (*t).clone()).collect();
            rows.sort_by(by_due_then_title);
            Group { value, label, tasks: rows }
        })
        .collect();
    groups.retain(|group| !group.tasks.is_empty());
    groups
}

pub fn open_count(tasks: &[Task]) -> usize {
    tasks.iter().filter(|t| t.parent_task_id.is_none() && t.status == "todo").count()
}

pub struct Due {
    pub label: String,
    /// "", "overdue" or "today".
    pub tone: &'static str,
    /// "atrisk" or "overdue" when the urgency pill shows.
    pub drift: Option<&'static str>,
    pub show_badge: bool,
}

fn day_key(ms: f64) -> String {
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ms));
    format!("{:04}-{:02}-{:02}", date.get_full_year(), date.get_month() + 1, date.get_date())
}

/// The due badge and urgency pill for a task, bucketed by local calendar day.
pub fn due_info(task: &Task) -> Option<Due> {
    let due_ms = js_sys::Date::parse(task.due_at.as_deref()?);
    let today_key = day_key(js_sys::Date::now());
    let due_key = day_key(due_ms);
    let done = task.status == "done";
    if due_key < today_key {
        let drift = if done { None } else { Some("overdue") };
        return Some(Due { label: "Overdue".into(), tone: "overdue", drift, show_badge: done });
    }
    if due_key == today_key {
        return Some(Due { label: "Today".into(), tone: "today", drift: None, show_badge: true });
    }
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(due_ms));
    let label = format!("{} {}", MONTHS[date.get_month() as usize], date.get_date());
    let days = (js_sys::Date::parse(&format!("{due_key}T00:00:00Z"))
        - js_sys::Date::parse(&format!("{today_key}T00:00:00Z")))
        / 86_400_000.0;
    let drift = if !done && days <= 2.0 { Some("atrisk") } else { None };
    Some(Due { label, tone: "", drift, show_badge: true })
}

/// Open top-level tasks in one list, or in all lists when `list_id` is None.
pub fn list_count(tasks: &[Task], list_id: Option<&str>) -> usize {
    tasks
        .iter()
        .filter(|t| t.parent_task_id.is_none() && t.status == "todo")
        .filter(|t| list_id.is_none_or(|id| t.list_id == id))
        .count()
}
