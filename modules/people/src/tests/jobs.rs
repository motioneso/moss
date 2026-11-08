use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Ports {
    records: RefCell<BTreeMap<(String, String), Value>>,
    jobs: RefCell<BTreeMap<(String, String), Value>>,
    now: RefCell<String>,
    fail_enqueue: RefCell<bool>,
}
impl Host for Ports {
    fn call(&self, port: &str, op: &str, resource: &str, p: Value) -> Result<Value> {
        match (port, op) {
            ("context", "read") => Ok(json!({"now":*self.now.borrow()})),
            ("kv", "records.get") => Ok(self
                .records
                .borrow()
                .get(&(resource.into(), p["id"].as_str().unwrap().into()))
                .cloned()
                .unwrap_or(Value::Null)),
            ("kv", "records.put") => {
                let mut records = self.records.borrow_mut();
                let key = (resource.into(), p["id"].as_str().unwrap().into());
                let created = !records.contains_key(&key);
                let value = records.entry(key).or_insert(p["value"].clone());
                Ok(json!({"created":created,"value":value}))
            }
            ("jobs", "enqueue-options") => {
                if self.fail_enqueue.replace(false) {
                    return Err(Error::new("Queue unavailable"));
                }
                let mut jobs = self.jobs.borrow_mut();
                let key = (
                    resource.into(),
                    p["idempotencyKey"].as_str().unwrap().into(),
                );
                let created = !jobs.contains_key(&key);
                jobs.entry(key).or_insert(p);
                Ok(json!({"id":if created {json!("queued")}else{Value::Null}}))
            }
            _ => Err(Error::new("Unexpected host request")),
        }
    }
}
fn api(host: &Ports, name: &str, parameters: Value) -> Result<Value> {
    Ok(serde_json::from_str(&moss_people::guest::handle(
        host,
        "api",
        &json!({"name":name,"parameters":parameters}).to_string(),
    )?)?)
}
fn request(id: &str) -> Value {
    json!({"commandId":id,"source":"email","sourceRefHash":"sha256:raw/non-uuid/🪴","sourceVersion":"opaque:version/v2","reason":"manual_refresh"})
}

#[test]
fn enqueue_retries_keep_opaque_versions_and_time_without_suppressing_later_cycles() {
    let host = Ports::default();
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    let id = "10000000-0000-4000-8000-000000000001";
    // A queue failure leaves a durable reference that can be retried unchanged.
    *host.fail_enqueue.borrow_mut() = true;
    assert!(api(&host, "enqueueIndex", request(id)).is_err());
    assert_eq!(host.records.borrow().len(), 1);
    *host.now.borrow_mut() = "2026-11-08T12:01:00.000Z".into();
    api(&host, "enqueueIndex", request(id)).unwrap();
    api(&host, "enqueueIndex", request(id)).unwrap();
    assert_eq!(host.jobs.borrow().len(), 1);
    let jobs = host.jobs.borrow();
    let entry = &jobs[&("person-index".into(), id.into())];
    assert_eq!(entry["availableAt"], "2026-11-08T12:15:00.000Z");
    assert_eq!(entry["params"], json!({"command-id":id}));
    assert!(!entry.to_string().contains("opaque"));
    drop(jobs);
    let stored = host.records.borrow();
    assert_eq!(
        stored.values().next().unwrap()["command"]["sourceVersion"],
        "opaque:version/v2"
    );
    drop(stored);
    let mut changed = request(id);
    changed["sourceVersion"] = json!("another-version");
    assert!(
        api(&host, "enqueueIndex", changed).is_err(),
        "An immutable reference cannot change its command"
    );
    api(
        &host,
        "enqueueIndex",
        request("10000000-0000-4000-8000-000000000002"),
    )
    .unwrap();
    assert_eq!(
        host.jobs.borrow().len(),
        2,
        "A later cycle needs an independent deduplication key"
    );
}

#[test]
fn index_batches_cap_at_fifty_and_memory_sync_remains_a_stub() {
    let host = Ports::default();
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    let commands: Vec<_> = (0..55)
        .map(|n| request(&format!("10000000-0000-4000-8000-{n:012}")))
        .collect();
    assert_eq!(
        api(&host, "enqueueIndexBatch", json!({"commands":commands})).unwrap(),
        json!({"enqueued":50})
    );
    assert_eq!(host.jobs.borrow().len(), 50);
    let id = "20000000-0000-4000-8000-000000000001";
    api(&host,"enqueueMemorySync",json!({"commandId":id,"personId":"20000000-0000-4000-8000-000000000002","personUpdatedAt":"2026-11-08T12:00:00.000Z","reason":"index_complete"})).unwrap();
    assert_eq!(
        moss_people::guest::handle(
            &host,
            "job",
            &json!({"queue":"sync-person-memory","parameters":{"command-id":id}}).to_string()
        )
        .unwrap(),
        "{}"
    );
    assert!(
        moss_people::guest::handle(
            &host,
            "job",
            &json!({"queue":"person-index","parameters":{"command-id":id}}).to_string()
        )
        .is_err(),
        "A memory command cannot be executed as indexing"
    );
}
