//! Concurrency regression: a held invocation mutex stands in for a stalled filesystem call.
use super::*;
use crate::runtime::{DenyPorts, Host, Limits};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

struct Folders(BTreeMap<Uuid, PathBuf>);
impl FolderProvider for Folders {
    fn resolve(
        &self,
        access: &AccessContext,
        _: &str,
        _: &str,
        _: Duration,
    ) -> Result<LinkedFolder> {
        let path = &self.0[&access.actor_user_id()];
        LinkedFolder::open(
            access,
            path,
            &AllowedRoots::for_account(access, vec![path.clone()]),
        )
    }
}
struct HoldInvocation {
    notes: Arc<LinkedNotesPorts>,
    actor: Uuid,
    held: SyncSender<()>,
    release: Mutex<Receiver<()>>,
}
impl Ports for HoldInvocation {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let result = self.notes.invoke(scope, port, request)?;
        if scope.access().actor_user_id() == self.actor {
            let pending = self.notes.calls.lock().unwrap()[&scope.call_id()].clone();
            let _io = pending.lock().unwrap();
            self.held.send(())?;
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))?;
        }
        Ok(result)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.notes.finish_call(scope, success)
    }
}

#[test]
fn another_account_finishes_while_one_invocation_holds_its_state_mutex() {
    let temp = tempfile::tempdir().unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let paths = BTreeMap::from([(a, temp.path().join("a")), (b, temp.path().join("b"))]);
    for path in paths.values() {
        std::fs::create_dir(path).unwrap();
        std::fs::write(path.join("note.md"), "private note").unwrap();
    }
    let notes = Arc::new(LinkedNotesPorts::new(
        Arc::new(Folders(paths)),
        Arc::new(DenyPorts),
    ));
    let (held, waiting) = sync_channel(1);
    let (release, resume) = sync_channel(1);
    let ports: Arc<dyn Ports> = Arc::new(HoldInvocation {
        notes: notes.clone(),
        actor: a,
        held,
        release: Mutex::new(resume),
    });
    let manifest: Arc<crate::manifest::Manifest> = Arc::new(serde_json::from_value(json!({
        "schemaVersion":2,"id":"notes","name":"Notes","description":"Notes concurrency fixture",
        "publisher":"Moss","version":"0.1.0","requiresMoss":">=0.1.0","abi":"moss:module@1",
        "capabilities":[{"port":"vault","operations":["notes.read"],"resources":["linked-notes"]}],
        "icons":[],"accounts":{"supportsUserDisable":true,"defaultEnabled":true}
    })).unwrap());
    let wasm = Arc::new(
        wat::parse_str(
            include_str!("../sample/module.wat")
                .replace("moss:module/kv@1.0.0", "moss:module/vault@1.0.0"),
        )
        .unwrap(),
    );
    let host = Arc::new(Host::new(Limits::default()).unwrap());
    let call = {
        let host = host.clone();
        let wasm = wasm.clone();
        let manifest = manifest.clone();
        move |actor, ports| {
            host.call(&wasm, manifest.clone(), AccessContext::new(actor, "same-request-id"), ports, "route", &json!({"operation":"notes.read","resource":"linked-notes","parameters":{"path":"note.md"}}).to_string())
        }
    };
    let first = {
        let call = call.clone();
        let ports = ports.clone();
        std::thread::spawn(move || call(a, ports))
    };
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    let (done, finished) = sync_channel(1);
    let second = std::thread::spawn(move || {
        done.send(call(b, ports)).unwrap();
    });
    let result = finished.recv_timeout(Duration::from_secs(2));
    // Release and join on both the passing and failing paths.
    release.send(()).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &result
                .expect("another account waited on an unrelated invocation")
                .unwrap()
        )
        .unwrap()["content"],
        "private note"
    );
    assert!(
        notes.calls.lock().unwrap().is_empty(),
        "both invocation states must be finalized"
    );
}
