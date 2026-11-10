//! Daily chat archive for the linked notes folder. One Markdown file per local day,
//! marked so a later run may replace it and never a person's own file.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

const MARKER: &str = "<!-- moss-chat-archive:v1 -->";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    local_date: String,
    folder: String,
    sessions: Vec<Session>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    thread_id: String,
    title: String,
    /// The caller renders the first message time in the person's own zone and clock style.
    time_label: Option<String>,
    messages: Vec<Message>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    role: Role,
    body: String,
}
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Assistant,
}

fn unavailable() -> Error {
    Error::new("Notes service is unavailable")
}
fn skipped(reason: &str) -> Value {
    json!({"written":false,"path":null,"reason":reason})
}

/// Same rules as the legacy folder check: relative, no `..`, no NUL, not empty.
fn valid_folder(folder: &str) -> bool {
    !folder.trim().is_empty()
        && !folder.contains('\0')
        && !folder.starts_with('/')
        && !folder.split('/').any(|part| part == "..")
}

fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

fn render(sessions: &[Session]) -> String {
    let mut lines: Vec<String> = vec![MARKER.into(), String::new()];
    for session in sessions {
        let time = match (&session.time_label, session.messages.first()) {
            (Some(label), Some(_)) => label.clone(),
            _ => session.thread_id.clone(),
        };
        let title = session.title.trim();
        lines.push(if title.is_empty() {
            format!("## {time}")
        } else {
            format!("## {time} \u{2014} {title}")
        });
        lines.push(String::new());
        for message in &session.messages {
            let role = match message.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            lines.push(format!("**{role}:** {}", message.body));
            lines.push(String::new());
        }
    }
    lines.join("\n")
}

/// A message carries only `role` and `body`; the caller removes `createdAt`.
/// Writes (or refreshes) the day's archive, then requests a sync of the same folder.
pub fn write(host: &impl Host, request: &Request) -> Result<Value> {
    if request.sessions.is_empty() {
        return Ok(skipped("no-sessions"));
    }
    if !valid_folder(&request.folder) || !valid_date(&request.local_date) {
        return Ok(skipped("bad-folder"));
    }
    let root = match host.call("vault", "folder.resolve", "source", json!({})) {
        Ok(v) if v["status"] == 200 => match v["body"].as_str().filter(|s| !s.is_empty()) {
            Some(root) => root.to_owned(),
            None => return Ok(skipped("no-notes-source")),
        },
        Ok(v) if v["status"] == 409 => return Ok(skipped("no-notes-source")),
        _ => return Err(unavailable()),
    };
    let folder = request
        .folder
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/");
    let content = render(&request.sessions);
    // A folder of "." names the notes root, so no directory prefix is added.
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    };
    let candidates = [
        format!("{prefix}{}.md", request.local_date),
        format!("{prefix}{} (moss).md", request.local_date),
    ];
    for path in &candidates {
        let note = host
            .call("vault", "notes.read", "source", json!({"path":path}))
            .map_err(|_| unavailable())?;
        let usable = match &note["content"] {
            Value::Null => true,
            Value::String(text) => text.split('\n').next() == Some(MARKER),
            _ => return Err(unavailable()),
        };
        if !usable {
            continue;
        }
        host.call(
            "vault",
            "notes.compare-write",
            "source",
            json!({
                "path":path,
                "destinationId":note["destinationId"],
                "expected":note["content"],
                "content":content
            }),
        )
        .map_err(|_| unavailable())?;
        crate::sync_worker::request_source(host, &root).map_err(|_| unavailable())?;
        return Ok(json!({"written":true,"path":path}));
    }
    Err(Error::new(format!(
        "Both {} and {} are occupied by files not written by the chat archive",
        candidates[0], candidates[1]
    )))
}
