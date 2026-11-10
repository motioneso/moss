//! Public `prepareTaskAction` API. It builds the approval card for a task action and
//! never grants approval or changes data.
use crate::repository::{Repository, LISTS, TAGS};
use chrono::SecondsFormat;
use moss_module_sdk::{Host, Result as HostResult};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Number, Value};

// Objects keep submitted key order without randomized maps, which need WASI entropy.
#[derive(Debug)]
enum Ordered {
    Null,
    Other,
    Num(Number),
    Str(String),
    List(Vec<Ordered>),
    Object(Vec<(String, Ordered)>),
}
impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = Ordered;
            fn expecting(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str("JSON value")
            }
            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Null)
            }
            fn visit_bool<E>(self, _: bool) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_i64<E>(self, v: i64) -> Result<Ordered, E> {
                Ok(Ordered::Num(v.into()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Ordered, E> {
                Ok(Ordered::Num(v.into()))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Ordered, E> {
                Ok(Number::from_f64(v).map_or(Ordered::Null, Ordered::Num))
            }
            fn visit_str<E>(self, v: &str) -> Result<Ordered, E> {
                Ok(Ordered::Str(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Ordered, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Ordered::List(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut entries: Vec<(String, Ordered)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Ordered>()? {
                    // A repeated key keeps its first position and takes the last value.
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                Ok(Ordered::Object(entries))
            }
        }
        deserializer.deserialize_any(Any)
    }
}

#[derive(Clone, Copy)]
enum Show {
    Text,
    NullText,
    Status,
    NullNumber,
    NullEffort,
    NullRecurrence,
    Steps,
}
struct Action {
    label: &'static str,
    target: &'static str,
    fields: &'static [(&'static str, &'static str, Show)],
    refs: &'static [&'static str],
    required: &'static [&'static str],
}
const TASK_FIELDS: &[(&str, &str, Show)] = &[
    ("title", "Title", Show::Text),
    ("description", "Description", Show::NullText),
    ("status", "Status", Show::Status),
    ("priority", "Priority", Show::NullNumber),
    ("dueAt", "Due at", Show::NullText),
    ("doAt", "Do at", Show::NullText),
    ("effort", "Effort", Show::NullEffort),
    ("recurrence", "Recurrence", Show::NullRecurrence),
];
const NAME: &[(&str, &str, Show)] = &[("name", "Name", Show::Text)];
// Reference key, label and kind. The kind decides which table resolves the id.
const REFERENCES: &[(&str, &str, &str)] = &[
    ("taskId", "Task", "task"),
    ("parentTaskId", "Parent task", "task"),
    ("listId", "List", "list"),
    ("reassignToListId", "Move tasks to list", "list"),
    ("tagId", "Tag", "tag"),
];

fn action(tool: &str) -> Option<(&'static str, Action)> {
    let a = |label, target, fields, refs, required| Action {
        label,
        target,
        fields,
        refs,
        required,
    };
    Some(match tool {
        "tasks.create" => (
            "create",
            a(
                "Create task",
                "Your tasks",
                TASK_FIELDS,
                &["listId", "parentTaskId"],
                &["title"],
            ),
        ),
        "tasks.update" => (
            "update",
            a(
                "Update task",
                "taskId",
                TASK_FIELDS,
                &["taskId", "listId", "parentTaskId"],
                &["taskId"],
            ),
        ),
        "tasks.updateStatus" => (
            "updateStatus",
            a(
                "Change task status",
                "taskId",
                &[("status", "Status", Show::Status)],
                &["taskId"],
                &["taskId", "status"],
            ),
        ),
        "tasks.breakDown" => (
            "breakDown",
            a(
                "Break task into subtasks",
                "taskId",
                &[("steps", "Subtasks", Show::Steps)],
                &["taskId"],
                &["taskId", "steps"],
            ),
        ),
        "tasks.addActivity" => (
            "addActivity",
            a(
                "Add task activity",
                "taskId",
                &[
                    ("activityType", "Activity type", Show::Text),
                    ("body", "Text", Show::NullText),
                ],
                &["taskId"],
                &["taskId"],
            ),
        ),
        "tasks.assignTag" => (
            "assignTag",
            a(
                "Assign task tag",
                "taskId",
                &[],
                &["taskId", "tagId"],
                &["taskId", "tagId"],
            ),
        ),
        "tasks.unassignTag" => (
            "unassignTag",
            a(
                "Remove tag from task",
                "taskId",
                &[],
                &["taskId", "tagId"],
                &["taskId", "tagId"],
            ),
        ),
        "tasks.createList" => (
            "createList",
            a("Create task list", "Your task lists", NAME, &[], &["name"]),
        ),
        "tasks.renameList" => (
            "renameList",
            a(
                "Rename task list",
                "listId",
                NAME,
                &["listId"],
                &["listId", "name"],
            ),
        ),
        "tasks.deleteList" => (
            "deleteList",
            a(
                "Delete task list",
                "listId",
                &[],
                &["listId", "reassignToListId"],
                &["listId"],
            ),
        ),
        "tasks.createTag" => (
            "createTag",
            a(
                "Create task tag",
                "listId",
                NAME,
                &["listId"],
                &["listId", "name"],
            ),
        ),
        "tasks.renameTag" => (
            "renameTag",
            a(
                "Rename task tag",
                "tagId",
                NAME,
                &["listId", "tagId"],
                &["listId", "tagId", "name"],
            ),
        ),
        "tasks.deleteTag" => (
            "deleteTag",
            a(
                "Delete task tag",
                "tagId",
                &[],
                &["listId", "tagId"],
                &["listId", "tagId"],
            ),
        ),
        _ => return None,
    })
}

fn uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}
// Matches JavaScript's String(number) for the values a card can carry.
fn number(n: &Number) -> Option<String> {
    if let Some(i) = n.as_i64() {
        return Some(i.to_string());
    }
    if let Some(u) = n.as_u64() {
        return Some(u.to_string());
    }
    let f = n.as_f64().filter(|f| f.is_finite())?;
    Some(if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    })
}
fn choice(value: &Ordered, choices: &[(&str, &str)]) -> Option<String> {
    match value {
        Ordered::Str(s) => choices
            .iter()
            .find(|(k, _)| k == s)
            .map(|(_, v)| (*v).to_owned()),
        _ => None,
    }
}
fn text(value: &Ordered) -> Option<String> {
    match value {
        Ordered::Str(s) => Some(s.clone()),
        _ => None,
    }
}
const STATUS: &[(&str, &str)] = &[
    ("todo", "To do"),
    ("done", "Done"),
    ("archived", "Archived"),
];
const EFFORT: &[(&str, &str)] = &[("quick", "Quick"), ("medium", "Medium"), ("large", "Large")];
const FREQ: &[(&str, &str)] = &[
    ("daily", "Daily"),
    ("weekly", "Weekly"),
    ("monthly", "Monthly"),
];

type Fields = Vec<(String, String)>;

fn recurrence(value: &Ordered) -> Option<Fields> {
    let Ordered::Object(entries) = value else {
        return None;
    };
    for key in ["freq", "interval", "occurrence_date"] {
        entries.iter().find(|(k, _)| k == key)?;
    }
    let mut out = Vec::new();
    for (key, v) in entries {
        out.push(match key.as_str() {
            "freq" => ("Repeat frequency".to_owned(), choice(v, FREQ)?),
            "interval" => match v {
                Ordered::Num(n) => ("Repeat interval".to_owned(), number(n)?),
                _ => return None,
            },
            "occurrence_date" => ("Occurrence date".to_owned(), text(v)?),
            _ => return None,
        });
    }
    Some(out)
}
fn present(label: &str, show: Show, value: &Ordered) -> Option<Fields> {
    let one = |v: String| Some(vec![(label.to_owned(), v)]);
    if matches!(value, Ordered::Null)
        && matches!(
            show,
            Show::NullText | Show::NullNumber | Show::NullEffort | Show::NullRecurrence
        )
    {
        return one("None".into());
    }
    match show {
        Show::Text | Show::NullText => one(text(value)?),
        Show::Status => one(choice(value, STATUS)?),
        Show::NullEffort => one(choice(value, EFFORT)?),
        Show::NullNumber => match value {
            Ordered::Num(n) => one(number(n)?),
            _ => None,
        },
        Show::NullRecurrence => recurrence(value),
        Show::Steps => {
            let Ordered::List(items) = value else {
                return None;
            };
            if items.is_empty() {
                return one("No subtasks".into());
            }
            items
                .iter()
                .enumerate()
                .map(|(i, item)| Some((format!("Subtask {}", i + 1), text(item)?)))
                .collect()
        }
    }
}

enum Resolved {
    NoParent,
    Row { id: String, label: String },
}
fn json_string(value: &str) -> String {
    Value::String(value.into()).to_string()
}

fn effects(name: &str, has: &dyn Fn(&str) -> bool) -> Vec<(String, String)> {
    let e = |l: &str, v: &str| (l.to_owned(), v.to_owned());
    match name {
        "deleteList" => vec![
            e(
                "Tasks",
                if has("reassignToListId") {
                    "Move all tasks to the selected destination list; the tasks are kept."
                } else {
                    "Only an empty list can be deleted. A list that still contains tasks is left unchanged."
                },
            ),
            e("Tags", "Delete every tag in this list and remove their assignments from tasks."),
            e("Restriction", "Your only remaining task list cannot be deleted."),
        ],
        "deleteTag" => vec![e(
            "Effect",
            "Delete this tag and remove it from every task. The tasks are kept.",
        )],
        "update" if has("listId") => vec![e(
            "Tags",
            "Remove this task's tag assignments that do not belong to the selected destination list.",
        )],
        _ => vec![],
    }
}

/// Returns the card, or `None` when the input cannot be shown in full.
fn prepare_card<H: Host + ?Sized>(
    host: &H,
    tool: &str,
    input: &[(String, Ordered)],
) -> HostResult<Result<Option<Value>, &'static str>> {
    let Some((name, decl)) = action(tool) else {
        return Ok(Err("Unknown Tasks tool"));
    };
    let get = |key: &str| input.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let repo = Repository::new(host);
    let mut resolved: Vec<(&str, &str, Resolved)> = Vec::new();
    let mut versions: Vec<String> = Vec::new();
    for key in decl.refs {
        let Some(value) = get(key) else { continue };
        let (_, ref_label, kind) = *REFERENCES.iter().find(|(k, _, _)| k == key).unwrap();
        if matches!(value, Ordered::Null) && *key == "parentTaskId" {
            resolved.push((key, ref_label, Resolved::NoParent));
            continue;
        }
        let Ordered::Str(id) = value else {
            return Ok(Ok(None));
        };
        if !uuid(id) {
            return Ok(Ok(None));
        }
        let (label, version) = match kind {
            "task" => match repo.task(id).map_err(host_error)? {
                Some(t) => {
                    let v = format!(
                        "{{\"id\":{},\"title\":{},\"updated_at\":{}}}",
                        json_string(&t.id),
                        json_string(&t.title),
                        json_string(&t.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true))
                    );
                    (t.title, v)
                }
                None => return Ok(Ok(None)),
            },
            "list" => match repo
                .first::<crate::rows::List>(
                    LISTS,
                    moss_module_sdk::query::Filter::eq("id", id.as_str()),
                )
                .map_err(host_error)?
            {
                Some(l) => {
                    let v = format!(
                        "{{\"id\":{},\"name\":{}}}",
                        json_string(&l.id),
                        json_string(&l.name)
                    );
                    (l.name, v)
                }
                None => return Ok(Ok(None)),
            },
            _ => {
                let mut filter = moss_module_sdk::query::Filter::eq("id", id.as_str());
                if let Some(Ordered::Str(list)) = get("listId") {
                    filter = crate::repository::and(vec![
                        filter,
                        moss_module_sdk::query::Filter::eq("list_id", list.as_str()),
                    ]);
                }
                match repo
                    .first::<crate::rows::Tag>(TAGS, filter)
                    .map_err(host_error)?
                {
                    Some(t) => {
                        let v = format!(
                            "{{\"id\":{},\"name\":{},\"list_id\":{}}}",
                            json_string(&t.id),
                            json_string(&t.name),
                            json_string(&t.list_id)
                        );
                        (t.name, v)
                    }
                    None => return Ok(Ok(None)),
                }
            }
        };
        if label.is_empty() {
            return Ok(Ok(None));
        }
        versions.push(version);
        resolved.push((
            key,
            ref_label,
            Resolved::Row {
                id: id.clone(),
                label,
            },
        ));
    }
    if decl.required.iter().any(|key| get(key).is_none()) {
        return Ok(Ok(None));
    }
    let mut fields: Fields = Vec::new();
    for (key, value) in input {
        let shown = if let Some((_, label, r)) = resolved.iter().find(|(k, _, _)| k == key) {
            match (r, value) {
                (Resolved::NoParent, Ordered::Null) => {
                    Some(vec![((*label).to_owned(), "None".to_owned())])
                }
                (Resolved::Row { id, label: name }, Ordered::Str(v)) if v == id => {
                    Some(vec![((*label).to_owned(), name.clone())])
                }
                _ => None,
            }
        } else if let Some((_, label, show)) = decl.fields.iter().find(|(k, _, _)| k == key) {
            present(label, *show, value)
        } else {
            None
        };
        let Some(shown) = shown else {
            return Ok(Ok(None));
        };
        fields.extend(shown);
    }
    if fields.iter().any(|(label, _)| label.trim().is_empty()) {
        return Ok(Ok(None));
    }
    fields.extend(effects(name, &|key| get(key).is_some()));
    let target = resolved
        .iter()
        .find(|(k, _, _)| *k == decl.target)
        .and_then(|(_, _, r)| match r {
            Resolved::Row { label, .. } => Some(label.clone()),
            Resolved::NoParent => None,
        })
        .unwrap_or_else(|| decl.target.to_owned());
    Ok(Ok(Some(json!({
        "title": decl.label,
        "content": if versions.is_empty() { "user_authored" } else { "outside" },
        "target": target,
        "fields": fields.iter().map(|(l, v)| json!({"label":l,"value":v})).collect::<Vec<_>>(),
        "version": format!("[{}]", versions.join(","))
    }))))
}
fn host_error(_: crate::repository::Error) -> moss_module_sdk::Error {
    moss_module_sdk::Error::new("Tasks service is unavailable")
}

