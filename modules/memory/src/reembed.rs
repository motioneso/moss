//! Owner-started re-embed. The routes start, watch and cancel a run, and one job per step asks
//! the host to embed a small batch. The host keeps old vectors until the run is complete and then
//! swaps them in at once. Jobs carry only the run id, never passage text or a vector.
use crate::vault_index::{enqueue_now, new_id};
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const STEP: &str = "memory.reembed-step";

fn answer(value: Value) -> Result<Value> {
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory search is unavailable"),
        ));
    }
    Ok(value)
}

fn uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// The search model, how many passages use another one, how many facts have no vector, and the
/// latest run.
pub fn status_route(host: &impl Host) -> Result<Value> {
    answer(kv(host, "get", "memory.reembed", json!({}))?)
}

pub fn start_route(host: &impl Host) -> Result<Value> {
    let run = answer(kv(host, "set", "memory.reembed", json!({"action": "start"}))?)?;
    let id = run["id"].as_str().filter(|id| uuid_like(id)).ok_or_else(|| Error::new(500, "Internal server error"))?;
    enqueue_now(host, STEP, json!({"run-id": id}), &new_id(host)?)?;
    Ok(run)
}

pub fn cancel_route(host: &impl Host) -> Result<Value> {
    answer(kv(host, "set", "memory.reembed", json!({"action": "cancel"}))?)
}

/// One step. A run that is still going queues the next step, so a restart resumes from the
/// staged rows already saved.
pub fn handle_job(host: &impl Host, parameters: &Value) -> std::result::Result<String, String> {
    let run = parameters["run-id"].as_str().filter(|id| uuid_like(id)).ok_or("Memory re-embed is unavailable")?;
    let result = kv(host, "set", "memory.reembed", json!({"action": "step", "runId": run}))
        .map_err(|e| e.message)
        .and_then(|v| answer(v).map_err(|e| e.message))?;
    if result["status"] == "running" {
        let key = new_id(host).map_err(|_| "Memory re-embed is unavailable")?;
        enqueue_now(host, STEP, json!({"run-id": run}), &key).map_err(|_| "Memory re-embed is unavailable")?;
    }
    Ok(json!({
        "status": result["status"],
        "staged": result["staged"],
        "total": result["total"],
    })
    .to_string())
}

/// Gives facts that were saved without a vector another try, and restarts the step chain of a
/// run whose job ran out of retries. The key holds the staged count, so a healthy chain is not
/// doubled. Failures are not reported.
pub fn retry_missing(host: &impl Host) {
    let _ = kv(host, "set", "memory.reembed", json!({"action": "retry-missing"}));
    let Ok(status) = status_route(host) else { return };
    let run = &status["run"];
    if let (Some(id), Some("running")) = (run["id"].as_str().filter(|id| uuid_like(id)), run["status"].as_str()) {
        let key = format!("memory.reembed-kick-{id}-{}", run["staged"]);
        let _ = enqueue_now(host, STEP, json!({"run-id": id}), &key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const RUN: &str = "11111111-2222-3333-4444-555555555555";

    struct Fake {
        step: Value,
        calls: RefCell<Vec<(String, String, Value)>>,
    }
    impl Host for Fake {
        fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> std::result::Result<Value, moss_module_sdk::Error> {
            self.calls.borrow_mut().push((port.into(), resource.into(), params.clone()));
            Ok(match (port, op) {
                ("context", "read") => json!({"now":"2026-11-11T10:00:00.000Z"}),
                ("context", "uuid") => json!({"id": RUN}),
                ("kv", _) if params["action"] == "start" && self.step.get("refused").is_none() => json!({"id": RUN, "status": "running"}),
                ("kv", _) => self.step.clone(),
                _ => json!({"id": RUN}),
            })
        }
    }
    fn fake(step: Value) -> Fake {
        Fake { step, calls: RefCell::default() }
    }
    fn queued(f: &Fake) -> Vec<Value> {
        f.calls.borrow().iter().filter(|c| c.0 == "jobs").map(|c| c.2.clone()).collect()
    }

    #[test]
    fn a_running_step_queues_the_next_with_only_the_run_id() {
        let f = fake(json!({"status":"running","staged":16,"total":20}));
        handle_job(&f, &json!({"run-id": RUN})).unwrap();
        let jobs = queued(&f);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["params"], json!({"run-id": RUN}));
    }

    #[test]
    fn a_finished_or_stopped_step_queues_nothing() {
        for status in ["done", "stopped", "failed"] {
            let f = fake(json!({"status": status}));
            handle_job(&f, &json!({"run-id": RUN})).unwrap();
            assert!(queued(&f).is_empty(), "{status}");
        }
    }

    #[test]
    fn a_bad_run_id_is_refused_before_any_call() {
        let f = fake(json!({}));
        assert!(handle_job(&f, &json!({"run-id": "nope"})).is_err());
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn a_refused_start_passes_the_status_through_and_queues_nothing() {
        let f = fake(json!({"refused": {"status": 409, "message": "A re-embed is already running"}}));
        let error = start_route(&f).unwrap_err();
        assert_eq!(error.status, 409);
        assert!(queued(&f).is_empty());
    }

    #[test]
    fn a_start_queues_the_first_step() {
        let f = fake(json!({}));
        assert_eq!(start_route(&f).unwrap()["id"], RUN);
        assert_eq!(queued(&f).len(), 1);
    }
}
