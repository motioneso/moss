use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Vault {
    files: RefCell<BTreeMap<String, String>>,
    calls: RefCell<Vec<(String, String, String)>>,
}
impl Host for Vault {
    fn call(&self, port: &str, operation: &str, resource: &str, query: Value) -> Result<Value> {
        self.calls
            .borrow_mut()
            .push((port.into(), operation.into(), resource.into()));
        assert_eq!((port, resource), ("vault", "private-export"));
        let path = query["path"].as_str().unwrap().to_owned();
        match operation {
            "notes.read" => Ok(json!({
                "path":path,"destinationId":"d",
                "content":self.files.borrow().get(&path)
            })),
            "notes.compare-write" => {
                assert!(query["expected"].is_null(), "only create-if-absent is allowed");
                let mut files = self.files.borrow_mut();
                if files.contains_key(&path) {
                    return Err(Error::new("changed"));
                }
                files.insert(path, query["content"].as_str().unwrap().into());
                Ok(json!({"saved":true}))
            }
            _ => Err(Error::new("unexpected")),
        }
    }
}
const ID: &str = "0F8FAD5B-D9CB-469F-A165-70867728950E";
fn api(host: &Vault, name: &str, version: u64, content: &str) -> Result<Value> {
    let payload = json!({"name":name,"parameters":{"sourceId":ID,"version":version,"content":content}});
    handle(host, "api", &payload.to_string()).map(|s| serde_json::from_str(&s).unwrap())
}

#[test]
fn export_creates_once_then_reports_unchanged_or_conflict() {
    let vault = Vault::default();
    let first = api(&vault, "exportPrivateNote", 1, "hello").unwrap();
    assert_eq!(first["status"], "written");
    assert_eq!(first["destination"], "private-vault");
    assert_eq!(first["audience"], "owner");
    assert_eq!(
        first["noteReference"],
        "notes/generated/0f8fad5b-d9cb-469f-a165-70867728950e/v1.md"
    );
    assert_eq!(
        first["contentHash"],
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    assert_eq!(api(&vault, "exportPrivateNote", 1, "hello").unwrap()["status"], "unchanged");
    assert_eq!(api(&vault, "exportPrivateNote", 1, "other").unwrap()["status"], "conflict");
    assert_eq!(
        vault.files.borrow()["0f8fad5b-d9cb-469f-a165-70867728950e/v1.md"],
        "hello",
        "a conflicting retry never overwrites"
    );
}

#[test]
fn inspect_never_writes() {
    let vault = Vault::default();
    assert_eq!(api(&vault, "inspectPrivateNote", 2, "x").unwrap()["status"], "missing");
    assert!(vault.files.borrow().is_empty());
    api(&vault, "exportPrivateNote", 2, "x").unwrap();
    assert_eq!(api(&vault, "inspectPrivateNote", 2, "x").unwrap()["status"], "unchanged");
    assert_eq!(api(&vault, "inspectPrivateNote", 2, "y").unwrap()["status"], "conflict");
}

#[test]
fn identity_is_validated_before_any_host_call() {
    let vault = Vault::default();
    for (id, version) in [("not-a-uuid", 1u64), (ID, 0), (ID, 2_147_483_648)] {
        let payload = json!({"name":"exportPrivateNote","parameters":{"sourceId":id,"version":version,"content":"x"}});
        assert!(handle(&vault, "api", &payload.to_string()).is_err());
    }
    let traversal = json!({"name":"exportPrivateNote","parameters":{"sourceId":"../../etc/passwd","version":1,"content":"x"}});
    assert!(handle(&vault, "api", &traversal.to_string()).is_err());
    let forged = json!({"name":"exportPrivateNote","parameters":{"sourceId":ID,"version":1,"content":"x","path":"../x"}});
    assert!(handle(&vault, "api", &forged.to_string()).is_err());
    assert!(vault.calls.borrow().is_empty());
}