/// Handles the `prepareTaskAction` API. Known refusals use fixed typed messages.
pub(crate) fn prepare<H: Host + ?Sized>(host: &H, tool: &str, input_json: &str) -> Value {
    let Ok(Ordered::Object(input)) = serde_json::from_str::<Ordered>(input_json) else {
        return json!({"ok":null});
    };
    match prepare_card(host, tool, &input) {
        Ok(Ok(card)) => json!({"ok":card}),
        Ok(Err(message)) => json!({"error":{"statusCode":400,"error":message}}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Tasks service is unavailable"}}),
    }
}

// Route name, tool it maps to, and the path parameters with the input key each fills.
const ROUTES: &[(&str, &str, &[(&str, &str)])] = &[
    ("addActivity", "tasks.addActivity", &[("id", "taskId")]),
    ("assignTag", "tasks.assignTag", &[("id", "taskId")]),
    (
        "unassignTag",
        "tasks.unassignTag",
        &[("id", "taskId"), ("tagId", "tagId")],
    ),
    ("createList", "tasks.createList", &[]),
    ("renameList", "tasks.renameList", &[("listId", "listId")]),
    ("deleteList", "tasks.deleteList", &[("listId", "listId")]),
    ("createTag", "tasks.createTag", &[("listId", "listId")]),
    (
        "renameTag",
        "tasks.renameTag",
        &[("listId", "listId"), ("tagId", "tagId")],
    ),
    (
        "deleteTag",
        "tasks.deleteTag",
        &[("listId", "listId"), ("tagId", "tagId")],
    ),
    ("breakDown", "tasks.breakDown", &[("id", "taskId")]),
];

/// Handles `prepareTaskRoute`. Path parameters join the body as explicit inputs, so a
/// query string, an unknown or missing parameter, or a body key that collides gives no card.
pub(crate) fn prepare_route<H: Host + ?Sized>(
    host: &H,
    route: &str,
    params: &serde_json::Map<String, Value>,
    query: &serde_json::Map<String, Value>,
    body_json: Option<&str>,
) -> Value {
    let Some((_, tool, mapping)) = ROUTES.iter().find(|(name, _, _)| *name == route) else {
        return json!({"error":{"statusCode":400,"error":"Unknown Tasks route"}});
    };
    let none = json!({"ok":null});
    if !query.is_empty() {
        return none;
    }
    let mut input: Vec<(String, Ordered)> = match body_json {
        None => Vec::new(),
        Some(text) => match serde_json::from_str::<Ordered>(text) {
            Ok(Ordered::Object(entries)) => entries,
            _ => return none,
        },
    };
    if params.keys().any(|k| !mapping.iter().any(|(p, _)| p == k)) {
        return none;
    }
    for (param, key) in *mapping {
        let Some(value) = params.get(*param) else {
            return none;
        };
        if input.iter().any(|(k, _)| k == key) {
            return none;
        }
        let Ok(value) = serde_json::from_value::<Ordered>(value.clone()) else {
            return none;
        };
        input.push(((*key).to_owned(), value));
    }
    match prepare_card(host, tool, &input) {
        Ok(Ok(card)) => json!({"ok":card}),
        Ok(Err(message)) => json!({"error":{"statusCode":400,"error":message}}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Tasks service is unavailable"}}),
    }
}

/// Handles `prepareTaskPreferences`: only the default view, shown in words.
pub(crate) fn prepare_preferences(
    params: &serde_json::Map<String, Value>,
    query: &serde_json::Map<String, Value>,
    body_json: &str,
) -> Value {
    let none = json!({"ok":null});
    if !params.is_empty() || !query.is_empty() {
        return none;
    }
    let Ok(Ordered::Object(body)) = serde_json::from_str::<Ordered>(body_json) else {
        return none;
    };
    let [(key, value)] = body.as_slice() else {
        return none;
    };
    if key != "defaultView" {
        return none;
    }
    let Some(shown) = choice(value, &[("priority", "List"), ("matrix", "Grid")]) else {
        return none;
    };
    json!({"ok":{
        "title": "Set task view preference",
        "content": "user_authored",
        "target": "Your task preferences",
        "fields": [{"label":"Default task view","value":shown}],
        "version": "[]"
    }})
}
