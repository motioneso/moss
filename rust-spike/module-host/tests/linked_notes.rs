mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    linked_notes::{FolderProvider, LinkedFolder, LinkedNotesPorts},
    manifest::Manifest,
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use uuid::Uuid;
use vault::{AllowedRoots, VaultContext};

struct Folders {
    folders: BTreeMap<Uuid, PathBuf>,
    // Deliberately bad trusted wiring exercises the adapter's independent account check.
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
        let owner = AccessContext::new(actor, "folder-provider");
        let path = &self.folders[&actor];
        LinkedFolder::open(
            &owner,
            path,
            &AllowedRoots::for_account(&owner, vec![path.clone()]),
        )
    }
}
fn manifest() -> Arc<Manifest> {
    let mut m = common::manifest("1.0.0");
    m.capabilities = serde_json::from_value(json!([{
        "port":"vault", "operations":["notes.read","notes.list","notes.compare-write","notes.remove"],
        "resources":["linked-notes"]
    }])).unwrap();
    Arc::new(m)
}
fn wasm(mode: &str) -> Vec<u8> {
    let mut source = include_str!("../sample/module.wat")
        .replace("moss:module/kv@1.0.0", "moss:module/vault@1.0.0");
    if mode == "trap" {
        source = source.replace("i32.const 32 call $kv", "i32.const 32 call $kv unreachable");
    } else if mode == "twice" {
        source = source.replace(
            "i32.const 32 call $kv",
            "i32.const 32 call $kv local.get $payload local.get $length i32.const 32 call $kv",
        );
    }
    wat::parse_str(source).unwrap()
}
struct Fixture {
    _temp: tempfile::TempDir,
    host: Host,
    a: Uuid,
    b: Uuid,
    paths: BTreeMap<Uuid, PathBuf>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let paths = BTreeMap::from([(a, temp.path().join("a")), (b, temp.path().join("b"))]);
        for path in paths.values() {
            std::fs::create_dir(path).unwrap();
        }
        let f = Self {
            _temp: temp,
            host: Host::new(Limits::default()).unwrap(),
            a,
            b,
            paths,
        };
        f.vault(a).write("private.md", b"A private note").unwrap();
        f.vault(b).write("private.md", b"B private note").unwrap();
        f
    }
    fn vault(&self, actor: Uuid) -> VaultContext {
        let access = AccessContext::new(actor, "observer");
        let path = &self.paths[&actor];
        VaultContext::at_allowed_root(
            &access,
            path,
            &AllowedRoots::for_account(&access, vec![path.clone()]),
        )
        .unwrap()
    }
    fn ports(&self, wrong_actor: Option<Uuid>, next: Arc<dyn Ports>) -> Arc<dyn Ports> {
        Arc::new(LinkedNotesPorts::new(
            Arc::new(Folders {
                folders: self.paths.clone(),
                wrong_actor,
            }),
            next,
        ))
    }
    fn call(
        &self,
        actor: Uuid,
        ports: Arc<dyn Ports>,
        mode: &str,
        operation: &str,
        mut parameters: Value,
    ) -> Result<Value> {
        if matches!(operation, "notes.compare-write" | "notes.remove")
            && parameters.get("destinationId").is_none()
        {
            let current = self.call(
                actor,
                self.ports(None, Arc::new(DenyPorts)),
                "ok",
                "notes.read",
                json!({"path":parameters["path"]}),
            )?;
            parameters["destinationId"] = current["destinationId"].clone();
        }
        let result = self.host.call(
            &wasm(mode),
            manifest(),
            AccessContext::new(actor, "notes-test"),
            ports,
            "route",
            &json!({"operation":operation,"resource":"linked-notes","parameters":parameters})
                .to_string(),
        )?;
        Ok(serde_json::from_str(&result)?)
    }
}
#[test]
fn account_reads_and_mutations_use_the_actors_chosen_folder() {
    let f = Fixture::new();
    let ports = f.ports(None, Arc::new(DenyPorts));
    assert_eq!(
        f.call(
            f.a,
            ports.clone(),
            "ok",
            "notes.read",
            json!({"path":"private.md"})
        )
        .unwrap()["content"],
        "A private note"
    );
    assert_eq!(
        f.call(
            f.b,
            ports.clone(),
            "ok",
            "notes.read",
            json!({"path":"private.md"})
        )
        .unwrap()["content"],
        "B private note"
    );
    f.call(
        f.b,
        ports.clone(),
        "ok",
        "notes.compare-write",
        json!({"path":"private.md","expected":"B private note","content":"B changed"}),
    )
    .unwrap();
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"A private note");
    assert_eq!(f.vault(f.b).read("private.md").unwrap(), b"B changed");
    f.call(
        f.b,
        ports,
        "ok",
        "notes.remove",
        json!({"path":"private.md","expected":"B changed"}),
    )
    .unwrap();
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"A private note");
    assert!(f.vault(f.b).read("private.md").is_err());
}
#[test]
fn a_folder_resolved_for_another_account_cannot_be_read() {
    let f = Fixture::new();
    assert!(f
        .call(
            f.b,
            f.ports(Some(f.a), Arc::new(DenyPorts)),
            "ok",
            "notes.read",
            json!({"path":"private.md"})
        )
        .is_err());
}
#[test]
fn a_folder_resolved_for_another_account_cannot_be_changed() {
    let f = Fixture::new();
    let ports = f.ports(Some(f.a), Arc::new(DenyPorts));
    let destination = f
        .call(
            f.a,
            f.ports(None, Arc::new(DenyPorts)),
            "ok",
            "notes.read",
            json!({"path":"private.md"}),
        )
        .unwrap()["destinationId"]
        .clone();
    assert!(f
        .call(
            f.b,
            ports.clone(),
            "ok",
            "notes.compare-write",
            json!({"path":"private.md","expected":"A private note","content":"stolen","destinationId":destination})
        )
        .is_err());
    assert!(f
        .call(
            f.b,
            ports,
            "ok",
            "notes.remove",
            json!({"path":"private.md","expected":"A private note","destinationId":destination})
        )
        .is_err());
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"A private note");
}
#[test]
fn stale_content_refuses_write_and_delete() {
    let f = Fixture::new();
    let ports = f.ports(None, Arc::new(DenyPorts));
    for op in ["notes.compare-write", "notes.remove"] {
        assert!(f
            .call(
                f.a,
                ports.clone(),
                "ok",
                op,
                json!({"path":"private.md","expected":"stale","content":"lost edit"})
            )
            .is_err());
        assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"A private note");
    }
}
#[test]
fn traps_and_guest_errors_restore_existing_and_new_files_and_release_locks() {
    let f = Fixture::new();
    let ports = f.ports(None, Arc::new(DenyPorts));
    for mode in ["trap", "twice"] {
        for (path, expected) in [
            ("private.md", Some("A private note")),
            ("Nested/new.md", None),
        ] {
            assert!(f
                .call(
                    f.a,
                    ports.clone(),
                    mode,
                    "notes.compare-write",
                    json!({"path":path,"expected":expected,"content":"pending"})
                )
                .is_err());
            assert_eq!(
                f.vault(f.a)
                    .current_text(path, 256 * 1024)
                    .unwrap()
                    .as_deref(),
                expected
            );
        }
    }
    f.call(
        f.a,
        ports,
        "ok",
        "notes.compare-write",
        json!({"path":"private.md","expected":"A private note","content":"committed"}),
    )
    .unwrap();
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"committed");
}
struct Editor(VaultContext);
impl Ports for Editor {
    fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> Result<Value> {
        unreachable!()
    }
    fn finish_call(&self, _: &CallScope, _: bool) -> Result<()> {
        self.0.write("private.md", b"external edit")?;
        Ok(())
    }
}
#[test]
fn rollback_preserves_an_external_edit() {
    let f = Fixture::new();
    let ports = f.ports(None, Arc::new(Editor(f.vault(f.a))));
    assert!(f
        .call(
            f.a,
            ports,
            "trap",
            "notes.compare-write",
            json!({"path":"private.md","expected":"A private note","content":"pending"})
        )
        .is_err());
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"external edit");
}
#[test]
fn paths_and_parameters_cannot_select_another_root_or_account() {
    let f = Fixture::new();
    let ports = f.ports(None, Arc::new(DenyPorts));
    for path in [
        "../a/private.md",
        "/private.md",
        "./private.md",
        "nested//file.md",
        "private.txt",
    ] {
        assert!(f
            .call(f.b, ports.clone(), "ok", "notes.read", json!({"path":path}))
            .is_err());
    }
    assert!(f
        .call(
            f.b,
            ports.clone(),
            "ok",
            "notes.read",
            json!({"path":"private.md","root":f.paths[&f.a]})
        )
        .is_err());
    assert!(f
        .call(
            f.b,
            ports,
            "ok",
            "notes.read",
            json!({"path":"private.md","actorUserId":f.a})
        )
        .is_err());
}
#[cfg(unix)]
#[test]
fn symlink_cannot_read_or_overwrite_another_accounts_note() {
    let f = Fixture::new();
    let destination = f
        .call(
            f.a,
            f.ports(None, Arc::new(DenyPorts)),
            "ok",
            "notes.read",
            json!({"path":"private.md"}),
        )
        .unwrap()["destinationId"]
        .clone();
    std::os::unix::fs::symlink(
        f.paths[&f.a].join("private.md"),
        f.paths[&f.b].join("link.md"),
    )
    .unwrap();
    let ports = f.ports(None, Arc::new(DenyPorts));
    assert!(f
        .call(
            f.b,
            ports.clone(),
            "ok",
            "notes.read",
            json!({"path":"link.md"})
        )
        .is_err());
    assert!(f
        .call(
            f.b,
            ports,
            "ok",
            "notes.compare-write",
            json!({"path":"link.md","expected":"A private note","content":"stolen","destinationId":destination})
        )
        .is_err());
    assert_eq!(f.vault(f.a).read("private.md").unwrap(), b"A private note");
}

#[test]
fn relinked_folder_refuses_an_old_destination_even_with_identical_text() {
    let f = Fixture::new();
    let original = f
        .call(
            f.a,
            f.ports(None, Arc::new(DenyPorts)),
            "ok",
            "notes.read",
            json!({"path":"private.md"}),
        )
        .unwrap();
    f.vault(f.b).write("private.md", b"A private note").unwrap();
    let mut folders = f.paths.clone();
    folders.insert(f.a, f.paths[&f.b].clone());
    let ports = Arc::new(LinkedNotesPorts::new(
        Arc::new(Folders {
            folders,
            wrong_actor: None,
        }),
        Arc::new(DenyPorts),
    ));
    for operation in ["notes.compare-write", "notes.remove"] {
        assert!(f.call(f.a,ports.clone(),"ok",operation,json!({"path":"private.md","expected":"A private note","content":"wrong destination","destinationId":original["destinationId"]})).is_err());
        assert_eq!(f.vault(f.b).read("private.md").unwrap(), b"A private note");
    }
}
