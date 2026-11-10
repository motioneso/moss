use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Vault {
    files: RefCell<BTreeMap<String, String>>,
    linked: bool,
    jobs: RefCell<u32>,
}
impl Host for Vault {
    fn call(&self, port: &str, operation: &str, resource: &str, query: Value) -> Result<Value> {
        match (port, operation) {
            ("vault", "folder.resolve") => Ok(if self.linked {
                json!({"status":200,"body":"/notes"})
            } else {
                json!({"status":409,"body":{"error":"Notes source is not configured"}})
            }),
            ("vault", "notes.read") => {
                let path = query["path"].as_str().unwrap();
                Ok(json!({"path":path,"destinationId":"d","content":self.files.borrow().get(path)}))
            }
            ("vault", "notes.compare-write") => {
                assert_eq!(resource, "source");
                let path = query["path"].as_str().unwrap().to_owned();
                let current = self.files.borrow().get(&path).cloned();
                if query["expected"] != json!(current) {
                    return Err(Error::new("changed"));
                }
                self.files
                    .borrow_mut()
                    .insert(path, query["content"].as_str().unwrap().into());
                Ok(json!({"saved":true}))
            }
            ("db", "query") => {
                assert_eq!(query["values"]["checkpoint"], json!({"sourcePath":"/notes"}));
                Ok(json!([query["values"]]))
            }
            ("jobs", "enqueue-after-commit") => {
                *self.jobs.borrow_mut() += 1;
                Ok(json!({"deferred":true}))
            }
            ("context", "read") => Ok(json!({"now":"2026-11-08T12:00:00.000Z"})),
            ("context", "uuid") => Ok(json!({"id":"00000000-0000-4000-8000-000000000001"})),
            _ => Err(Error::new("unexpected")),
        }
    }
}

fn vault() -> Vault {
    Vault { linked: true, ..Default::default() }
}
fn session(title: &str, label: Option<&str>, body: &str) -> Value {
    json!({"threadId":"t1","title":title,"timeLabel":label,
      "messages":[{"role":"user","body":body},{"role":"assistant","body":"ok"}]})
}
fn run(host: &Vault, folder: &str, sessions: Vec<Value>) -> Result<Value> {
    let payload = json!({"name":"writeDailyChatArchive","parameters":{
        "localDate":"2026-08-25","folder":folder,"sessions":sessions}});
    handle(host, "api", &payload.to_string()).map(|s| serde_json::from_str(&s).unwrap())
}

#[test]
fn writes_marker_headings_and_messages_in_order() {
    let host = vault();
    let out = run(&host, "Moss/Chats", vec![session("Trip", Some("9:00 AM"), "hello")]).unwrap();
    assert_eq!(out, json!({"written":true,"path":"Moss/Chats/2026-08-25.md"}));
    assert_eq!(*host.jobs.borrow(), 1, "a write requests one sync");
    let text = host.files.borrow()["Moss/Chats/2026-08-25.md"].clone();
    assert_eq!(
        text,
        "<!-- moss-chat-archive:v1 -->\n\n## 9:00 AM \u{2014} Trip\n\n**user:** hello\n\n**assistant:** ok\n"
    );
}

#[test]
fn heading_drops_blank_title_and_falls_back_to_thread_id() {
    let host = vault();
    run(&host, "A", vec![session("   ", Some("9:00 AM"), "x"), session("T", None, "y")]).unwrap();
    let text = host.files.borrow()["A/2026-08-25.md"].clone();
    assert!(text.contains("## 9:00 AM\n"));
    assert!(text.contains("## t1 \u{2014} T\n"));
}

#[test]
fn marked_file_is_replaced_and_foreign_file_is_kept() {
    let host = vault();
    host.files.borrow_mut().insert(
        "A/2026-08-25.md".into(),
        "<!-- moss-chat-archive:v1 -->\nold".into(),
    );
    let out = run(&host, "A", vec![session("T", Some("1"), "fresh")]).unwrap();
    assert_eq!(out["path"], "A/2026-08-25.md");
    assert!(!host.files.borrow()["A/2026-08-25.md"].contains("old"));

    let host = vault();
    host.files.borrow_mut().insert("A/2026-08-25.md".into(), "# mine".into());
    let out = run(&host, "A", vec![session("T", Some("1"), "fresh")]).unwrap();
    assert_eq!(out["path"], "A/2026-08-25 (moss).md");
    assert_eq!(host.files.borrow()["A/2026-08-25.md"], "# mine");
}

#[test]
fn both_names_taken_by_foreign_files_is_an_error_and_nothing_changes() {
    let host = vault();
    host.files.borrow_mut().insert("A/2026-08-25.md".into(), "mine".into());
    host.files.borrow_mut().insert("A/2026-08-25 (moss).md".into(), "mine too".into());
    assert!(run(&host, "A", vec![session("T", Some("1"), "x")]).is_err());
    assert_eq!(host.files.borrow()["A/2026-08-25.md"], "mine");
    assert_eq!(host.files.borrow()["A/2026-08-25 (moss).md"], "mine too");
    assert_eq!(*host.jobs.borrow(), 0);
}

#[test]
fn refusals_write_nothing() {
    let host = vault();
    assert_eq!(run(&host, "A", vec![]).unwrap()["reason"], "no-sessions");
    for folder in ["/etc", "../x", "a/../b", "  ", "a\u{0}b"] {
        assert_eq!(
            run(&host, folder, vec![session("T", Some("1"), "x")]).unwrap()["reason"],
            "bad-folder",
            "{folder:?}"
        );
    }
    let unlinked = Vault { linked: false, ..Default::default() };
    assert_eq!(
        run(&unlinked, "A", vec![session("T", Some("1"), "x")]).unwrap()["reason"],
        "no-notes-source"
    );
    assert!(host.files.borrow().is_empty() && unlinked.files.borrow().is_empty());
    assert_eq!(*host.jobs.borrow() + *unlinked.jobs.borrow(), 0);
}

#[test]
fn unknown_fields_are_refused() {
    let host = vault();
    let payload = json!({"name":"writeDailyChatArchive","parameters":{
        "localDate":"2026-08-25","folder":"A","sessions":[],"path":"../x"}});
    assert!(handle(&host, "api", &payload.to_string()).is_err());
}

#[test]
fn dot_folder_writes_at_the_notes_root() {
    let host = vault();
    for folder in [".", "./", "./."] {
        let out = run(&host, folder, vec![session("T", Some("1"), "x")]).unwrap();
        assert_eq!(out["path"], "2026-08-25.md", "{folder:?}");
    }
    assert!(host.files.borrow().keys().all(|path| !path.starts_with('/')));
}
