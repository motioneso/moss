//! Real Notes component and guarded linked files. Queue acknowledgements are a stand-in;
//! these checks do not prove installed chat, approval consumption or memory ingestion.
use access_context::AccessContext;
use anyhow::{bail, Result};
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    context::ContextPorts,
    linked_notes::{FolderProvider, LinkedFolder, LinkedNotesPorts},
    manifest::Manifest,
    runtime::{CallScope, Host, Limits, Ports, Request},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;
use vault::AllowedRoots;

struct Folders {
    paths: BTreeMap<Uuid, PathBuf>,
    wrong_actor: Option<Uuid>,
}
impl FolderProvider for Folders {
    fn resolve(
        &self,
        access: &AccessContext,
        _: &str,
        _: &str,
        _: std::time::Duration,
    ) -> Result<LinkedFolder> {
        let actor = self.wrong_actor.unwrap_or(access.actor_user_id());
        let owner = AccessContext::new(actor, "notes-tools-provider");
        let path = &self.paths[&actor];
        LinkedFolder::open(
            &owner,
            path,
            &AllowedRoots::for_account(&owner, vec![path.clone()]),
        )
    }
}
struct Services {
    paths: BTreeMap<Uuid, PathBuf>,
    published: Mutex<Vec<(Uuid, Value)>>,
    checkpoints: Mutex<Vec<(Uuid, Value)>>,
    fail_publication: AtomicBool,
}
impl Ports for Services {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        match (port, r.operation.as_str()) {
            ("vault", "folder.resolve") => {
                Ok(json!({"status":200,"body":self.paths[&scope.access().actor_user_id()]}))
            }
            ("db", "query") => {
                // Explicit database boundary stand-in. Real transaction and RLS
                // coverage lives in the disposable ingest gate.
                assert_eq!(r.resource, "app.notes_sync_checkpoints");
                assert_eq!(r.parameters["kind"], "insert");
                assert_eq!(
                    r.parameters["values"]["checkpoint"],
                    json!({"sourcePath":self.paths[&scope.access().actor_user_id()]})
                );
                let row = r.parameters["values"].clone();
                self.checkpoints
                    .lock()
                    .unwrap()
                    .push((scope.access().actor_user_id(), row.clone()));
                Ok(json!([row]))
            }
            ("jobs", "enqueue-options") => {
                if self.fail_publication.load(Ordering::Relaxed) {
                    bail!("Synthetic publication failure")
                }
                assert_eq!(r.resource, "notes.sync");
                let id = &r.parameters["params"]["checkpoint-id"];
                assert!(Uuid::parse_str(id.as_str().unwrap()).is_ok());
                assert_eq!(r.parameters["params"].as_object().unwrap().len(), 1);
                assert_eq!(&r.parameters["idempotencyKey"], id);
                assert!(self
                    .checkpoints
                    .lock()
                    .unwrap()
                    .iter()
                    .any(
                        |(actor, row)| *actor == scope.access().actor_user_id() && &row["id"] == id
                    ));
                assert_eq!(r.parameters.as_object().unwrap().len(), 3);
                self.published
                    .lock()
                    .unwrap()
                    .push((scope.access().actor_user_id(), r.parameters.clone()));
                Ok(json!({"id":Uuid::new_v4()}))
            }
            _ => bail!("Unexpected fixture service"),
        }
    }
}
struct RejectEnqueue {
    next: Arc<dyn Ports>,
    fail: bool,
}
impl Ports for RejectEnqueue {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if self.fail && port == "jobs" {
            bail!("Synthetic queue refusal")
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    wasm: Vec<u8>,
    manifest: Arc<Manifest>,
    host: Host,
    a: Uuid,
    b: Uuid,
    services: Arc<Services>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let paths: BTreeMap<_, _> = [a, b]
            .into_iter()
            .map(|actor| {
                let path = temp.path().join(actor.to_string());
                std::fs::create_dir(&path).unwrap();
                (actor, path)
            })
            .collect();
        // The shipped manifest alone grants every tool, sync and job permission.
        let manifest = moss_notes_checks::manifest().unwrap();
        Self {
            _temp: temp,
            wasm: std::fs::read(std::env::var_os("NOTES_TOOL_COMPONENT").unwrap()).unwrap(),
            manifest: Arc::new(manifest),
            host: Host::new(Limits::default()).unwrap(),
            a,
            b,
            services: Arc::new(Services {
                paths,
                published: Mutex::new(vec![]),
                checkpoints: Mutex::new(vec![]),
                fail_publication: AtomicBool::new(false),
            }),
        }
    }
    fn ports(&self, wrong_actor: Option<Uuid>, reject: bool) -> Arc<dyn Ports> {
        let files = Arc::new(LinkedNotesPorts::new(
            Arc::new(Folders {
                paths: self.services.paths.clone(),
                wrong_actor,
            }),
            self.services.clone(),
        ));
        Arc::new(ContextPorts::new(Arc::new(RejectEnqueue {
            fail: reject,
            next: Arc::new(AfterCommitJobs::new(files)),
        })))
    }
    fn call(
        &self,
        actor: Uuid,
        ports: Arc<dyn Ports>,
        tool: &str,
        parameters: Value,
    ) -> Result<Value> {
        let out = self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "notes-tools-check"),
            ports,
            "tool",
            &json!({"tool":tool,"parameters":parameters}).to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
    fn text(&self, actor: Uuid, path: &str) -> Option<String> {
        std::fs::read_to_string(self.services.paths[&actor].join(path)).ok()
    }
}
#[test]
fn compiled_guest_writes_edits_deletes_and_defers_metadata_only_sync() {
    let f = Fixture::new();
    let path = "Journal/day.md";
    assert_eq!(
        f.call(
            f.a,
            f.ports(None, false),
            "notes.create",
            json!({"path":path,"content":"before old after"})
        )
        .unwrap(),
        json!({"data":{"path":path,"synced":true}})
    );
    assert_eq!(f.text(f.a, path).as_deref(), Some("before old after"));
    assert!(f
        .call(
            f.a,
            f.ports(None, false),
            "notes.create",
            json!({"path":path,"content":"clobber"})
        )
        .is_err());
    assert_eq!(f.text(f.a, path).as_deref(), Some("before old after"));
    f.call(
        f.a,
        f.ports(None, false),
        "notes.edit",
        json!({"path":path,"oldText":"old","newText":"$&$$"}),
    )
    .unwrap();
    assert_eq!(f.text(f.a, path).as_deref(), Some("before old$ after"));
    f.call(
        f.a,
        f.ports(None, false),
        "notes.create",
        json!({"path":path,"content":"replace","overwrite":true}),
    )
    .unwrap();
    f.call(
        f.a,
        f.ports(None, false),
        "notes.delete",
        json!({"path":path}),
    )
    .unwrap();
    assert_eq!(f.text(f.a, path), None);
    let syncs = f.services.published.lock().unwrap();
    assert_eq!(syncs.len(), 4);
    assert!(syncs.iter().all(|(actor, _)| *actor == f.a));
    let ids: std::collections::BTreeSet<_> = syncs
        .iter()
        .map(|(_, v)| v["idempotencyKey"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 4);
}
#[test]
fn compiled_guest_queue_refusal_before_finalization_restores_file_changes() {
    let f = Fixture::new();
    let path = f.services.paths[&f.a].join("keep.md");
    std::fs::write(&path, "private old").unwrap();
    for (tool, input) in [
        ("notes.create", json!({"path":"new.md","content":"new"})),
        (
            "notes.create",
            json!({"path":"keep.md","content":"replace","overwrite":true}),
        ),
        (
            "notes.edit",
            json!({"path":"keep.md","oldText":"old","newText":"new"}),
        ),
        ("notes.delete", json!({"path":"keep.md"})),
    ] {
        assert!(f.call(f.a, f.ports(None, true), tool, input).is_err());
        assert_eq!(f.text(f.a, "keep.md").as_deref(), Some("private old"));
        assert_eq!(f.text(f.a, "new.md"), None);
    }
    assert!(f.services.published.lock().unwrap().is_empty());
}
#[test]
fn compiled_guest_publication_failure_after_finalization_leaves_file_saved() {
    let f = Fixture::new();
    f.services.fail_publication.store(true, Ordering::Relaxed);
    assert!(f
        .call(
            f.a,
            f.ports(None, false),
            "notes.create",
            json!({"path":"saved.md","content":"saved despite queue failure"}),
        )
        .is_err());
    assert_eq!(
        f.text(f.a, "saved.md").as_deref(),
        Some("saved despite queue failure")
    );
    assert!(f.services.published.lock().unwrap().is_empty());
}
#[test]
fn compiled_guest_cannot_read_or_mutate_another_owners_folder() {
    let f = Fixture::new();
    std::fs::write(f.services.paths[&f.a].join("keep.md"), "private old").unwrap();
    for (tool, input) in [
        ("notes.create", json!({"path":"new.md","content":"new"})),
        (
            "notes.create",
            json!({"path":"keep.md","content":"replace","overwrite":true}),
        ),
        (
            "notes.edit",
            json!({"path":"keep.md","oldText":"old","newText":"new"}),
        ),
        ("notes.delete", json!({"path":"keep.md"})),
    ] {
        assert!(f.call(f.b, f.ports(Some(f.a), false), tool, input).is_err());
        assert_eq!(f.text(f.a, "keep.md").as_deref(), Some("private old"));
        assert_eq!(f.text(f.a, "new.md"), None);
    }
    assert!(f.services.published.lock().unwrap().is_empty());
}

#[test]
fn shipped_manifest_offers_four_tools_and_the_read_only_build_offers_none_of_the_writes() {
    let f = Fixture::new();
    let shipped = moss_notes_checks::manifest().unwrap();
    assert_eq!(shipped.tools.len(), 4);
    assert_eq!(shipped.tools["notes.search"].risk, "read");
    assert_eq!(shipped.tools["notes.create"].risk, "write");
    assert_eq!(shipped.tools["notes.edit"].risk, "write");
    assert_eq!(shipped.tools["notes.delete"].risk, "destructive");
    for name in ["notes.create", "notes.edit", "notes.delete"] {
        assert!(shipped.tools[name].approval_version, "{name} binds approval to the shown version");
    }
    assert!(shipped.jobs.contains_key("notes.sync"));
    assert!(shipped.routes.iter().any(|r| r.method == "POST" && r.path == "/notes/sync" && r.sign_in));
    f.host.validate(&f.wasm, &Arc::new(shipped)).unwrap();
    let read_only = moss_notes_checks::read_only_manifest().unwrap();
    assert_eq!(read_only.tools.len(), 1);
    assert!(read_only.jobs.is_empty());
    assert!(
        f.host.validate(&f.wasm, &read_only).is_err(),
        "The read-only manifest must not admit the write-capable component"
    );
}
