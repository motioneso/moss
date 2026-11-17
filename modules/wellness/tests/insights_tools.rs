mod common;
use common::{Fake, A};
use moss_wellness_module::handle;
use serde_json::{json, Value};

const MARK: &str = "PLANTED-MARKER-9c3b58";

fn seed(f: &Fake, id: u32, at: &str, core: &str, intensity: Value, note: Value) {
    f.tables.borrow_mut().entry("app.wellness_checkins".into()).or_default().push(json!({
        "id": format!("00000000-0000-4000-8000-0000000c{id:04}"), "owner_user_id": A,
        "checked_in_at": at, "created_at": at, "feeling_core": core, "feeling_secondary": null,
        "feeling_tertiary": null, "wheel_version": "v2", "sensations": [], "intensity": intensity,
        "energy": null, "note": note, "identified_via": "wheel", "local_date": at[..10], "timezone_offset": 0,
    }));
}

fn tool(f: &Fake, name: &str, parameters: Value) -> Result<Value, String> {
    handle(f, "tool", &json!({"tool": name, "parameters": parameters}).to_string())
        .map(|text| serde_json::from_str(&text).unwrap())
        .map_err(|e| e.to_string())
}

#[test]
fn with_consent_off_both_tools_return_the_refusal_and_read_nothing() {
    let f = Fake::new();
    seed(&f, 1, "2026-11-10T10:00:00.000Z", "sad", json!(4), json!(MARK));
    f.route("PUT", "/wellness/ai-consent", &[], json!({"granted": false}));
    f.calls.borrow_mut().clear();
    for name in ["wellness.recentCheckIns", "wellness.medicationAdherence"] {
        let out = tool(&f, name, json!({})).unwrap();
        assert_eq!(out, json!({"data": {"error": "Consent not granted", "code": "WELLNESS_CONSENT_REQUIRED"}}));
        assert!(!out.to_string().contains(MARK));
    }
    assert!(f.calls.borrow().iter().all(|(port, ..)| port != "db"), "a refused call read a row");
}

