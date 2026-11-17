mod common;
use common::Fake;
use serde_json::{json, Value};

const MARK: &str = "PLANTED-MARKER-7d2e41";

#[test]
fn check_in_text_reaches_no_host_call_beyond_the_check_in_table() {
    let f = Fake::new();
    let (_, made) = f.route("POST", "/wellness/checkins", &[], json!({"feelingCore":"happy","note":MARK,"sensations":[MARK]}));
    let id = made["checkin"]["id"].as_str().unwrap().to_owned();
    f.route("PATCH", "/wellness/checkins/:id", &[("id", &id)], json!({"feelingCore":"happy","note":MARK}));
    f.route("GET", "/wellness/checkins", &[], Value::Null);
    // Every host call is a query on the check-in table, a date read or a saved-choice read. The
    // package has no job, log, model, memory or network call at all.
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "context", "kv"].contains(&port.as_str()), "unexpected port {port}");
        if port == "db" {
            assert_eq!(resource, "app.wellness_checkins");
        } else {
            assert!(!parameters.to_string().contains(MARK), "{port} call carried check-in text");
        }
    }
    // A host failure must not echo the marker back.
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    let (status, body) = f.route("GET", "/wellness/checkins", &[], Value::Null);
    assert_eq!(status, 500);
    assert!(!body.to_string().contains(MARK), "{body}");
}

#[test]
fn medication_text_reaches_no_host_call_beyond_the_two_medication_tables() {
    let f = Fake::new();
    let (_, made) = f.route("POST", "/wellness/medications", &[], json!({"name":MARK,"dosage":MARK,"notes":MARK,"frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}));
    let id = made["medication"]["id"].as_str().unwrap().to_owned();
    f.route("PATCH", "/wellness/medications/:id", &[("id", &id)], json!({"notes":MARK}));
    f.route("POST", "/wellness/medications/:id/logs", &[("id", &id)], json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z","dose":MARK}));
    f.route("POST", "/wellness/medications/:id/logs", &[("id", &id)], json!({"status":"prn","prnReason":MARK}));
    f.route("GET", "/wellness/medications", &[], Value::Null);
    f.route_query("GET", "/wellness/medications/schedule", &[], &[("date", "2026-11-11")], Value::Null);
    f.route("GET", "/wellness/medications/logs", &[], Value::Null);
    moss_wellness_module::handle(&f, "api", r#"{"name":"medicationAdherence","parameters":{}}"#).unwrap();
    // Only database calls carry medication text, and only to the two medication tables. Every
    // other call (date, saved choice) carries none. There is no job, log, model or network call.
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        assert!(["db", "context", "kv"].contains(&port.as_str()), "unexpected port {port}");
        if port == "db" {
            assert!(["app.medications", "app.medication_logs"].contains(&resource.as_str()), "{resource}");
        } else {
            assert!(!parameters.to_string().contains(MARK), "{port} call carried medication text");
        }
    }
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    for path in ["/wellness/medications", "/wellness/medications/logs"] {
        let (status, body) = f.route("GET", path, &[], Value::Null);
        assert_eq!(status, 500);
        assert!(!body.to_string().contains(MARK), "{body}");
    }
}

#[test]
fn the_manifest_declares_no_model_port() {
    let manifest: Value = serde_json::from_str(include_str!("../moss.module.json")).unwrap();
    let ports: Vec<&str> = manifest["capabilities"].as_array().unwrap().iter().map(|c| c["port"].as_str().unwrap()).collect();
    assert_eq!(ports, ["db", "context", "kv"]);
    for banned in ["ai", "model", "fetch", "network", "jobs", "memory", "tools"] {
        assert!(!ports.contains(&banned), "{banned}");
    }
    assert!(!include_str!("../moss.module.json").contains("\"ai\""));
    // The reminder queue is declared with no parameters, so a job payload can hold nothing private.
    assert_eq!(manifest["jobs"], json!({"wellness-medication-reminder": {}}));
}
