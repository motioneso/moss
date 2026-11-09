use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
};

#[derive(Default)]
struct Ports {
    records: RefCell<BTreeMap<(String, String), Value>>,
    jobs: RefCell<BTreeMap<(String, String), Value>>,
    now: RefCell<String>,
    clock_reads: Cell<usize>,
    fail_enqueue: RefCell<bool>,
    next_id: Cell<u64>,
    fail_after: Cell<Option<usize>>,
}
impl Host for Ports {
    fn call(&self, port: &str, op: &str, resource: &str, p: Value) -> Result<Value> {
        match (port, op) {
            ("context", "uuid") => {
                let id = self.next_id.get() + 1;
                self.next_id.set(id);
                Ok(json!({"id":format!("30000000-0000-4000-8000-{id:012}")}))
            }
            ("context", "read") => {
                self.clock_reads.set(self.clock_reads.get() + 1);
                Ok(json!({"now":*self.now.borrow()}))
            }
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
                if self.fail_enqueue.replace(false)
                    || self.fail_after.get() == Some(self.jobs.borrow().len())
                {
                    self.fail_after.set(None);
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

fn refresh(host: &Ports, body: Value) -> Value {
    serde_json::from_str(
        &moss_people::guest::handle(
            host,
            "route",
            &json!({
                "method":"POST", "path":"/people/index/refresh", "body":body
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn manual_refresh_accepts_fifty_delays_each_job_and_allows_later_requests() {
    let host = Ports::default();
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    let source = json!({"source":"email","sourceRefHash":"opaque/hash/🪴","sourceVersion":"v1","reason":"manual_refresh"});
    let body = json!({"sourceRefs":vec![source.clone();50]});
    assert_eq!(
        refresh(&host, body),
        json!({"status":202,"body":{"enqueued":50}})
    );
    assert_eq!(host.jobs.borrow().len(), 50);
    assert_eq!(
        host.clock_reads.get(),
        1,
        "A batch reads the host clock once"
    );
    for job in host.jobs.borrow().values() {
        assert_eq!(job["availableAt"], "2026-11-08T12:15:00.000Z");
        assert_eq!(job["params"].as_object().unwrap().len(), 1);
    }
    *host.now.borrow_mut() = "2026-11-08T12:01:00.000Z".into();
    assert_eq!(
        refresh(&host, json!({"sourceRefs":[source]}))["status"],
        202
    );
    assert_eq!(host.jobs.borrow().len(), 51);
    assert_eq!(
        host.clock_reads.get(),
        2,
        "A later request gets a fresh time"
    );
    assert_eq!(
        refresh(&host, json!({"sourceRefs":[]})),
        json!({"status":202,"body":{"enqueued":0}})
    );
    assert_eq!(host.clock_reads.get(), 2, "Empty refreshes need no clock");
}

#[test]
fn invalid_refreshes_publish_nothing_and_queue_failures_return_safe_errors() {
    let host = Ports::default();
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    let source = json!({"source":"email","sourceRefHash":"opaque","reason":"refresh"});
    for body in [
        json!({}),
        json!({"sourceRefs":vec![source.clone();51]}),
        json!({"sourceRefs":[{}]}),
        json!({"sourceRefs":{}}),
    ] {
        assert_eq!(refresh(&host, body)["status"], 400);
        assert!(host.records.borrow().is_empty());
        assert!(host.jobs.borrow().is_empty());
    }
    *host.now.borrow_mut() = "invalid host time".into();
    assert_eq!(
        refresh(&host, json!({"sourceRefs":[source.clone()]}))["status"],
        500
    );
    assert!(host.records.borrow().is_empty());
    assert!(host.jobs.borrow().is_empty());
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    *host.fail_enqueue.borrow_mut() = true;
    assert_eq!(
        refresh(&host, json!({"sourceRefs":[source]})),
        json!({"status":500,"body":{"error":"Internal Server Error"}})
    );
    assert!(host.jobs.borrow().is_empty());
}

#[test]
fn manual_refresh_keeps_earlier_sends_when_a_later_send_fails() {
    let host = Ports::default();
    *host.now.borrow_mut() = "2026-11-08T12:00:00.000Z".into();
    host.fail_after.set(Some(1));
    let source = json!({"source":"email","sourceRefHash":"opaque","reason":"refresh"});
    assert_eq!(
        refresh(&host, json!({"sourceRefs":[source.clone(), source]})),
        json!({"status":500,"body":{"error":"Internal Server Error"}})
    );
    assert_eq!(host.jobs.borrow().len(), 1);
    assert_eq!(host.records.borrow().len(), 2);
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
    assert_eq!(
        api(&host, "enqueueIndexBatch", json!({"commands":[]})).unwrap(),
        json!({"enqueued":0})
    );
    assert_eq!(host.clock_reads.get(), 0);
    let commands: Vec<_> = (0..55)
        .map(|n| request(&format!("10000000-0000-4000-8000-{n:012}")))
        .collect();
    assert_eq!(
        api(&host, "enqueueIndexBatch", json!({"commands":commands})).unwrap(),
        json!({"enqueued":50})
    );
    assert_eq!(host.jobs.borrow().len(), 50);
    assert_eq!(
        host.clock_reads.get(),
        1,
        "A batch reads the host clock once"
    );
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