#[test]
fn with_consent_on_recent_check_ins_come_newest_first_with_a_mood_index() {
    let f = Fake::new();
    seed(&f, 1, "2026-11-09T10:00:00.000Z", "happy", json!(5), json!("older"));
    seed(&f, 2, "2026-11-10T10:00:00.000Z", "sad", json!(3), Value::Null);
    let out = tool(&f, "wellness.recentCheckIns", json!({})).unwrap();
    let items = out["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["feelingCore"], "sad");
    assert_eq!(items[0]["moodIndex"], -3.0);
    assert_eq!(items[1]["moodIndex"], 5.0);
    assert_eq!(out["columnOrder"], json!(["checkedInAt", "feelingCore", "feelingSecondary", "intensity", "moodIndex", "note"]));
    assert!(items[0].get("id").is_none());
}

#[test]
fn medication_adherence_holds_numbers_and_no_medicine_text() {
    let f = Fake::new();
    f.route("POST", "/wellness/medications", &[], json!({"name": MARK, "dosage": MARK, "frequencyType": "once_daily", "timesPerDay": 1, "scheduleTimes": ["08:00"]}));
    let out = tool(&f, "wellness.medicationAdherence", json!({})).unwrap();
    assert_eq!(out["data"]["windowDays"], 7);
    assert!(!out.to_string().contains(MARK));
}

#[test]
fn bad_input_is_refused_before_anything_is_read() {
    let f = Fake::new();
    for (name, input) in [("wellness.recentCheckIns", json!({"limit": 5})), ("wellness.other", json!({})), ("wellness.recentCheckIns", json!(null))] {
        let out = tool(&f, name, input).unwrap();
        assert_eq!(out, json!({"data": {"error": "Invalid Wellness tool input"}}));
    }
    assert!(f.calls.borrow().is_empty());
}

#[test]
fn a_host_failure_never_echoes_private_text() {
    let f = Fake::new();
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    let err = tool(&f, "wellness.recentCheckIns", json!({})).unwrap_err();
    assert_eq!(err, "Wellness tool failed");
}

#[test]
fn the_signed_in_route_refuses_bad_requests_and_hides_host_errors() {
    let f = Fake::new();
    let (status, _) = f.route("POST", "/wellness/tools/run", &[], json!({"tool": "wellness.recentCheckIns", "parameters": {"x": MARK}}));
    assert_eq!(status, 400);
    let (status, body) = f.route("POST", "/wellness/tools/run", &[], json!({"tool": "wellness.recentCheckIns", "parameters": {}, "approved": true}));
    assert_eq!(status, 400);
    assert!(!body.to_string().contains("approved"));
    // The test host has no tools port, so this stands in for a denied approval.
    let (status, body) = f.route("POST", "/wellness/tools/run", &[], json!({"tool": "wellness.recentCheckIns", "parameters": {}}));
    assert_eq!(status, 403);
    assert_eq!(body["error"], "Wellness tool unavailable or approval required");
}

#[test]
fn insights_need_seven_check_ins_and_a_week_of_history() {
    let f = Fake::new();
    for n in 0..6 {
        seed(&f, n, &format!("2026-10-{:02}T10:00:00.000Z", 20 + n), "happy", json!(3), Value::Null);
    }
    assert_eq!(f.route("GET", "/wellness/insights", &[], Value::Null).1, json!({"insights": []}));
    seed(&f, 6, "2026-11-10T10:00:00.000Z", "happy", json!(3), Value::Null);
    let (_, body) = f.route("GET", "/wellness/insights", &[], Value::Null);
    let keys: Vec<&str> = body["insights"].as_array().unwrap().iter().map(|l| l["key"].as_str().unwrap()).collect();
    assert_eq!(keys.first(), Some(&"common"));
    assert_eq!(keys.last(), Some(&"adherence"));
    assert_eq!(body["insights"][0]["lead"], "Happy");
    assert_eq!(body["insights"][0]["rest"], " was your most-logged feeling this month \u{2014} 7 of 7 check-ins.");
    // Too young: the first check-in is under a week old.
    let g = Fake::new();
    for n in 0..7 {
        seed(&g, n, &format!("2026-11-{:02}T10:00:00.000Z", 6 + n.min(4)), "sad", json!(3), json!("n"));
    }
    assert_eq!(g.route("GET", "/wellness/insights", &[], Value::Null).1, json!({"insights": []}));
}

#[test]
fn insights_name_the_hardest_day_and_count_notes() {
    let f = Fake::new();
    // 2026-10-19 is a Monday. Three sad Mondays and four calm days spread elsewhere.
    for (n, day) in ["2026-10-19", "2026-10-26", "2026-11-02"].iter().enumerate() {
        seed(&f, n as u32, &format!("{day}T10:00:00.000Z"), "sad", json!(3), json!(MARK));
    }
    for (n, day) in ["2026-10-20", "2026-10-22", "2026-10-24", "2026-10-30"].iter().enumerate() {
        seed(&f, 10 + n as u32, &format!("{day}T10:00:00.000Z"), "happy", json!(3), Value::Null);
    }
    let (_, body) = f.route("GET", "/wellness/insights", &[], Value::Null);
    let lines = body["insights"].as_array().unwrap();
    let hardest = lines.iter().find(|l| l["key"] == "hardest").unwrap();
    assert_eq!(hardest["lead"], "Mondays");
    assert_eq!(hardest["rest"], " tend to be hardest \u{2014} 100% of them landed in off-track states. Worth a gentler plan.");
    let notes = lines.iter().find(|l| l["key"] == "notes").unwrap();
    assert_eq!(notes["lead"], "3 sad or angry check-ins");
    assert!(!body.to_string().contains(MARK), "no note text in insight lines");
}
